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
4. 預期左側檔案清單可看到 `Main.gs`、`OAuth.gs`、各 Service／Repository、2 個 HTML 與 `appsscript.json`。

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
| `DELETE_DRIVE_ON_UNSEND` | `false` 或 `true`，建議先用 `false` | 否 | 範例可、正式設定不提交 | 設為其他值會視為不刪除 |
| `ERROR_RETENTION_DAYS` | 正整數天數，預設 `30`，允許 1 至 3650 | 否 | 範例可、正式設定不提交 | 未設定時用 30 天；格式無效時清理函式拒絕執行 |
| `COMPLETED_JOB_RETENTION_DAYS` | 正整數天數，預設 `90`，允許 1 至 3650 | 否 | 範例可、正式設定不提交 | 未設定時用 90 天；格式無效時清理函式拒絕執行 |
| `JOB_PROCESSING_LEASE_SECONDS` | 正整數秒數，預設 `600`，允許 60 至 3600 | 否 | 範例可、正式設定不提交 | 未設定時用 600 秒；過短會造成尚在處理的工作被重取，格式無效時拒絕處理 |

`script-properties.example.json` 列出 13 個完整範例名稱，可用來逐項核對，但不可直接填入真實值後提交。`WORKER_GAS_SHARED_SECRET`、`BIND_TOKEN_SECRET` 與 `IDENTIFIER_HASH_SECRET` 必須三者不同。可用密碼管理器產生高熵值；不要把產生指令輸出貼入文件或終端紀錄截圖。

`IDENTIFIER_HASH_SECRET` 是永久資料關聯的一部分。首次正式上線後不可直接更換；它同時影響 Users、Groups、Invitations、Nonces、BindingSessions、OAuth Service 名稱與 Drive `lineBackupEventKey`。若日後確實需要輪替，必須另行設計資料與 Token 遷移，不能只替換 Property。

輪替 `BIND_TOKEN_SECRET` 只會讓尚未完成的舊 Bind Token 失效，不會改變既有 lineUserHash；輪替 `WORKER_GAS_SHARED_SECRET` 只影響 Worker envelope 驗證。兩端更新金鑰時仍應安排一致的切換時點，避免短暫驗證失敗。

## 4. 初始化管理工作表

1. 在編輯器選 `initializeAdminSpreadsheet` 並按 Run。
2. 第一次執行會要求管理者授權 Apps Script 存取管理 Sheet 與外部請求；檢查權限後允許。
3. 預期管理 Sheet 時區設為 `Asia/Taipei`，並出現 Users、Groups、Invitations、Jobs、Nonces、BindingSessions、Errors，共 7 個工作表；第一列凍結並符合欄位名稱。Jobs 必須包含 `LeaseExpiresAt`；BindingSessions 必須包含 `UpdatedAt` 與 `FailureCode`。
4. 若顯示 `ADMIN_HEADERS_MISMATCH`，不要直接覆蓋；先確認是否使用舊版本管理表並備份資料。

本版新增或需特別核對的完整欄位順序：

- Jobs：`WebhookEventId`、`MessageId`、`Status`、`RetryCount`、`LeaseExpiresAt`、`DriveFileId`、`ErrorCode`、`ErrorMessage`、`CreatedAt`、`UpdatedAt`。
- BindingSessions：`SessionNonceHash`、`LineUserHash`、`InviteCodeHash`、`ExpiresAt`、`UsedAt`、`Status`、`CreatedAt`、`UpdatedAt`、`FailureCode`。

不要手動插入、改名或搬動欄位。Job 進入 `PROCESSING` 時 `LeaseExpiresAt` 應有值；完成、失敗或拒絕後會清空。下載完成、Drive 上傳完成及寫入 Sheet 前後會延長租約。

## 5. 部署 Web App

1. Deploy → New deployment → Web app。
2. Execute as 選 Me／部署者；Who has access 選 Anyone。公開入口仍受 HMAC 保護。
3. 按 Deploy，完成管理者授權。預期取得以 `/exec` 結尾的 Web App URL。
4. 把該 URL 設到 Script Property `APP_BASE_URL`，並稍後設為 Cloudflare `GAS_ENDPOINT_URL`。不要 Commit。
5. 瀏覽 `/exec`，預期只看到 `{"status":"ok"}`，不會顯示設定值。
6. 每次改 GAS 程式後需建立新版本或編輯 deployment 指向新版本；只儲存編輯器不會更新既有 deployment。

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
