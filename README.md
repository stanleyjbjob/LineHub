# LineHub — LINE 官方帳號群組訊息收集 PoC

把 LINE 官方帳號（LINE@）邀請進群組後，透過 **LINE Messaging API Webhook** 接收群組內**所有成員的訊息**，
保存到資料庫，並提供後台介面、查詢 API 與可擴充的「後續應用」管線（關鍵字警示、轉送到外部系統…）。

```
 LINE 群組 / 多人聊天 / 一對一
          │  (成員發言)
          ▼
   LINE Platform ──Webhook(POST /webhook, 簽章)──▶ LineHub
                                                   ├─ 驗證 x-line-signature、先回 200
                                                   ├─ events 原始事件（webhookEventId 去重）
                                                   ├─ messages / sources / users / memberships（SQLite）
                                                   ├─ 補齊群組名稱、成員暱稱、下載圖片/影片/檔案
                                                   ├─ Processors：關鍵字警示 → 轉送 Webhook → Bot 指令
                                                   └─ 後台 UI + REST API + SSE 即時串流
```

- **相依套件極少**：除了 AI 摘要使用的官方 `@anthropic-ai/sdk`，其餘只用 Node.js 22 內建模組（`http`、`crypto`、`node:sqlite`、`fetch`）。
- **AI 每日群組摘要**：每天自動用 Claude 整理各群組前一天的對話（主題、決議、待辦、待回覆問題），可選擇推播回群組。
- 支援事件：文字、貼圖、圖片、影片、語音、檔案、位置、**收回訊息**、Bot 加入/離開群組、成員加入/離開、加好友/封鎖。

## 重要限制（請先了解）

| 項目 | 說明 |
| --- | --- |
| 只能收到「Bot 在群組後」的訊息 | LINE 不提供歷史訊息 API；Bot 加入前的對話拿不到。 |
| 必須是 Messaging API 的 Bot | 一般 LINE 個人帳號無法串接；官方帳號需啟用 Messaging API。 |
| 群組需允許 Bot 加入 | LINE Official Account Manager →「允許加入群組或多人聊天室」需開啟。 |
| 成員暱稱 | 透過 *group member profile* API 取得，不需要成員加 Bot 好友。 |
| 多媒體內容有保存期限 | LINE 伺服器只保留一段時間，因此預設收到即下載（`DOWNLOAD_MEDIA=true`）。 |
| 隱私與告知 | 群組內所有成員的訊息都會被記錄，正式使用前請告知成員並符合個資法規範。 |

## 快速開始

### 1. 建立 LINE Messaging API Channel
1. 到 [LINE Developers Console](https://developers.line.biz/console/) 建立 Provider → **Messaging API channel**（或在 LINE Official Account Manager 的「設定 → Messaging API」為既有官方帳號啟用）。
2. **Basic settings** 取得 `Channel secret`。
3. **Messaging API** 分頁發行 `Channel access token (long-lived)`。
4. 在 [LINE Official Account Manager](https://manager.line.biz/) → 設定 → 帳號設定：
   - **允許加入群組或多人聊天室**：開啟
   - 回應設定：**Webhook 開啟**，**自動回應訊息關閉**、**加入好友的歡迎訊息**可視需要關閉（避免 Bot 在群組裡亂說話）

### 2. 啟動 LineHub
```bash
cp .env.example .env      # 填入 LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN（摘要另需 ANTHROPIC_API_KEY）
npm install
npm start                 # http://localhost:3000
```
或使用 Docker：
```bash
docker build -t linehub .
docker run -p 3000:3000 --env-file .env -v $(pwd)/data:/data linehub
```

### 3. 對外公開 Webhook（開發時用 ngrok / cloudflared）
```bash
ngrok http 3000
# 或 cloudflared tunnel --url http://localhost:3000
```
到 LINE Developers Console → Messaging API → **Webhook URL** 填入 `https://<公開網址>/webhook`，
按 **Verify** 應顯示 Success，並開啟 **Use webhook**。

### 4. 把官方帳號邀進群組
在 LINE 群組中「邀請」→ 搜尋官方帳號加入。之後群組內任何人發言，都會即時出現在 `http://localhost:3000` 後台。

### 不用 LINE 帳號先在本機試玩
```bash
echo "LINE_CHANNEL_SECRET=demo" > .env
npm install && npm start
# 另一個終端機
npm run simulate -- --type join
npm run simulate -- 請問這個月的報價？
npm run simulate -- --user Uother --type sticker
npm run simulate -- --type unsend <messageId>
```
`scripts/simulate.js` 會用 Channel secret 產生正確簽章，模擬 LINE 平台呼叫 Webhook。

## 設定（.env）

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `LINE_CHANNEL_SECRET` | （必填） | 用來驗證 Webhook 簽章 |
| `LINE_CHANNEL_ACCESS_TOKEN` | | 用來取得群組名稱、成員暱稱、多媒體；未填仍可保存訊息 |
| `PORT` | `3000` | |
| `DB_PATH` | `./data/linehub.db` | SQLite 檔案 |
| `MEDIA_DIR` | `./data/media` | 多媒體下載目錄（`<sourceId>/<messageId>.<ext>`） |
| `DOWNLOAD_MEDIA` | `true` | 是否自動下載圖片/影片/語音/檔案 |
| `ADMIN_TOKEN` | | 後台與 `/api`、`/media` 的存取權杖；**部署到公開網路務必設定** |
| `ALERT_KEYWORDS` | | 逗號分隔的警示關鍵字 |
| `FORWARD_WEBHOOK_URL` | | 每則訊息以 JSON POST 到此網址（n8n、Zapier、CRM、AI 服務…） |
| `ENABLE_BOT_COMMANDS` | `false` | 開啟後群組輸入 `/hub` 會由 Bot 回覆（示範 reply API） |
| `ANTHROPIC_API_KEY` | | Claude API 金鑰；設定後啟用 AI 每日摘要 |
| `SUMMARY_TIME` | `08:00` | 每天執行時間（摘要「前一天」的對話） |
| `SUMMARY_TZ` | `Asia/Taipei` | 用來切分「一天」的時區 |
| `SUMMARY_MIN_MESSAGES` | `5` | 當天訊息少於此數的群組不做摘要 |
| `SUMMARY_MODEL` | `claude-opus-5-5` | 使用的 Claude 模型 |
| `SUMMARY_EFFORT` | `medium` | `low` / `medium` / `high`，越高越仔細、花費越多 |
| `SUMMARY_PUSH_TO_GROUP` | `false` | 是否把摘要推播回群組 |

## AI 每日群組摘要

設定 `ANTHROPIC_API_KEY` 後自動啟用（到 [Claude Platform](https://platform.claude.com/) 申請）。

**流程**：每天 `SUMMARY_TIME`（預設 08:00，`SUMMARY_TZ` 當地時間）→ 找出前一天訊息數 ≥ `SUMMARY_MIN_MESSAGES` 的群組 →
把當天對話整理成「`[09:05] 王小明: 內容`」逐字稿（含回覆引用，排除已收回訊息）→ 呼叫 Claude（`claude-opus-5-5`）並以
**結構化輸出（JSON Schema）** 取得固定格式的摘要 → 存入 `summaries` 資料表 → 後台顯示，並可選擇推播回群組。

摘要內容：
| 欄位 | 說明 |
| --- | --- |
| `overview` | 2–4 句整體摘要 |
| `topics[]` | 主題、摘要、主要參與者 |
| `decisions[]` | 明確達成的決議 |
| `action_items[]` | 待辦事項（負責人、期限，不明確時留空） |
| `open_questions[]` | 當天尚未得到回覆的問題 |
| `mood` | 整體氣氛：positive / neutral / negative / mixed |

推播到群組時的文字範例：
```
📋 業務群｜2026-10-12 每日摘要（42 則訊息）

團隊討論 Q4 報價與出貨時程…

【主題】
1. Q4 報價：客戶要求週五前提供報價。
【決議】
• 報價以去年單價 9 折為基準
【待辦】
□ 寄出報價單（王小明） 期限：10/17
【待回覆問題】
? 運費由誰負擔？

氣氛：中性
```

**手動產生**
- 後台 →「AI 每日摘要」→「產生今日摘要」（選擇左側群組則只產生該群組）
- API：`POST /api/summaries/run`，body `{ "sourceId": "C...", "date": "2026-10-12", "force": true, "push": false }`
- CLI（不需啟動伺服器）：`npm run summarize -- --date 2026-10-12 [--source Cxxx] [--force] [--push]`

**設計說明**
- 同一群組同一天只產生一次（服務重啟不會重複呼叫模型）；`force` 可重新產生。
- 聊天內容在提示詞中被標記為「資料」，群組成員在聊天中下的指令不會被當成對模型的指示。
- 已開啟伺服器端備援（`fallbacks: "default"`）：若模型因安全分類拒答，會自動改由建議的備援模型重跑。
- 費用參考：`claude-opus-5-5` 輸入 $4 / 輸出 $20（每百萬 tokens）。一個 300 則訊息的群組約 1–2 萬輸入 tokens，每天每群約 US$0.1–0.2（含思考與輸出 tokens）；每筆摘要的 token 用量會顯示在後台。
- `SUMMARY_PUSH_TO_GROUP=true` 會用 push API 發訊息，會消耗官方帳號每月的免費訊息額度，也請先徵得群組成員同意。

## API

設定 `ADMIN_TOKEN` 時需帶 `Authorization: Bearer <token>`（或 `?token=`）。

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| `POST` | `/webhook` | LINE Webhook 入口（驗證簽章） |
| `GET` | `/api/stats` | 統計數字 |
| `GET` | `/api/sources` | 群組 / 多人聊天 / 一對一列表（含名稱、人數、訊息數、是否仍在群組） |
| `GET` | `/api/messages?sourceId=&q=&type=&before=&limit=` | 訊息查詢（`before` 為 timestamp，用於分頁） |
| `GET` | `/api/members?sourceId=` | 群組中出現過的成員與發言數 |
| `GET` | `/api/alerts` | 關鍵字警示紀錄 |
| `GET` | `/api/events` | 最近的原始 Webhook 事件（除錯用） |
| `GET` | `/api/summaries?sourceId=&limit=` | AI 每日摘要列表 |
| `POST` | `/api/summaries/run` | 手動產生摘要（見上方說明） |
| `GET` | `/api/stream` | Server-Sent Events：`message`、`unsend`、`alert`、`summary` |
| `GET` | `/media/<path>` | 下載的多媒體檔案 |

標準化訊息格式（`/api/messages`、SSE、`FORWARD_WEBHOOK_URL` 共用）：
```json
{
  "id": "1791794378824821",
  "source": { "type": "group", "id": "Cxxxx", "name": "業務群" },
  "sender": { "id": "Uxxxx", "name": "王小明", "pictureUrl": "https://..." },
  "type": "text",
  "text": "請問這個月的報價？",
  "mediaPath": null,
  "quotedMessageId": null,
  "alerts": ["報價"],
  "timestamp": 1791794378824,
  "time": "2026-10-12T08:39:38.824Z",
  "raw": { "...": "LINE 原始 message 物件" }
}
```

## 擴充後續應用（Processors）

每則新訊息保存後，會依序交給 `src/processors/index.js` 中的處理器。新增一個應用只要：

```js
// src/processors/my-app.js
export function myApp() {
  return {
    name: 'my-app',
    async handle({ event, message, store, line, config, log, bus }) {
      // message 為上方的資料列（含 display_name、source_name…）
      // 例如：送進 LLM 做摘要/分類、寫入 CRM 工單、同步到 Google Sheets、統計活躍度…
    },
  };
}
```
再加入 `defaultProcessors()` 陣列即可。單一處理器出錯只會記錄 log，不影響訊息保存與其他處理器。

可延伸的方向：
- 客訴 / 報價等意圖分類 → 自動建立 CRM 工單
- 客服回應時效統計（客戶發問到內部人員回覆的時間）
- 匯出至資料倉儲（BigQuery 等）做長期分析

## 專案結構
```
src/
  index.js              進入點
  config.js             .env 載入與設定
  server.js             HTTP 路由、Webhook、API、SSE、靜態檔
  ingest.js             事件處理：保存、補齊資料、下載媒體、呼叫 processors
  db.js                 SQLite schema 與查詢
  line/client.js        LINE Messaging API 封裝
  line/signature.js     Webhook 簽章驗證
  processors/           後續應用（關鍵字警示、轉送 Webhook、Bot 指令）
  summary/              AI 每日摘要（summarizer、排程、時區工具）
public/index.html       後台介面
scripts/simulate.js     本機模擬 LINE Webhook
scripts/summarize.js    手動產生摘要 CLI
test/                   node:test 測試（npm test）
```

## 從 PoC 走向正式環境的建議
- 資料庫改用 PostgreSQL；多媒體改存 S3 / GCS。
- Webhook 收到後丟進佇列（Pub/Sub、SQS、Redis Stream），由 worker 處理，提高可靠度。
- 後台改用正式登入（SSO / OAuth），並依群組做權限控管。
- 訂定資料保存期限與成員告知機制。
