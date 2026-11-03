#!/usr/bin/env node
/**
 * GitHub Actions 用：把「昨天一整天」的 PR／issue 全量匯出成 JSON。
 *
 * 為什麼要有這支：本機 cron 抓 GitHub 會吃 60/hr（未認證）或 5000/hr（個人 token）額度，
 * 額度一撞就退快取、數字就不對。搬到 Actions 之後：
 *   - 用 GitHub 自己發的 GITHUB_TOKEN（GraphQL 1,000 點/hr／repo，我們一天約 30 點）
 *     若 repo 屬於 enterprise 帳號則是 15,000 點/hr
 *   - 翻頁／重試／補跑全交給 runner
 *   - 每天把 JSON commit 到 daily-feed 分支 → MyAgent 用 raw.githubusercontent.com
 *     抓（不需要 token、不佔額度），順便留下每天的歷史快照
 *
 * 用法（本機也能跑來驗證）：
 *   GITHUB_TOKEN=xxx node export.mjs vllm-project/vllm 2026-11-02
 *   → out/vllm-project__vllm/2026-11-02.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// 預設用 workflow 的 GITHUB_TOKEN；若讀公開 repo 被權限擋住，可在 repo secrets 設 GH_PAT
// （fine-grained PAT，只要 public repo read），這裡會優先採用。
const TOKEN = process.env.GH_PAT ?? process.env.GITHUB_TOKEN ?? "";
const API = "https://api.github.com";
const PAGE = 100;
const MAX_PAGES = 60;

const [, , repoArg, dateArg] = process.argv;
if (!repoArg) {
  console.error("用法：node export.mjs <owner/repo> [YYYY-MM-DD]");
  process.exit(1);
}
const [owner, name] = repoArg.split("/");

/** 目標日（台北時區）的 UTC 邊界 */
const taipei = (d) => new Date(d.toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
const day = dateArg ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
const [y, m, d] = day.split("-").map(Number);
// 台北 00:00 = 前一日 UTC 16:00
const from = new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - 8 * 3600 * 1000);
const to = new Date(from.getTime() + 24 * 3600 * 1000);
const iso = (x) => x.toISOString().replace(/\.\d+Z$/, "Z");

async function gql(query, variables = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${API}/graphql`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "gh-actions-export",
      },
      body: JSON.stringify({ query, variables }),
    });
    if (res.ok) {
      const j = await res.json();
      if (j.errors?.length) throw new Error(JSON.stringify(j.errors).slice(0, 300));
      return j.data;
    }
    if (res.status === 403 || res.status === 429) {
      const wait = Number(res.headers.get("retry-after") ?? 10);
      console.error(`  額度／限流 ${res.status}，等 ${wait}s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    throw new Error(`GraphQL HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  throw new Error("GraphQL 重試用盡");
}

const Q_PULLS = `
query($owner:String!,$name:String!,$after:String,$states:[PullRequestState!]){
  repository(owner:$owner,name:$name){
    pullRequests(first:100,after:$after,states:$states,
                 orderBy:{field:UPDATED_AT,direction:DESC}){
      pageInfo{hasNextPage endCursor}
      nodes{ number title url createdAt updatedAt mergedAt closedAt state
             author{login} labels(first:20){nodes{name}} }
    }
  }}`;

const Q_PULLS_CREATED = `
query($owner:String!,$name:String!,$after:String){
  repository(owner:$owner,name:$name){
    pullRequests(first:100,after:$after,states:[OPEN,MERGED,CLOSED],
                 orderBy:{field:CREATED_AT,direction:DESC}){
      pageInfo{hasNextPage endCursor}
      nodes{ number title url createdAt updatedAt mergedAt closedAt state
             author{login} labels(first:20){nodes{name}} }
    }
  }}`;

const Q_ISSUES = `
query($owner:String!,$name:String!,$after:String,$since:DateTime){
  repository(owner:$owner,name:$name){
    issues(first:100,after:$after,states:[CLOSED],filterBy:{since:$since},
           orderBy:{field:UPDATED_AT,direction:DESC}){
      pageInfo{hasNextPage endCursor}
      nodes{ number title url createdAt updatedAt closedAt
             author{login} labels(first:20){nodes{name}}
             closedByPullRequestsReferences(first:5){nodes{number}} }
    }
  }}`;

/** 連線分頁，直到整頁都早於 from（排序是 desc，可直接停） */
async function collect(query, connPath, extra = {}) {
  const nodes = [];
  let after = null;
  let pages = 0;
  let stop = "pageInfo";
  const connOf = (data) => connPath.split(".").reduce((o, k) => o[k], data.repository);
  const earlyField = extra.byCreated ? "createdAt" : "updatedAt";
  for (;;) {
    const data = await gql(query, { owner, name, after, since: iso(from), ...extra });
    const c = connOf(data);
    pages++;
    nodes.push(...c.nodes);
    if (c.nodes.some((n) => (n[earlyField] ?? "") < iso(from))) {
      stop = `${earlyField} 早停`;
      break;
    }
    if (!c.pageInfo.hasNextPage) {
      stop = "已到最後一頁";
      break;
    }
    if (pages >= MAX_PAGES) {
      stop = `達 MAX_PAGES=${MAX_PAGES}`;
      break;
    }
    after = c.pageInfo.endCursor;
  }
  return { nodes, pages, stop };
}

const mergedRes = await collect(Q_PULLS, "pullRequests", { states: ["MERGED"] });
const issueRes = await collect(Q_ISSUES, "issues");
// 新開的 PR 用 CREATED_AT 排序早停（用 UPDATED_AT 會把一堆老 PR 的更新也翻進來，多燒 5 倍頁數）
const allPulls = await collect(Q_PULLS_CREATED, "pullRequests", { byCreated: true });

const merged = mergedRes.nodes.filter((n) => (n.mergedAt ?? "") >= iso(from) && (n.mergedAt ?? "") < iso(to));
const closed = issueRes.nodes.filter((n) => (n.closedAt ?? "") >= iso(from) && (n.closedAt ?? "") < iso(to));
const created = allPulls.nodes.filter((n) => (n.createdAt ?? "") >= iso(from) && (n.createdAt ?? "") < iso(to));

const out = {
  repo: repoArg,
  date: day,
  window: { from: iso(from), to: iso(to), tz: "Asia/Taipei" },
  coverage: {
    merged: { pages: mergedRes.pages, stop: mergedRes.stop, in_window: merged.length },
    created: { pages: allPulls.pages, stop: allPulls.stop, in_window: created.length },
    issues: { pages: issueRes.pages, stop: issueRes.stop, in_window: closed.length },
    truncated: [mergedRes, allPulls, issueRes].some((r) => r.stop.startsWith("達 MAX_PAGES")),
  },
  merged_pulls: merged.map((n) => ({
    number: n.number,
    title: n.title,
    url: n.url,
    author: n.author?.login,
    merged_at: n.mergedAt,
    labels: (n.labels?.nodes ?? []).map((l) => l.name),
  })),
  created_pulls: created.map((n) => ({
    number: n.number,
    title: n.title,
    url: n.url,
    author: n.author?.login,
    state: n.state,
    created_at: n.createdAt,
    merged_at: n.mergedAt,
  })),
  closed_issues: closed.map((n) => ({
    number: n.number,
    title: n.title,
    url: n.url,
    closed_at: n.closedAt,
    author: n.author?.login,
    fix_prs: (n.closedByPullRequestsReferences?.nodes ?? []).map((p) => p.number),
  })),
};

const dir = join("out", repoArg.replace("/", "__"));
mkdirSync(dir, { recursive: true });
const file = join(dir, `${day}.json`);
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(
  `✓ ${repoArg} ${day}：merged ${merged.length}、created ${created.length}、issues ${closed.length} → ${file}`
);
if (out.coverage.truncated) console.error("⚠️ 有查詢達分頁上限，數字可能不完整");