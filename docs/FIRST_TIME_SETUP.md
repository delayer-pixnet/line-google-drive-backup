# 第一次設定：從零到可測試

每完成一步都先核對「預期結果」，不要一次貼完所有 Secret。建議先只邀請管理者自己，完成隔離測試後再發朋友邀請碼。

1. 閱讀 `SECURITY.md` 與 `ARCHITECTURE.md`。預期理解附件屬於誰、哪些資料會雜湊、哪些限制不能消除。
2. 在 LINE 建立 Official Account 與 Messaging API Channel，關閉自動回應。預期取得 Channel Secret 與 Access Token，但先放在密碼管理器。
3. 開啟 Allow bot to join group chats。預期 LINE Developers 顯示 Enabled。
4. 建立 Google Cloud 專案，啟用 Drive API 與 Sheets API。預期 2 個 API 都顯示 Enabled。
5. 建立管理用 Google Sheet 與獨立 Apps Script 專案，取得 Spreadsheet ID 與 Script ID。
6. 用 Script ID 組出 `/usercallback` URI，設定 OAuth consent 與 Web application Client。預期取得 Client ID／Secret，redirect URI 完全吻合。
7. 把 `google-apps-script` 所有程式碼同步到 Apps Script，確認 OAuth2 Library identifier 是 `OAuth2`。
8. 對照共 13 個 GAS Script Properties，先設定除 `APP_BASE_URL` 外的 12 個；其中 3 組 HMAC 金鑰必須互不相同，`JOB_PROCESSING_LEASE_SECONDS` 初始使用 `600`。預期 Project Settings 只顯示 property 名稱與已儲存值，不在原始碼看到 Secret。
9. 執行 `initializeAdminSpreadsheet`。預期管理 Sheet 出現 7 個正確工作表；Jobs 有 `LeaseExpiresAt`，BindingSessions 有 `UpdatedAt` 與 `FailureCode`。
10. 部署 GAS Web App：Execute as Me、Access Anyone。預期取得 `/exec` URL；設回 `APP_BASE_URL`。
11. 開啟 GAS `/exec`。預期只看到 `{"status":"ok"}`。
12. 在 Cloudflare 複製 `wrangler.jsonc.example`，建立主 Queue 與 DLQ。
13. 設定 6 個 Cloudflare Secret。`WORKER_GAS_SHARED_SECRET`、`BIND_TOKEN_SECRET` 與 `IDENTIFIER_HASH_SECRET` 要分別和 GAS 完全一致，且三者不得共用；`ENABLE_PUSH_FALLBACK` 初始保持 `false`。
14. 執行 Worker typecheck、lint、test、build；全部通過後才由管理者執行 deploy。
15. 開啟 Worker `/health`。預期 HTTP 200，且沒有任何設定值。
16. 把 Worker `/webhook` 設成 LINE Webhook，開啟 Use webhook 並按 Verify。預期 Success。
17. 在 GAS 建立只可用 1 次、短期限的管理者邀請碼。預期 Invitations 只出現雜湊。
18. 私訊 Bot：`綁定 <邀請碼>`。預期收到 10 分鐘綁定連結，而不是在群組顯示連結。
19. 點連結並選管理者 Google 帳號。預期 Session 依序完成授權與初始化，Drive 出現「LINE 自動備份」與 2 個子資料夾、1 份「LINE 備份紀錄」Sheet；只有最後完成時才扣除邀請次數。
20. 私訊 `狀態`。預期顯示 Google 帳號已綁定。
21. 依 `TEST_CASES.md` 測試文字、網址、標籤、圖片、一般檔案、超限檔案、工作租約、Drive 冪等與 unsend。
22. 建立一般 LINE 群組、邀請 Bot，由管理者輸入 `綁定群組`。預期群組收到綁定完成回覆，Groups 只有 group hash。
23. 請另一位成員傳小型測試附件。預期檔案只出現在群組擁有者 Drive。
24. 完成管理者測試後，再為每位朋友建立獨立、低使用次數與短期限邀請碼，傳送 `FRIEND_BINDING_GUIDE.md`。
25. 用兩個不同 Google 帳號做隔離驗證：A 私訊附件只在 A Drive，B 私訊附件只在 B Drive；群組附件只在 owner Drive。
26. 手動執行 `cleanupExpiredAdminRecords`。預期只清理到期 Nonces、到期的 PENDING／COMPLETED BindingSessions、逾期 Errors 與已完成 Jobs；可恢復的 AUTHORIZED／PROVISIONING／FAILED Session、Users、Groups、Invitations 與 Drive 檔案不受影響。
27. 在密碼管理器把 `IDENTIFIER_HASH_SECRET` 標記為永久識別金鑰。正式資料建立後不可直接輪替；直接更換會切斷 Users、Groups、邀請、OAuth Service 與 Drive 冪等鍵的關聯。

任何一步與預期不符時停止，不要用真實朋友資料繼續測試；依 `TROUBLESHOOTING.md` 的層級逐一排除。
