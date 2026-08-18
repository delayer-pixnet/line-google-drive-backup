# 第一次設定：從零到可測試

每完成一步都先核對「預期結果」，不要一次貼完所有 Secret。建議先只邀請管理者自己，完成隔離測試後再發朋友邀請碼。

1. 閱讀 `SECURITY.md` 與 `ARCHITECTURE.md`。預期理解附件屬於誰、哪些資料會雜湊、哪些限制不能消除。
2. 在 LINE 建立 Official Account 與 Messaging API Channel，關閉自動回應。預期取得 Channel Secret 與 Access Token，但先放在密碼管理器。
3. 開啟 Allow bot to join group chats。預期 LINE Developers 顯示 Enabled。
4. 建立 Google Cloud 專案，啟用 Drive API 與 Sheets API。預期 2 個 API 都顯示 Enabled。
5. 建立管理用 Google Sheet 與獨立 Apps Script 專案，取得 Spreadsheet ID 與 Script ID。
6. 用 Script ID 組出 `/usercallback` URI，設定 OAuth consent 與 Web application Client。預期取得 Client ID／Secret，redirect URI 完全吻合。
7. 把 `google-apps-script` 所有程式碼同步到 Apps Script，確認 OAuth2 Library identifier 是 `OAuth2`。
8. 對照共 17 個 GAS Script Properties，先設定除 `APP_BASE_URL` 外的 16 個；其中 3 組 HMAC 金鑰必須互不相同，`JOB_PROCESSING_LEASE_SECONDS` 初始使用 `600`。若採用自助綁定，將 `ENABLE_SELF_SERVICE_BINDING=true`、`REQUIRE_ADMIN_APPROVAL=true`，並把管理者的 64 位 `lineUserHash` 逗號分隔填入 `ADMIN_LINE_USER_HASHES`。預期 Project Settings 只顯示 property 名稱與已儲存值，不在原始碼看到 Secret。
9. 執行 `initializeAdminSpreadsheet`。預期管理 Sheet 出現 7 個正確工作表；Jobs 有 `LeaseExpiresAt`，BindingSessions 有 `UpdatedAt` 與 `FailureCode`。
10. 部署 GAS Web App：Execute as Me、Access Anyone。預期取得 `/exec` URL；設回 `APP_BASE_URL`。
11. 在 Apps Script 編輯器執行 `testOwnerAuthorizationHealth`。若跳出 Review Permissions，完成管理者授權後再次執行；預期 Logger 顯示 `PASS testOwnerAuthorizationHealth`。
12. 開啟 GAS `/exec`。預期只看到 `{"status":"ok"}`，不會再因擁有者尚未授權而回傳 403 HTML。
13. 在 Cloudflare 複製 `wrangler.jsonc.example`，建立主 Queue 與 DLQ。
14. 設定 6 個 Cloudflare Secret。`WORKER_GAS_SHARED_SECRET`、`BIND_TOKEN_SECRET` 與 `IDENTIFIER_HASH_SECRET` 要分別和 GAS 完全一致，且三者不得共用；`ENABLE_PUSH_FALLBACK` 初始保持 `false`。
15. 執行 Worker typecheck、lint、test、build；全部通過後才由管理者執行 deploy。
16. 開啟 Worker `/health`。預期 HTTP 200，且沒有任何設定值。
17. 把 Worker `/webhook` 設成 LINE Webhook，開啟 Use webhook 並按 Verify。預期 Success。
18. 若採用邀請碼模式，在 GAS 建立只可用 1 次、短期限的管理者邀請碼；自助模式可略過此步。預期 Invitations 只出現雜湊。
19. 私訊 Bot：自助模式輸入 `綁定`，邀請碼模式輸入 `綁定 <邀請碼>`。預期收到 10 分鐘綁定連結，而不是在群組顯示連結。
20. 點連結並選 Google 帳號。預期 Session 依序完成授權與初始化，Drive 出現「LINE 自動備份」與 2 個子資料夾、1 份「LINE 備份紀錄」Sheet；邀請碼只在最後完成時扣除。自助模式在 `REQUIRE_ADMIN_APPROVAL=true` 時 Users 先為 `PENDING_APPROVAL`／`Enabled=false`；設為 `false` 時直接為 `APPROVED`／`Enabled=true`，成功頁顯示「Google 授權完成，已啟用備份」。
21. 自助模式由管理者私訊 `待審核`，取得安全化代號後輸入 `核准 <編號>`；預期 Users 變成 `APPROVED`／`Enabled=true`。非管理者執行這些指令應被拒絕。
22. 私訊 `狀態`。預期核准後顯示 Google 帳號已綁定；核准前顯示等待審核。已啟用使用者可再私訊 `紀錄`，取得 10 分鐘查詢中心連結。
23. 依 `TEST_CASES.md` 測試文字、網址、標籤、圖片、一般檔案、超限檔案、工作租約、Drive 冪等與 unsend。
24. 建立一般 LINE 群組、邀請 Bot，由已核准管理者輸入 `綁定群組`。預期群組收到綁定完成回覆，Groups 只有 group hash。
25. 請另一位成員傳小型測試附件，再傳 `#筆記 測試內容`。預期附件只出現在群組擁有者 Drive，筆記寫入 owner Sheet；傳送者不需個人綁定或通過審核。
26. 完成管理者測試後，再為每位朋友啟用自助綁定並逐一審核，或建立獨立、低使用次數與短期限邀請碼，傳送 `FRIEND_BINDING_GUIDE.md`。
27. 用兩個不同 Google 帳號做隔離驗證：A 私訊附件只在 A Drive，B 私訊附件只在 B Drive；群組附件只在 owner Drive。
28. 手動執行 `cleanupExpiredAdminRecords`。預期只清理到期 Nonces、到期的 PENDING／COMPLETED BindingSessions、逾期 Errors 與已完成 Jobs；可恢復的 AUTHORIZED／PROVISIONING／FAILED Session、Users、Groups、Invitations 與 Drive 檔案不受影響。
29. 在密碼管理器把 `IDENTIFIER_HASH_SECRET` 標記為永久識別金鑰。正式資料建立後不可直接輪替；直接更換會切斷 Users、Groups、邀請、OAuth Service 與 Drive 冪等鍵的關聯。

任何一步與預期不符時停止，不要用真實朋友資料繼續測試；依 `TROUBLESHOOTING.md` 的層級逐一排除。
