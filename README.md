# 私人多人共用 LINE Google Drive 備份 Bot

這是一套可自行部署的私人多人共用 MVP。所有人共用同一個 LINE Bot，但每位使用者以自己的 Google OAuth Token，把私訊附件存入自己的 Google Drive，並把文字、網址與標籤寫入自己的 Google Sheet。一般群組由一位已核准使用者擔任備份擁有者；可選擇使用自助綁定後由管理者審核，或保留邀請碼流程。

> 本專案不支援 LINE 社群、公開註冊、AI、OCR 或付費會員。請勿提交任何真實 Secret 或正式 URL。

## 最短啟動路徑

1. 閱讀 [首次設定](docs/FIRST_TIME_SETUP.md) 並建立 LINE、Google Cloud、Apps Script 與 Cloudflare 資源。
2. 在 `cloudflare-worker` 執行 `npm ci`、`npm run check`、`npm test` 與 `npm run build`。
3. 複製 `wrangler.jsonc.example` 為 `wrangler.jsonc`，再依 [Cloudflare 設定](docs/CLOUDFLARE_SETUP.md) 建立 Queue 與 Secret。
4. 複製 `.clasp.json.example` 為 `.clasp.json`，依 [Google Apps Script 設定](docs/GOOGLE_APPS_SCRIPT_SETUP.md) 加入 OAuth2 Library、Script Properties 並部署 Web App。
5. 依 [部署流程](docs/DEPLOYMENT.md) 串接 Worker webhook，完成 LINE Verify 後先測試自己的帳號。

本專案不會在一般程式修改時自動部署、建立遠端資源或執行 OAuth 同意；每次外部操作都必須由管理者明確手動執行。部署或同步前仍須由管理者明確授權；本機工作區不應提交真實設定，也不會由程式自動 Commit／Push Git。

## 功能摘要

- 私訊：圖片、影片、音訊與一般檔案進入自己的 Drive；一般文字與網址進入自己的備份 Sheet。
- 備份紀錄會保存清理後的「傳送者名稱」與安全化「傳送者識別」；LINE Profile 失敗時使用 hash 前綴 fallback，不會中斷備份。
- 群組：任一成員的附件與 `#筆記` 進入群組擁有者的 Drive／Sheet；一般文字只在提及 Bot、使用 `#筆記` 或指定指令時處理。群組管理與個人綁定指令受 owner／管理者及私訊限制。
- 群組清單：群組內可用 `備份清單`、`今日備份清單`、`本週備份清單`、`N月備份清單` 或 `YYYY-MM 備份清單` 查詢摘要；owner／管理者私訊 `群組紀錄 YYYY-MM g_xxxxxxxx` 取得 10 分鐘有效短查詢連結。舊群組紀錄缺少識別時，僅在名稱唯一且由 owner／管理者查詢時相容 fallback。
- 群組補備份：群組 owner／管理者可用 `補備份 今日`、`補備份 YYYY-MM` 或日期區間重新排入已收到但失敗／未完成的工作；私訊可用 `群組補備份` 加日期與安全群組代號。此功能只重試系統曾收到的 webhook，不會抓取 LINE 歷史訊息。
- OAuth 授權失效時不會靜默丟棄附件：個人會立即收到重新授權提示，群組則由 30 分鐘冷卻提醒群組 owner；事件 metadata 會保留在 Jobs，重新授權後可用 `補備份 今日` 嘗試補回可取得的附件。無法取得 LINE Content 或未保存原文的項目仍可能略過。
- 指令：`綁定`（自助申請）、`綁定 <邀請碼>`、`重新授權`（更新既有 OAuth Token、不重建 Drive／Sheet）、`狀態`、`容量／空間／Drive容量`、`群組容量`、`紀錄／查詢紀錄`、`解除綁定`、`綁定群組`、`解除群組`、`#筆記 <內容>`、`說明`；管理者另有 `待審核`、`核准／拒絕 <編號[,編號]>`、`核准／拒絕 全部`（需二次確認）。
- 自助綁定：`REQUIRE_ADMIN_APPROVAL=true` 時等待管理者核准；設為 `false` 時 OAuth 與 Drive 初始化完成即自動核准並啟用備份。
- `紀錄` 查詢中心只在私訊產生 10 分鐘短效連結，資料限制在目前使用者自己的備份 Sheet；群組成員不能在群組中開啟完整紀錄。
- 防護：LINE 原始 Body 簽章、Worker→GAS HMAC、防重播、工作租約、Drive `appProperties` 冪等、邀請碼雜湊與短效綁定 Token。
- 金鑰分工：`IDENTIFIER_HASH_SECRET` 只建立長期識別雜湊；`BIND_TOKEN_SECRET` 只簽署短效綁定 Token；`WORKER_GAS_SHARED_SECRET` 只驗證 Worker→GAS envelope。首次上線後不可直接輪替 `IDENTIFIER_HASH_SECRET`。
- Google OAuth App 若仍為 Testing，含 `drive.file` 等非基本身分 scope 時，Refresh Token 可能受測試期限制而週期性失效。提供朋友長期使用前，管理者應依 [OAuth Production 發布步驟](docs/GOOGLE_APPS_SCRIPT_SETUP.md#google-oauth-app-發布到-production) 將 App 發布到 Production；已失效帳號仍需私訊輸入 `重新授權` 一次，這只更新 Token，不刪除 Users、Drive、Sheet 或群組資料。
- OAuth App 發布到 Production 後，可由管理者在 Apps Script 設定 `TEST_LINE_USER_HASH`（64 碼小寫雜湊）並手動執行 `testOAuthRefreshForConfiguredUser`，確認既有 OAuth Service 的 Token 可自動取得及呼叫 Drive `about.get`；需要主動驗證 Refresh Token 時，偶爾執行 `testOAuthForceRefreshForConfiguredUser`。這兩個測試不會由本專案直接寫入或 reset Token，也不會修改資料；OAuth2 Library 依 `hasAccess()`／`refresh()` 的正常流程可能更新授權 Token。
- 預設單檔上限為 20 MiB；45 MiB 屬 Apps Script 高風險設定且不保證成功。
- 附件只在 GAS 執行期間存在記憶體，不永久保存在 Cloudflare 或管理者的 Drive。

所有指令都經 Cloudflare Queue 處理，因此 LINE Reply Token 可能在回覆前過期。可選的 Push fallback 預設關閉，且只在 LINE 明確回覆 Reply Token 無效時使用；備份結果應以 Drive、Sheet 與 Jobs 狀態為準。

私訊輸入 `狀態` 會顯示個人綁定、OAuth `hasAccess()` 狀態、短效 Access Token 剩餘時間（可取得時）、Refresh Token 是否存在、最後檢查時間，以及最多 10 個管理中群組名稱。群組內的 `狀態` 仍只顯示該群組是否已綁定，不會公開個人授權資訊。

私訊輸入 `系統狀態` 或 `系統診斷` 可由 Worker 直接回覆 Worker、Queue 與最近 GAS 呼叫狀態，即使 GAS Web App 暫時回 HTTP 403 HTML 也能取得基本診斷。若 GAS 403 HTML 導致一般工作無法執行，Worker 會以 Reply API 提醒管理者執行 `testOwnerAuthorizationHealth`；Reply 失敗只記錄安全錯誤，不會重做備份或改用 Push。

## 專案目錄

- `cloudflare-worker/`：TypeScript webhook producer、Queue consumer 與單元測試。
- `google-apps-script/`：GAS OAuth、LINE Content、Drive／Sheets API 與管理試算表 Repository。
- `docs/`：架構、安全、設定、部署、測試與故障排除文件。

完整資料流請見 [DATA_FLOW.md](docs/DATA_FLOW.md)，安全邊界請見 [SECURITY_DESIGN.md](docs/SECURITY_DESIGN.md)，目前驗證狀態請見 [PROJECT_STATUS.md](docs/PROJECT_STATUS.md)。
