# 系統架構

## 邊界與元件

```text
LINE Messaging API
  └─ POST /webhook + X-Line-Signature
Cloudflare Worker
  ├─ 驗證未修改的原始 Body
  ├─ 只解析與排入中繼資料
  └─ Cloudflare Queue
       └─ timestamp + nonce + payload + HMAC-SHA256
Google Apps Script Web App
  ├─ 管理 Sheet：邀請、雜湊對應、去重、Nonce、錯誤
  ├─ Apps Script OAuth2 Library：每位使用者獨立 OAuth Service
  ├─ LINE Content API：執行期間下載附件
  ├─ Google Drive API：以備份擁有者 Access Token 上傳
  └─ Google Sheets API：以備份擁有者 Access Token 寫入紀錄
```

Cloudflare Queue 只含 JSON 中繼資料，不含附件 bytes。附件只在一次 GAS 執行的記憶體中短暫存在，接著直接上傳至目標使用者 Drive；Cloudflare、管理者 Drive 與管理試算表都不永久保存附件。

## Worker 職責

- `POST /webhook` 先讀取原始字串，再用 LINE Channel Secret 計算 HMAC-SHA256 Base64；任何 JSON 正規化都發生在驗證後。
- 支援 `message`、`join`、`leave`、`follow`、`unfollow` 與 `unsend`。不支援的事件或訊息型別安全忽略並回傳 HTTP 200。
- 支援文字、圖片、影片、音訊與一般檔案。一般檔案若 webhook 已提供 `fileSize`，Worker 先標示超限；其他型別在 GAS 下載後再次檢查實際大小。
- 群組一般文字只有在 `mention.mentionees[].isSelf` 為 `true`、文字是 `#筆記`，或是指定指令時才排入 Queue。
- `綁定` 指令先以長期固定的 `IDENTIFIER_HASH_SECRET` 對 LINE userId 做 HMAC-SHA256，再以 `BIND_TOKEN_SECRET` 簽發只含 `lineUserHash`、到期時間與 nonce 的短效 Token。Token、URL、OAuth state 與 HTML 都不含原始 LINE userId。
- Queue consumer 為每個呼叫建立 timestamp 與 nonce，以 `timestamp.nonce.payload` 為簽署字串。GAS 處理後若回傳安全訊息，Worker 優先使用 LINE Reply API。
- Worker 等待 GAS 的預設 timeout 為 55 秒，但 timeout 只代表 Worker 停止等待，不代表 Apps Script 執行已停止。timeout 後的 Queue 重送若遇到有效 PROCESSING 租約，GAS 會回傳 `JOB_IN_PROGRESS` 與安全延遲，Worker 必須 retry 而不可 ACK。
- 所有指令都經 Queue，因此 Reply Token 可能在處理完成前失效。`ENABLE_PUSH_FALLBACK=true` 時，只有 Reply API 明確回報 Reply Token 無效且工作有回覆文字時，才以相同對象呼叫 Push API；Push 失敗只記安全 Log，不重做工作。

## GAS 職責與分層

- `Main.gs`：`doGet`、`doPost` 路由與工作協調，不直接保存 Token。
- `Security.gs`：HMAC、固定時間比較、輸入驗證、雜湊與安全錯誤模型。
- `OAuth.gs`：建立每位使用者獨立的 OAuth Service、callback、解除綁定。
- `*Repository.gs`：管理試算表的 Users、Groups、Invitations、Jobs、Nonces、BindingSessions 與 Errors 存取。
- `LineContent.gs`：LINE Content API 與群組摘要。
- `DriveService.gs`：Google Drive REST API、資料夾、resumable upload 與選用刪除。
- `SheetService.gs`：使用者自己的 Sheets REST API。
- `FileNameHelper.gs`：檔名、網址與標籤解析。

管理用 Sheet 由部署 GAS 的管理者身分透過 `SpreadsheetApp` 存取；朋友的附件與備份 Sheet 一律用朋友的 OAuth Access Token 呼叫 REST API，沒有使用 `DriveApp` 寫入管理者 Drive。

## OAuth 設計

1. 使用者私訊 `綁定 <邀請碼>`。
2. GAS 驗證 Invitations 的 `Enabled`、`MaxUses`、`UsedCount` 與 `ExpiresAt`，但此時不增加使用次數；只建立以 Token nonce 關聯的 PENDING BindingSession，工作表只保存 nonce、使用者與邀請碼雜湊。
3. GAS 回覆短效綁定 URL。`doGet?route=bind&token=...` 只驗證 Token 與 PENDING session，不消耗 nonce，因此重新整理頁面仍可繼續。
4. Apps Script OAuth2 Library 建立 `LineUser_<LineUserHash>` Service，Property Store、Cache 與 Lock 都使用 script scope。
5. `getAuthorizationUrl()` 把 `lineUserHash`、`bindNonce` 與 `expiresAt` 放入 OAuth2 Library 加密的 state；不放入原始 LINE userId 或邀請碼。
6. `oauthCallback` 重新驗證 state 格式、期限與 BindingSession，再呼叫 `handleCallback`。取消不消耗 nonce、不增加邀請使用次數。
7. `handleCallback` 成功後保留 OAuth Token，Session 先進入 AUTHORIZED 並保留邀請名額，再以 10 分鐘 PROVISIONING 租約初始化資源；初始化失敗轉為 FAILED，不 reset Token，也不扣邀請次數。
8. 根目錄、個人／群組目錄與備份 Sheet 都以 `IDENTIFIER_HASH_SECRET` 衍生的穩定 `lineBackupResourceKey` 寫入 Drive appProperties。重試會查詢並補齊同一組資源，不以名稱作唯一判斷。
9. 資源準備完成後，GAS 才在 Script Lock 內以單一 Sheets API `values.batchUpdate` 原子寫入 Users Enabled、增加 `UsedCount`、把 Session 設為 COMPLETED 並消耗 bind nonce。COMPLETED callback 重送會遭拒絕。
10. 管理者可暫設 `BINDING_RECOVERY_LINE_USER_HASH` 後手動執行 `resumeAuthorizedBinding()`，恢復 AUTHORIZED、FAILED 或租約已過期的 PROVISIONING；暫存 Property 會在函式結束時刪除。

OAuth scope 固定為 `openid email profile https://www.googleapis.com/auth/drive.file`，並使用 `access_type=offline` 與 `prompt=consent` 取得 Refresh Token。`drive.file` 也可授權 Sheets API 存取由此應用程式建立的試算表，因此不要求廣泛的全 Drive 權限。

## 資料夾與檔名

```text
LINE 自動備份/
├─ 個人備份/YYYY/MM/圖片|影片|音訊|檔案/
├─ 群組備份/群組名稱_群組雜湊前 10 碼/YYYY/MM/類型/
└─ LINE 備份紀錄（Google Sheet）
```

一般檔案保留清理後的原始檔名。圖片、影片與音訊使用 `type_yyyyMMdd_HHmmss_SSS_messageId.ext`。控制字元、路徑分隔符、保留符號、前後句點與 `..` 會被移除或替換，長度限制為 180 個字元。

## 去重與失敗模型

- GAS 先在 Script Lock 內用 webhookEventId 查詢 Jobs，第一次建立 `PROCESSING` 並設定 `LeaseExpiresAt`；預設租約為 600 秒。完成為 `COMPLETED`，安全拒絕為 `REJECTED`，失敗為 `FAILED`。
- Queue 重送遇到 COMPLETED、REJECTED、UNSENT 時不重新取得並可安全 ACK。租約仍有效的 PROCESSING 也不重新取得，但 GAS 會回傳 `retryable=true`、`JOB_IN_PROGRESS` 與租約剩餘秒數加 5 秒緩衝；延遲限制為 30 至 900 秒，Worker 呼叫 Queue retry，絕不 ACK 這個唯一可恢復工作。
- FAILED 與租約已過期的 PROCESSING 可重新取得、增加 RetryCount 並保留 DriveFileId。若原執行先完成，延後重送會辨識 COMPLETED 並 ACK；若原執行中止，延後重送會在租約過期後取得工作。
- 下載完成、Drive 上傳完成及寫入 Sheet 前後會呼叫 `touchJobLease_` 延長租約；所有終態都清空 `LeaseExpiresAt`。清理函式只刪除逾期 COMPLETED，不刪除可恢復的 PROCESSING。
- Drive 上傳成功後，會先把 Drive File ID 寫回 Jobs，再寫使用者 Sheet。若 Sheet 寫入失敗而 Queue 重試，會重用既有 File ID，避免再次上傳。
- 每個附件以 `IDENTIFIER_HASH_SECRET` 對 webhookEventId 做用途隔離 HMAC，產生穩定 `lineBackupEventKey`。Drive metadata 寫入此 appProperty；沒有 Job File ID 時，會先在目標資料夾查詢相同 key，找到後直接回填 Jobs，不下載或上傳。
- Jobs 更新以 `PRESERVE`、`CLEAR`、`SET` 明確區分 Drive File ID 行為；`FAILED` 一律保留已記錄的 File ID，安全拒絕才清空。
- `drive.file` scope 使 appProperties 查詢只看得到本應用程式建立或開啟的檔案，且查詢同時限制目標資料夾。appProperties 不是唯一索引；兩個真正同時的上傳仍存在極小競爭視窗。
- 這不是跨 Google Drive、使用者 Sheets 與管理 Sheet 的 ACID 交易；特別是 Sheet append 成功但 Job 完成前中止，仍可能留下重複紀錄列，需依 webhookEventId 人工核對。

## 已知技術修正與平台限制

既定要求希望「所有外部呼叫都有 timeout」。Cloudflare Worker 的 GAS 與 LINE 呼叫已設定 AbortController timeout；但是 Apps Script 的 `UrlFetchApp` API 沒有可由程式設定的 timeout 參數，只能依 Google 平台的執行與連線逾時。為維持既定架構與零額外成本，本版採用平台逾時、Queue 重試、去重與安全錯誤紀錄，不改用付費中介服務。此限制亦記錄於 `KNOWN_ISSUES.md`。

LINE Reply Token 短效且只能使用一次。Queue 延遲或大檔處理可能使回覆逾期，但不影響已完成的 Drive 備份。可選 Push fallback 預設關閉；啟用後可能計入 LINE 官方帳號訊息用量，且 Push 失敗不會重新執行備份。

公開 GAS `doPost` 只有在 Worker envelope 的 HMAC、timestamp 與 nonce 全部通過後，才可寫入 Errors 或 Jobs。未驗證 JSON、簽章、時間與 nonce 錯誤只輸出元件、錯誤碼與固定 correlation ID，不把攻擊流量寫入管理 Sheet。
