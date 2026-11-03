# gh-daily-feed

每天把 [vllm-project/vllm](https://github.com/vllm-project/vllm) 與
[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) 的
PR／issue 匯出成 JSON 快照，commit 到 `daily-feed` 分支。

## 為什麼

* 快照 → MyAgent 端一行 `curl` 就能拿到資料，**不需要 token、不佔 API 額度**
* 每天一份，等於免費的歷史存檔（回補、對帳都靠它）
* 用 repo 自帶的 `GITHUB_TOKEN`（GraphQL 1,000 點/hr/repo），跟你的個人額度完全分開

## 資料在哪

```
daily-feed 分支 / out/<owner>__<repo>/<YYYY-MM-DD>.json
```

日期是 **Asia/Taipei 日界**（00:00–24:00）。每份都含 `coverage`：

```json
"coverage": {
  "merged":  { "pages": 2, "stop": "updatedAt 早停", "in_window": 52 },
  "created": { "pages": 3, "stop": "createdAt 早停", "in_window": 145 },
  "issues":  { "pages": 1, "stop": "已到最後一頁", "in_window": 9 },
  "truncated": false
}
```

`truncated` 必須是 `false`。workflow 會在它不是 `false` 時直接紅燈，不讓殘缺資料進分支。

## 排程

| 觸發 | 時間 | 匯出哪一天 |
|---|---|---|
| `schedule` | 每天 16:10 UTC（00:10 台北） | **台北昨天**（剛結束的完整一天） |
| `push` | 改了 `export.mjs` 或 workflow 時 | 台北昨天（等於自我測試） |
| `workflow_dispatch` | 手動 | 由 `date`／`days` 決定 |

## 手動補跑

Actions 分頁 → `daily-export` → **Run workflow**

| 輸入 | 說明 |
|---|---|
| `date` | 留空＝台北時區昨天。也可指定 `2026-10-28` |
| `days` | 往回補幾天，預設 1（`days: 7`＝最近一週） |

## 檔案

| 路徑 | 說明 |
|---|---|
| `.github/workflows/daily-export.yml` | 排程、完整性檢查、推分支 |
| `scripts/gh-actions/export.mjs` | 抓資料（GraphQL cursor 分頁＋早停） |

`export.mjs` 的 token 取用順序：`GH_PAT` → `GITHUB_TOKEN`。
若讀別人的公開 repo 被擋（log 出現 403），到 Settings → Secrets and variables → Actions
新增 `GH_PAT`（fine-grained，只需 *Public repositories: read-only*）即可，無需改任何檔案。

## 目前收錄

已有 `2026-10-27` 起的每日快照（兩邊各 7 天，`truncated` 全為 `false`）。
