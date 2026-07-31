# 已知限制與待人工驗證項目

## 平台限制

1. Apps Script `UrlFetchApp` 沒有可設定的 timeout 參數。GAS→LINE／Google 呼叫依平台 timeout；Worker→GAS 預設等待 55 秒，但 Worker timeout 不表示 GAS 已停止。Queue 重送會以 PROCESSING 租約協調，避免把仍可恢復的工作 ACK 掉。
2. Apps Script 會把 LINE 附件完整載入記憶體後再上傳。預設上限已降為 20 MiB；管理者雖可提高，但 45 MiB 接近 `UrlFetchApp`、記憶體與執行時間限制，在慢速或配額緊張時不保證成功。
3. Script Properties 有每個值與總容量配額。每位使用者 OAuth Token 分開命名，但好友數量增加後可能超限；本版只適合少量私人使用者。
4. Cloudflare Queue 是至少一次傳遞；Drive、使用者 Sheets 與管理 Sheet 不是單一交易。Drive File ID 與 appProperties 已降低重複附件，但 Sheet append 成功後、Job 完成前中止仍可能產生重複紀錄列。
5. PROCESSING 預設使用 600 秒租約。有效租約會回 `JOB_IN_PROGRESS`，Queue 依剩餘租約延後且不 ACK；過期後可重新取得。若原執行超過租約仍繼續、同時新執行也開始，Drive appProperties 不是唯一索引，兩者仍有極小重複檔案競爭視窗。
6. LINE Reply Token 很短效，而且所有指令皆經 Queue。可選 Push fallback 預設關閉；啟用後仍可能失敗，且訊息可能計入 LINE 官方帳號用量，但不會因此重做備份。
7. `unsend` 事件不保證原始附件仍可下載；本版預設只標記已收回，不刪除 Drive 檔案。
8. LINE 社群的 webhook／權限模型不同，本專案明確不支援 LINE 社群或舊式多人聊天室，只支援個人聊天室與一般群組。
9. 同一個只剩 1 次使用額度的邀請碼可先建立多個 PENDING BindingSessions，但 OAuth 成功轉 AUTHORIZED 時會在 Script Lock 內保留名額，只有仍有額度者能進入初始化。FAILED Session 會保留名額直到恢復完成或管理者介入。
10. `IDENTIFIER_HASH_SECRET` 是永久資料關聯根金鑰。上線後直接輪替會使 Users、Groups、邀請、Nonce、OAuth Service 與 Drive appProperties 全部無法對應；本版不含已部署資料的雙金鑰遷移工具。
11. AUTHORIZED／FAILED 綁定恢復目前由管理者手動設定 `BINDING_RECOVERY_LINE_USER_HASH` 並執行 `resumeAuthorizedBinding()`；尚未提供一般使用者自助頁面或排程恢復。

## 必須在正式帳號人工驗證

- LINE Verify、實際 webhook 簽章、Bot 加群組與 mention 的完整 payload。
- Google OAuth consent、`/usercallback` redirect URI、Refresh Token 更新及撤銷。
- OAuth2 Library `getAuthorizationUrl()` 額外參數經 state 回傳，以及頁面重新整理、取消、成功與重複 callback 的實際行為。
- AUTHORIZED／PROVISIONING／FAILED 恢復、資源 appProperties 重用，以及最終 Users／邀請扣次／BindingSession／nonce 原子 `values.batchUpdate` 在部署者帳號授權下可成功執行。
- Apps Script OAuth2 Library 第 43 版可用性；部署時若編輯器顯示更新版，應先在測試部署驗證再升級。
- `drive.file` 對由應用程式建立之 Sheet 的 Sheets API 讀寫。
- 20 MiB 預設上限在實際 Apps Script 帳號配額與網路條件下的成功率；若刻意提高到 45 MiB，視為高風險壓力測試。
- Queue 重試、DLQ、Reply Token 逾期與 Cloudflare 免費方案目前配額。
- `JOB_IN_PROGRESS` 不寫 Errors、不改 FAILED、PROCESSING 租約回收、FAILED Job 沿用 DriveFileId、Drive appProperties 查找及清理函式目前只能由 Apps Script 手動測試及實際管理 Sheet 驗證；本機已完成 GAS 語法與 Worker retry／ack 邏輯測試。
- Google／LINE／Cloudflare UI 名稱可能隨平台改版，文件以功能名稱與預期結果輔助定位。

## 未納入 MVP

- LINE 社群、公開註冊、管理後台、AI、OCR、付費會員。
- Token 外部加密資料庫、跨區備援、端到端加密、自動資料保留排程。
- 已提供管理者手動執行的 `cleanupExpiredAdminRecords`，但不會自動建立時間觸發器；執行頻率仍需依 `COST_AND_QUOTAS.md` 人工安排。
- 自動化 GAS 測試 runner。GAS 測試須在 Apps Script 編輯器由管理者手動執行。
