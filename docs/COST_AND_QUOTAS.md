# 成本與配額

本架構以少量私人使用與免費額度為目標，但免費方案與配額會調整，部署前請在各平台官方 Pricing／Quotas 頁確認。超過免費額度時應停止或降低使用量，不要在未評估前啟用付費。

## Cloudflare

- Worker 請求、CPU、subrequest、Queue 操作與保留期限均有方案限制。
- Queue 每個 LINE 事件至少產生 1 次寫入與 1 次消費；重試會增加操作數。
- `observability.head_sampling_rate` 範例為 0.1，且安全 Log 不含內容；仍應定期檢查 Log 用量。
- DLQ 需要額外 Queue，但沒有獨立服務程式。

## Google Apps Script

- 受每日 `UrlFetchApp` 呼叫、單次執行時間、同時執行數與 URL Fetch 大小限制影響。
- 每個附件至少涉及 Drive `appProperties` 冪等查詢；沒有既有檔案時，才會進行 LINE download、Drive resumable session、Drive upload、資料夾查詢／建立及 Sheets append。
- 文字訊息不下載附件，但仍會查詢管理 Sheet 與呼叫 Sheets API。
- Script Properties 容量保存所有好友 OAuth Token；只適合少量帳號。

## Google Drive 與 Sheets

- 附件占用各備份擁有者自己的 Drive 空間，不占用系統管理者 Drive。
- 每位使用者的 Google API quota 與儲存空間獨立。大檔與大量小檔都可能觸發速率限制。
- 管理試算表的 Jobs、Nonces、BindingSessions 與 Errors 會持續增長；可由管理者執行 `cleanupExpiredAdminRecords`，依期限刪除過期記錄及超過保留期的 COMPLETED Jobs／Errors。可恢復的 `PROCESSING` Jobs 與 `AUTHORIZED`／`PROVISIONING`／`FAILED` BindingSessions 會保留；不要手動批次刪除 Users、Groups 或 Invitations。

## LINE

- Webhook 與 Reply API 的用量及訊息方案限制依 LINE Official Account 當期方案。
- 所有指令都經 Queue 處理，Reply Token 可能在 GAS 完成前過期。`ENABLE_PUSH_FALLBACK=false` 是預設值；若管理者改為 `true`，只有 LINE 明確回覆 Reply Token 無效時才嘗試 Push，Push 訊息可能計入 LINE 官方帳號訊息用量，實際計費與額度以當期方案為準。

## 建議容量政策

- 初始 `MAX_FILE_SIZE_BYTES=20971520`（20 MiB）。管理者可提高，但 45 MiB 屬高風險且不保證成功。
- 建議 `ERROR_RETENTION_DAYS=30`、`COMPLETED_JOB_RETENTION_DAYS=90`，並依實際用量定期手動執行清理函式。
- 初始 `JOB_PROCESSING_LEASE_SECONDS=600`。縮短租約會增加執行尚未結束即被重取的風險；延長則會增加異常中止後的等待時間。
- 先邀請 2 至 5 人測試，不要一次大量發碼。
- 每週查看 Cloudflare Queue／DLQ、Apps Script Executions、Google API quota 與管理 Sheet Errors。
