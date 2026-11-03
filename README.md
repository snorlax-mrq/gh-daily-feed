# gh-daily-feed

每天把 [vllm-project/vllm](https://github.com/vllm-project/vllm) 與
[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) 的
PR／issue 匯出成 JSON 快照，commit 到 `daily-feed` 分支。

## 為什麼

* 快照 → MyAgent 端用一行 `curl` 就能拿到資料，**不需要 token、不佔 API 額度**
* 每天一份，等於免費的歷史存檔（回補、對帳都靠它）
* 用 repo 自帶的 `GITHUB_TOKEN`（GraphQL 1,000 點/hr/repo），跟你的個人額度完全分開

## 資料在哪

```
daily-feed 分支 / out/<owner>__<repo>/<YYYY-MM-DD>.json
```

日期是 **Asia/Taipei 日界**（00:00–24:00）。每份都含 `coverage`：

```json
"coverage": {
  "merged":  { "pages": 5, "stop": "updatedAt 早停", "in_window": 88 },
  "created": { "pages": 9, "stop": "createdAt 早停", "in_window": 199 },
  "issues":  { "pages": 2, "stop": "已到最後一頁", "in_window": 35 },
  "truncated": false
}
```

`truncated` 必須是 `false`。workflow 會在它不是 `false` 時直接紅燈，不讓殘缺資料進分支。

## 手動補跑

Actions 分頁 → `daily-export` → **Run workflow**

| 輸入 | 說明 |
|---|---|
| `date` | 留空＝台北時區昨天（一定是完整的一天）。也可指定 `2026-10-28` |
| `days` | 往回補幾天，預設 1 |

## 檔案

| 路徑 | 說明 |
|---|---|
| `.github/workflows/daily-export.yml` | 排程（每天 16:10 UTC = 00:10 台北）與推送步驟 |
| `scripts/gh-actions/export.mjs` | 實際抓資料的程式（GraphQL cursor 分頁＋早停） |

## 注意

* 讀的是別人的**公開** repo，用 repo 自帶的 `GITHUB_TOKEN` 通常可以。若 log 出現 `403`，
  到 Settings → Secrets and variables → Actions 加一個 `GH_PAT`（fine-grained，只需
  *Public repositories: read-only*），程式會優先採用它。
* 公開庫的排程 workflow 若 60 天沒有任何 repo 活動會被自動停用；這裡每天都會 commit，踩不到。
