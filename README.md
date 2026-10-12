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

- **零外部依賴**：只用 Node.js 22 內建模組（`http`、`crypto`、`node:sqlite`、`fetch`），`npm install` 都不用。
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
cp .env.example .env      # 填入 LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN
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
npm start
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
| `GET` | `/api/stream` | Server-Sent Events：`message`、`unsend`、`alert` |
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
- 每日群組摘要（排程撈 `/api/messages` 交給 LLM 產生摘要，再用 push API 推回群組或寄 Email）
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
public/index.html       後台介面
scripts/simulate.js     本機模擬 LINE Webhook
test/                   node:test 測試（npm test）
```

## 從 PoC 走向正式環境的建議
- 資料庫改用 PostgreSQL；多媒體改存 S3 / GCS。
- Webhook 收到後丟進佇列（Pub/Sub、SQS、Redis Stream），由 worker 處理，提高可靠度。
- 後台改用正式登入（SSO / OAuth），並依群組做權限控管。
- 訂定資料保存期限與成員告知機制。
