# 安全政策與私人用途假設

本專案是邀請制、少量熟人共用的私人備份工具，不是多租戶公開 SaaS。請勿開放公開註冊，也不要把管理試算表、Worker Secret 或 Apps Script 專案分享給不受信任的人。

## 機密資料處理

- Repository 只能保留 `.example` 設定。LINE Channel Secret、Access Token、Google OAuth Client Secret、共用 HMAC Secret 與實際服務 URL 不得 Commit。
- Cloudflare Secret 使用 `wrangler secret put` 設定；GAS Secret 使用 Script Properties 設定。
- OAuth Token 由 Apps Script OAuth2 Library 以每位使用者獨立 Service 名稱存放於 Script Properties，不寫入試算表或 Log；解除綁定會呼叫 `reset()` 清除該 Service 的 Token。
- `IDENTIFIER_HASH_SECRET` 專門為 LINE 使用者、群組、邀請碼、nonce、BindingSession 與 Drive 事件建立 HMAC-SHA256 雜湊；`BIND_TOKEN_SECRET` 只簽署短效 Bind Token，`WORKER_GAS_SHARED_SECRET` 只簽署 Worker→GAS envelope，三者必須互不相同。
- 管理試算表只保存識別雜湊，不保存原始 LINE userId、groupId、邀請碼或 nonce。Drive 的 `lineBackupEventKey` 也只保存 webhookEventId 的穩定 HMAC，不保存原始事件識別。
- 首次正式上線後不可直接輪替 `IDENTIFIER_HASH_SECRET`。直接更換會讓既有 Users、Groups、Invitations、Nonces、BindingSessions、OAuth Service 名稱與 Drive 冪等鍵失去關聯；未來如需輪替，必須先設計並驗證資料遷移程序。

## 已實作控制

- 使用未修改的 LINE webhook 原始 Body 驗證 `X-Line-Signature`，並以固定時間方式比較簽章。
- Worker 與 GAS 之間使用 timestamp、nonce、payload 與 HMAC-SHA256；GAS 驗證時間窗並以 Nonces 工作表防止重播。
- webhookEventId 與 messageId 由 Jobs 工作表去重，並以 Script Lock 保護競爭條件。`PROCESSING` 工作具有預設 600 秒租約；下載完成、Drive 上傳完成及寫入 Sheet 前後會延長租約。租約未過期時不重取，過期後可保留既有 DriveFileId 並安全重試。
- 附件以 webhookEventId 的穩定 HMAC 作為 Drive `appProperties.lineBackupEventKey`。上傳前只在目標資料夾及 `drive.file` 可見範圍查找相同鍵，找到後重用 File ID，避免上傳成功但 Jobs 尚未更新時產生副本。
- 綁定 Token 只包含 `lineUserHash`、期限與 nonce，不含原始 LINE userId。OAuth state 由 Apps Script OAuth2 Library 的 StateToken 機制保護。
- 綁定依序使用 `PENDING`、`AUTHORIZED`、`PROVISIONING`、`COMPLETED`／`FAILED` 狀態。Google 已授權但 Drive／Sheet 初始化失敗時會保留 OAuth Token 與可恢復 Session；只有資源與 Users 資料備妥後，才在受 Lock 保護的最後階段扣除邀請次數、完成 Session、消耗 nonce 並啟用使用者。
- 未通過 Worker HMAC、timestamp 與 nonce 驗證的 `doPost` 要求只留下白名單 Console Log，不得寫入管理 Sheet。
- 群組擁有者只能由 webhook 來源的傳送者建立，不能由前端指定。
- 外部輸入、回覆長度與檔名均有限制；檔名會移除控制字元、路徑符號與 `..`。
- 安全 Log 僅允許元件、錯誤碼、狀態與關聯 ID，不記錄 Token、Secret、訊息內容或完整個資。

## 已知限制

- Apps Script 的執行時間、`UrlFetchApp` 請求／回應大小及 PropertiesService 容量均有平台配額；預設為較保守的 20 MiB。管理者雖可提高到 45 MiB，但屬高風險且不保證成功。
- Queue 採至少一次傳遞。工作租約與 Drive `appProperties` 可涵蓋已知的重試中斷視窗，但 Drive 查詢、上傳、Jobs 與 Sheets 仍不是跨服務單一交易；配額錯誤或外部服務異常時仍需依 Jobs 與安全 Log 核對。
- Script Properties 有總容量與單一屬性限制，好友數量增加後應改用外部加密 Token 儲存；本版只適合少量私人使用者。
- 綁定 Token 以 HMAC 確保完整性但不是加密格式；雖不含原始 LINE userId，仍是短效 bearer Token，不應轉傳或截圖分享。
- `unsend` 預設只標示紀錄，不刪除 Drive 檔案。啟用刪除仍可能受 API 權限、檔案狀態或競爭條件影響。
- 所有指令均由 Queue 處理，LINE Reply Token 可能在回覆前失效。`ENABLE_PUSH_FALLBACK` 預設為 `false`；啟用後只會在 LINE 明確回報 Reply Token 無效且有收件者與文字時嘗試 Push，Push 失敗不會重新執行備份，但 Push 可能計入 LINE 官方帳號訊息用量。
- Apps Script OAuth callback URI 是 `/usercallback`，不是 Web App `/exec` URL。錯誤設定會造成 Google `redirect_uri_mismatch`。

## 回報安全問題

請私下通知 Repository 擁有者，內容只提供重現步驟與不敏感的關聯 ID；不要提交真實 Secret、OAuth Token、LINE userId、groupId 或個人資料至 Issue。
