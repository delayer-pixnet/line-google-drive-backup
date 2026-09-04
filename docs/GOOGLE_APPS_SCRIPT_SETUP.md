# Google Apps Script 設定

## 1. 建立管理試算表

1. 用系統管理者 Google 帳號建立一份空白 Google Sheet，名稱可用「LINE 備份 Bot 管理」。
2. 從網址取得 Spreadsheet ID，也就是 `/d/` 與 `/edit` 之間的字串。
3. 這個 ID 不是 OAuth Token，但會揭露資源識別，不要 Commit；稍後設為 `ADMIN_SPREADSHEET_ID`。
4. 不要把這份 Sheet 分享給朋友。朋友只需授權自己的 Drive，不需看到管理資料。

## 2. 建立 Apps Script 專案與程式碼

1. 建立獨立 Apps Script 專案，Project Settings 將時區設為 `Asia/Taipei`，啟用顯示 `appsscript.json`。
2. 可用 `clasp`：複製 `.clasp.json.example` 為 `.clasp.json`，填入 Script ID，再從 `google-apps-script` 目錄執行 `clasp push`。也可在編輯器逐一建立同名 `.gs`／`.html` 並貼入內容。
3. 確認 `appsscript.json` 包含 OAuth2 Library dependency。若需由 UI 手動加入，Library Script ID 為公開的官方 ID `1B7FSrk5Zi6L1rSxxTDgDEUsPzlukDsi4KGuTMorsTQHhGBzBkMun4iDF`，identifier 使用 `OAuth2`，版本使用文件指定版本或經測試的新版本。
4. 預期左側檔案清單可看到 `Main.gs`、`OAuth.gs`、各 Service／Repository、`BindPage.html`、`ResultPage.html`、`RecordSearchPage.html` 與 `appsscript.json`。

`appsscript.json` 的 `oauthScopes` 是 Apps Script 程式自身執行用權限，例如 `script.external_request` 與管理 Sheet 的 `spreadsheets`；它們不等於朋友 Google 帳號的授權範圍。朋友的 OAuth scope 只由 `OAuth.gs` 的 `getGoogleOAuthService_()` 明確設定，包含 `openid`、`email`、`profile` 與 `https://www.googleapis.com/auth/drive.file`，並要求 `access_type=offline`、`prompt=consent`。因此首次開啟 Web App 可能先看到 Apps Script 自身的授權畫面；完成該層授權後，綁定連結才會顯示使用者 Google OAuth 的 Drive 檔案權限。不要把 `script.external_request` 加入使用者 OAuth scope，也不要把 `drive.file` 當成管理者 Apps Script scope。

## 3. Script Properties 完整對照

到 Project Settings → Script Properties 逐項新增。值不可放入 `.gs`、`appsscript.json` 或 Git。

| 名稱 | 取得位置與格式 | Secret | 可提交 Git | 設錯現象 |
|---|---|---:|---:|---|
| `GOOGLE_OAUTH_CLIENT_ID` | Google Cloud Web application Client ID，通常以 `.apps.googleusercontent.com` 結尾 | 否，但不建議公開 | 否 | 授權頁顯示 client 無效 |
| `GOOGLE_OAUTH_CLIENT_SECRET` | 同一 OAuth Client 的 Client Secret | 是 | 否 | callback 換 Token 失敗 |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Developers Messaging API 長效 Token，完整單行 | 是 | 否 | 附件下載與群組摘要失敗 |
| `WORKER_GAS_SHARED_SECRET` | 自行產生至少 32 個隨機 bytes 的字串，須與 Cloudflare 完全相同 | 是 | 否 | GAS 回覆 `SIGNATURE_INVALID`，Queue 重試／DLQ |
| `BIND_TOKEN_SECRET` | 一組獨立、至少 32 個隨機 bytes，須與 Cloudflare 完全相同；只簽署 Bind Token | 是 | 否 | 綁定 Token 驗證失敗；輪替後未使用的舊連結失效 |
| `IDENTIFIER_HASH_SECRET` | 第三組獨立、至少 32 個隨機 bytes，須與 Cloudflare 完全相同；只建立永久識別雜湊 | 是 | 否 | Worker／GAS 雜湊不一致；上線後直接輪替會使既有資料與 OAuth Service 無法對應 |
| `ADMIN_SPREADSHEET_ID` | 管理 Sheet ID，只填 ID，不填整個 URL | 敏感設定 | 否 | 找不到或無權開啟管理 Sheet |
| `MAX_FILE_SIZE_BYTES` | 十進位 bytes，預設 `20971520`（20 MiB），不可超過 `51380224` | 否 | 範例可、正式值不可 | 附件全被拒絕或顯示設定無效；45 MiB 屬高風險且不保證成功 |
| `APP_BASE_URL` | 已部署 GAS Web App 的完整 `/exec` URL，不加 query string | 敏感設定 | 否 | LINE 綁定連結無法開啟 |
| `WORKER_REPLAY_ENDPOINT` | 已部署 Worker URL 加上 `/internal/replay`，例如 `https://<Worker>/internal/replay`；不得含 query string | 否（但屬內部端點設定） | 否 | `群組補備份` 只能建立候選紀錄，無法送入 Queue |
| `DELETE_DRIVE_ON_UNSEND` | `false` 或 `true`，建議先用 `false` | 否 | 範例可、正式設定不提交 | 設為其他值會視為不刪除 |
| `ERROR_RETENTION_DAYS` | 正整數天數，預設 `30`，允許 1 至 3650 | 否 | 範例可、正式設定不提交 | 未設定時用 30 天；格式無效時清理函式拒絕執行 |
| `COMPLETED_JOB_RETENTION_DAYS` | 正整數天數，預設 `90`，允許 1 至 3650 | 否 | 範例可、正式設定不提交 | 未設定時用 90 天；格式無效時清理函式拒絕執行 |
| `JOB_PROCESSING_LEASE_SECONDS` | 正整數秒數，預設 `600`，允許 60 至 3600 | 否 | 範例可、正式設定不提交 | 未設定時用 600 秒；過短會造成尚在處理的工作被重取，格式無效時拒絕處理 |
| `HMAC_DIAGNOSTIC_ENABLED` | `false`；只在定位 `SIGNATURE_INVALID` 時與 Worker 暫時同步設為 `true` | 否 | 範例可、正式設定不提交 | 未設定或非 `true` 時不輸出任何診斷指紋；完成比對後應立即改回 `false` |
| `ADMIN_LINE_USER_HASHES` | 逗號分隔的 64 位小寫 `lineUserHash`；只填管理者，不填原始 LINE userId | 敏感設定 | 否 | 格式錯誤時管理者指令會被拒絕 |
| `ENABLE_SELF_SERVICE_BINDING` | `true` 或 `false`；`true` 允許私訊輸入「綁定」直接取得 OAuth 連結 | 否 | 範例可、正式設定不提交 | `false` 時仍只能使用「綁定 <邀請碼>」 |
| `REQUIRE_ADMIN_APPROVAL` | `true` 時自助 OAuth 完成後先建立 `PENDING_APPROVAL` 且停用備份；`false` 時初始化完成即 `APPROVED`／啟用 | 否 | 範例可、正式設定不提交 | `true` 時未核准帳號不可備份或綁定群組 |
| `TEST_LINE_USER_HASH` | 僅供管理者手動 OAuth 刷新測試的 64 碼小寫 `lineUserHash`；不是原始 LINE userId | 敏感設定 | 否 | 格式錯誤、Users 不存在或未啟用時測試安全失敗 |

`script-properties.example.json` 列出完整範例名稱，可用來逐項核對，但不可直接填入真實值後提交。`WORKER_GAS_SHARED_SECRET`、`BIND_TOKEN_SECRET` 與 `IDENTIFIER_HASH_SECRET` 必須三者不同。可用密碼管理器產生高熵值；不要把產生指令輸出貼入文件或終端紀錄截圖。

### 一次性 HMAC 診斷

若 GAS 回覆 `SIGNATURE_INVALID`，先確認 Worker 與 GAS 的 `WORKER_GAS_SHARED_SECRET` 完全相同，再只在短時間內將兩端 `HMAC_DIAGNOSTIC_ENABLED` 設為 `true`。診斷輸出只含固定長度的 HMAC／SHA-256 指紋、Signature 前綴與 Script ID 尾碼，不含原始 Secret、payload、nonce、Token 或 URL。完成一次受控測試後，立即將 GAS Property 改回 `false`；不要把診斷輸出公開或長期啟用。

`IDENTIFIER_HASH_SECRET` 是永久資料關聯的一部分。首次正式上線後不可直接更換；它同時影響 Users、Groups、Invitations、Nonces、BindingSessions、OAuth Service 名稱與 Drive `lineBackupEventKey`。若日後確實需要輪替，必須另行設計資料與 Token 遷移，不能只替換 Property。

自助綁定啟用後，管理者可在私訊使用 `待審核`、`核准 <編號[,編號]>`、`拒絕 <編號[,編號]>`。`核准全部`／`拒絕全部` 會先產生 5 分鐘確認碼；只有同一管理者輸入對應的確認指令才會執行，確認碼消耗後不可重用。批次只處理 `PENDING_APPROVAL` 且 `Enabled=false` 的 Users。

群組 owner／管理者可使用 `補備份 今日`、`補備份 2026-08` 或日期區間；私訊可使用 `群組補備份`，多個群組時附上 `g_xxxxxxxx` 安全代號。補備份只處理 Bot 已收到且仍有必要 metadata 的失敗／未完成工作，不是 LINE 歷史訊息查詢。首次啟用前，請把 Worker 部署網址加上 `/internal/replay` 填入 `WORKER_REPLAY_ENDPOINT`；此值不可填入聊天、Git 或公開文件，且不需要新增 Secret。

使用者私訊 `紀錄` 或 `查詢紀錄` 可取得 10 分鐘查詢連結。查詢中心讀取自己的備份 Sheet；群組 owner 也只能從私訊查詢自己 Sheet 中的群組紀錄。群組內輸入查詢指令不會產生連結。若要手動驗證頁面，預期標題為「LINE 記錄搜尋中心」，可用日期、關鍵字與類型篩選，且不顯示 LINE userId、groupId 或 Google Email。

輪替 `BIND_TOKEN_SECRET` 只會讓尚未完成的舊 Bind Token 失效，不會改變既有 lineUserHash；輪替 `WORKER_GAS_SHARED_SECRET` 只影響 Worker envelope 驗證。兩端更新金鑰時仍應安排一致的切換時點，避免短暫驗證失敗。

## 4. 初始化管理工作表

1. 在編輯器選 `initializeAdminSpreadsheet` 並按 Run。
2. 第一次執行會要求管理者授權 Apps Script 存取管理 Sheet 與外部請求；檢查權限後允許。
3. 預期管理 Sheet 時區設為 `Asia/Taipei`，並出現 Users、Groups、Invitations、Jobs、Nonces、BindingSessions、Errors，共 7 個工作表；第一列凍結並符合欄位名稱。Users 最後一欄為 `ApprovalStatus`；Jobs 必須包含 `LeaseExpiresAt`；BindingSessions 必須包含 `UpdatedAt` 與 `FailureCode`。舊版 Users 10 欄會由程式在保留資料的前提下補上最後一欄。
4. 若顯示 `ADMIN_HEADERS_MISMATCH`，不要直接覆蓋；先確認是否使用舊版本管理表並備份資料。

本版新增或需特別核對的完整欄位順序：

- Jobs：`WebhookEventId`、`MessageId`、`Status`、`RetryCount`、`LeaseExpiresAt`、`DriveFileId`、`ErrorCode`、`ErrorMessage`、`CreatedAt`、`UpdatedAt`，以及新版附加的 `MessageType`、`LineUserHash`、`GroupIdHash`、`OwnerLineUserHash`、`SourceType`、`OriginalFileName`、`LineMessageTime`、`SenderDisplayName`、`GroupDisplayName`。舊版 Jobs 只有前 10 欄時，程式會在最右側補欄，不會清除既有資料；OAuth 失效的附件會以 `OAUTH_REAUTH_REQUIRED` 保留必要 metadata 供重新授權後補備份。
- BindingSessions：`SessionNonceHash`、`LineUserHash`、`InviteCodeHash`、`ExpiresAt`、`UsedAt`、`Status`、`CreatedAt`、`UpdatedAt`、`FailureCode`。
- Users：`LineUserHash`、`GoogleSubjectId`、`GoogleEmail`、`RootFolderId`、`PersonalFolderId`、`GroupFolderId`、`SheetId`、`Enabled`、`CreatedAt`、`UpdatedAt`、`ApprovalStatus`。

不要手動插入、改名或搬動欄位。Job 進入 `PROCESSING` 時 `LeaseExpiresAt` 應有值；完成、失敗或拒絕後會清空。下載完成、Drive 上傳完成及寫入 Sheet 前後會延長租約。

## 5. 部署 Web App

1. Deploy → New deployment → Web app。
2. Execute as 選 Me／部署者；Who has access 選 Anyone。公開入口仍受 HMAC 保護。
3. 按 Deploy，完成管理者授權。預期取得以 `/exec` 結尾的 Web App URL。
4. 把該 URL 設到 Script Property `APP_BASE_URL`，並稍後設為 Cloudflare `GAS_ENDPOINT_URL`。不要 Commit。
5. 瀏覽 `/exec`，預期只看到 `{"status":"ok"}`，不會顯示設定值。
6. 每次改 GAS 程式後需建立新版本或編輯 deployment 指向新版本；只儲存編輯器不會更新既有 deployment。
7. 每次 `clasp push --force` 並更新 Web App 版本後，在 Apps Script 編輯器執行全域函式 `testOwnerAuthorizationHealth`。若跳出 Review Permissions，完成管理者授權後重新執行；預期 Logger 顯示 `PASS testOwnerAuthorizationHealth`，再測試 LINE `說明`。

若舊版 Users 有 `Enabled=true` 但 `ApprovalStatus` 空白，可由管理者手動執行 `migrateEnabledUsersToApproved`。函式只補上 `APPROVED`，不處理停用／拒絕／待審核使用者，也不刪除資料或 OAuth Token；執行前後 Logger 會顯示更新筆數。

## 6. 建立邀請碼

1. 在 Script Properties 暫時新增 `NEW_INVITE_CODE`、`NEW_INVITE_MAX_USES` 與 `NEW_INVITE_EXPIRES_AT`。邀請碼格式只用 4 至 64 位大寫英數與連字號；期限使用 ISO 8601，例如台北時區的未來時間。
2. 執行 `createInvitationFromTemporaryProperties`。
3. 預期 Invitations 新增 1 列，只看得到 64 位雜湊、次數與期限；3 個 `NEW_` Properties 會立即刪除。朋友輸入邀請碼或完成 Google OAuth 時都不會先扣次；只有備份資源與 Users 資料準備完成後，最後受 Lock 保護的完成程序才會增加 `UsedCount`。
4. 私下把原始邀請碼交給指定朋友，不要放在管理 Sheet、Log、Git 或群組公告。

## 7. 手動測試

依 `TEST_CASES.md` 執行 TestFunctions。建立 Drive／Sheet 與驗證資源重用的 3 個測試需先完成自己的 LINE 綁定，再把 Users 的 LineUserHash 暫設為 `TEST_LINE_USER_HASH`。測試可能真的在該授權帳號建立標示為手動測試的資源，測試後自行刪除。

## 8. 恢復已授權但尚未完成的綁定

BindingSessions 支援 `PENDING`、`AUTHORIZED`、`PROVISIONING`、`COMPLETED` 與 `FAILED`。若 Google 授權成功，但 Drive／Sheet 初始化因配額或暫時性錯誤失敗，系統會保留 OAuth Token，Session 會停在 `AUTHORIZED`、`PROVISIONING` 或 `FAILED`，且不會扣除邀請次數。管理者可依下列方式恢復：

`PROVISIONING` 本身固定使用 10 分鐘租約，租約內會拒絕同一 Session 併發初始化；逾期才允許恢復程序重新取得。這和由 `JOB_PROCESSING_LEASE_SECONDS` 控制的 Queue Job 租約是不同機制。

1. 從 BindingSessions 找到待恢復列的 `LineUserHash`。只複製 64 位小寫十六進位雜湊，不要取得或記錄原始 LINE userId。
2. 在 Script Properties 暫時新增 `BINDING_RECOVERY_LINE_USER_HASH`，值填上述雜湊。
3. 在 Apps Script 編輯器無參數執行 `resumeAuthorizedBinding`。
4. 預期部分已建立的根資料夾、個人資料夾、群組資料夾與 Sheet 會被重用；成功後 Session 變成 `COMPLETED`、Users 為 Enabled，邀請次數只增加 1 次。
5. 函式結束後會自動刪除暫存 `BINDING_RECOVERY_LINE_USER_HASH`。若仍失敗，OAuth Token 會保留，待排除配額或 API 問題後可再次執行。

目前 `狀態` 指令只查詢綁定結果，不會自動執行恢復。不要為恢復而重新發邀請碼，也不要手動把 Session 改成 `COMPLETED`。

## 9. 管理資料清理

1. 先設定 `ERROR_RETENTION_DAYS` 與 `COMPLETED_JOB_RETENTION_DAYS`，再於 Apps Script 編輯器手動執行 `cleanupExpiredAdminRecords`。
2. 預期 Execution log 只顯示 Nonces、BindingSessions、Errors 與 completedJobs 的刪除筆數，不顯示任何資料內容；仍為 `PROCESSING` 且可能由租約恢復的 Jobs，以及 `AUTHORIZED`／`PROVISIONING`／`FAILED` 的可恢復 BindingSessions，都不會被刪除。
3. 此函式不刪除 Users、Groups、Invitations 或使用者 Drive 檔案。首次部署建議人工執行確認，之後可由管理者依用量定期執行；本專案不會自行建立時間觸發器。

## Script Properties 容量

Apps Script Properties 有單一值與總容量限制。OAuth2 Library 會把每位使用者的 Access／Refresh Token 分開放在 `LineUser_<hash>` Service storage；少量私人使用可行，但不可擴成公開服務。定期在 Apps Script Executions 檢查配額錯誤，且絕對不要輸出 Properties 內容。

## 群組查詢更新後固定健康檢查

每次 `clasp push --force` 並將既有 GAS Web App 更新到新版本後，管理者必須先在 Apps Script 編輯器手動執行全域函式 `testOwnerAuthorizationHealth`。若畫面出現 Google Review Permissions，完成授權後再次執行，Logger 應顯示 `PASS testOwnerAuthorizationHealth`。接著私訊 Bot 測試 `說明`，再到已綁定群組測試 `說明` 與 `備份清單`；預期群組只有摘要，不會公開 Drive 或查詢中心連結。

群組完整查詢使用 `群組紀錄 YYYY-MM`，多個群組時再附 `g_xxxxxxxx` 安全代號。Bot 回覆的是 GAS `/exec?route=q&id={shortCode}` 的 10 分鐘短連結，不包含長 Token；此流程沿用既有 `drive.file` scope，不新增 OAuth scope。舊列缺少「群組識別」時，符合唯一名稱條件才會相容查詢；管理者可手動執行 `migrateLegacyGroupRecordHashes()` 補齊。

## Google OAuth App 發布到 Production

Google Cloud OAuth App 若維持 Testing，且使用 `drive.file` 等非 `openid`／`email`／`profile` 的 scope，使用者的 Refresh Token 可能受到測試期限制而週期性失效。這不是 LINE、Queue 或 Drive 資料被刪除；只是需要重新取得授權 Token。

管理者請在 Google Cloud Console 手動完成以下步驟，本專案不會自動修改 Google Cloud 設定：

1. 進入 Google Cloud Console，選擇目前專案 `LINE Google Drive Backup Test`，或實際使用的 Google Cloud 專案。
2. 進入「Google Auth Platform」→「OAuth consent screen」。若介面仍顯示舊名稱，請進入「APIs & Services」→「OAuth consent screen」。
3. 確認 Publishing status 目前是否為 `Testing`。
4. 檢查 App name、User support email、Developer contact information 與 Authorized domains。
5. 檢查 OAuth scopes 至少包含：
   - `openid`
   - `email`
   - `profile`
   - `https://www.googleapis.com/auth/drive.file`
6. 確認沒有誤加入完整 `https://www.googleapis.com/auth/drive` scope；本專案只使用 `drive.file`。
7. 依 Google Cloud Console 顯示的檢查項目完成 App 設定後，選擇「Publish App」將 Publishing status 改為 `Production`。若 Google 要求驗證，依畫面完成，不要用規避方式跳過驗證。
8. 發布後，已經因 Testing 失效的既有使用者仍要在 LINE 私訊輸入 `重新授權` 一次。重新授權會沿用同一 `LineUser_<lineUserHash>` OAuth Service，只更新 OAuth Token，不刪除 Users、Drive、Sheet、群組或備份紀錄。
9. 管理者先用既有帳號測試 `狀態`、`容量`、`紀錄` 與一個小檔案，再讓新使用者測試 `綁定`、文字與檔案備份。

### 發布後固定檢查

在 GAS 更新後，先於 Apps Script 編輯器執行 `testOAuthProductionReadinessChecklist`，依 Logger checklist 確認 scope 與文件提醒；再執行 `testOwnerAuthorizationHealth`。若出現 Review Permissions，完成授權後確認 Logger 有 `PASS testOwnerAuthorizationHealth`，最後測試 LINE `說明`。

## OAuth Token 自動刷新手動測試

Production 發布後，管理者可使用既有使用者的 64 碼小寫 `lineUserHash` 作為測試對象。於 Apps Script「專案設定 → 指令碼屬性」新增 `TEST_LINE_USER_HASH`，值只填入安全雜湊，不要填入原始 LINE userId、Token 或 Email。

1. 先執行 `testOwnerAuthorizationHealth`；若出現 Review Permissions，完成擁有者授權後確認 Logger 顯示 `PASS testOwnerAuthorizationHealth`。
2. 執行全域函式 `testOAuthRefreshForConfiguredUser`。它會查詢 Users、確認 `Enabled=true` 且狀態為 `APPROVED`（舊版空白狀態會相容視為 APPROVED），使用正式 `LineUser_<lineUserHash>` Service，讀取不含 Token 值的 metadata，呼叫 `hasAccess()`、`getAccessToken()`，再沿用容量查詢的 Drive `about.get` helper。
3. 預期成功時 Logger 顯示 `PASS testOAuthRefreshForConfiguredUser`。失敗時只會顯示 `component=oauth-refresh-test`、錯誤碼、Google reason（若有）、HTTP status、Token 是否存在的布林值、雜湊前綴與 correlationId。
4. 需要主動測試 Refresh Token 時，偶爾執行 `testOAuthForceRefreshForConfiguredUser`。此函式只呼叫同一 Service 的 `refresh()`，接著再次呼叫 `about.get`；成功時顯示 `PASS testOAuthForceRefreshForConfiguredUser`。不要頻繁執行，也不要在一般 LINE 指令呼叫。
5. 測試不會由本專案直接寫入或 reset Token，也不會刪除 Users／Drive／Sheet／Groups、重建資料夾或修改設定；OAuth2 Library 依 `hasAccess()`／`refresh()` 的正常流程可能更新授權 Token。測試完成後可刪除 `TEST_LINE_USER_HASH`，避免誤用測試對象。

Google OAuth App 已在 Production 時，新授權通常不再受到 Testing 模式的 7 天限制；但使用者撤銷授權、長期未使用、Refresh Token 數量超限或 Google Workspace 政策仍可能使 Token 失效。若測試確認失效，請讓該使用者在 LINE 私訊輸入 `重新授權`；這只更新同一 OAuth Service 的 Token，不刪除既有 Users、Drive、Sheet 或 Groups。
