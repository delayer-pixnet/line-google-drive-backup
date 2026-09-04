# 專案狀態

最後更新：2026-09-04

目前已加入可選的「自助綁定 + 管理者審核」流程、紀錄查詢中心、傳送者名稱欄位、容量查詢、群組備份清單與補備份流程。本輪新增 OAuth Token 可用性／刷新手動測試，已同步 GAS 並更新既有 Web App 至 `@34`；不建立 Commit 或 Push Git。

## 已完成

- 新增長期固定的 `IDENTIFIER_HASH_SECRET`。Worker 與 GAS 只用它建立 LINE 使用者、群組、邀請、nonce、OAuth Service、Drive 事件與資源的用途隔離 HMAC；`BIND_TOKEN_SECRET` 只簽短效 Bind Token，`WORKER_GAS_SHARED_SECRET` 只簽 Worker→GAS envelope。UTF-8 固定向量與金鑰輪替行為已有 Worker 自動測試及 GAS 手動測試。
- Jobs 使用 `LeaseExpiresAt`。第一次 claim 會建立 600 秒 PROCESSING 租約；有效租約不可重取，GAS 會回 `JOB_IN_PROGRESS` 與剩餘秒數加 5 秒緩衝，Worker 延後 Queue retry 且不 ACK。過期租約與 FAILED Job 可重取並增加 `RetryCount`，且保留既有 `DriveFileId`；COMPLETED、REJECTED、UNSENT 仍安全 ACK。
- 附件以 webhookEventId 的用途隔離 HMAC 作為 Drive `appProperties.lineBackupEventKey`。沒有 Jobs File ID 時會先在同一目標資料夾查詢，找到即回填 File ID，不重新下載或上傳。
- 綁定流程支援 `PENDING`、`AUTHORIZED`、`PROVISIONING`、`COMPLETED`、`FAILED`。Google 授權成功後保留 OAuth Token；Drive／Sheet 初始化可重試並以 `lineBackupResourceKey` 重用部分資源。只有資源與 Users 資料備妥後，才在 Script Lock 內以單一 Sheets API 批次扣除邀請次數、完成 Session、消耗 nonce 並啟用使用者。
- 新增管理者恢復入口 `resumeAuthorizedBinding()`。AUTHORIZED、FAILED 與租約已過期的 PROVISIONING Session 可在不重新消耗邀請碼的情況下恢復；完成後的 callback 會拒絕重播。
- 新增 `ENABLE_PUSH_FALLBACK=false`。所有指令仍經 Queue；只有 LINE 明確回報 Reply Token 無效、GAS 有回覆文字且存在收件者時，才可選擇嘗試 Push。Reply／Push 失敗不會重做備份，一般成功附件不會自動 Push。
- 新增一次性 `HMAC_DIAGNOSTIC_ENABLED`（Worker／GAS 預設 `false`）。診斷只記錄固定格式的短指紋，不輸出 Secret、payload、nonce、Token、URL 或原始識別碼；本輪驗證已關閉。
- GAS `doPost` 只有在 Worker HMAC、timestamp 與 nonce 完整驗證後，才允許寫入 Errors 或更新 Job；未驗證要求只留下不含輸入內容的安全 Console Log。
- 預設單檔上限為 20 MiB；45 MiB 已在設定與操作文件標示為高風險且不保證成功。
- `cleanupExpiredAdminRecords` 只清除過期 Nonces、已過期的 PENDING／COMPLETED BindingSessions、逾期 Errors 與逾期 COMPLETED Jobs；不刪除可恢復 Session、PROCESSING Jobs、Users、Groups、Invitations 或 Drive 檔案。
- 已同步架構、資料流、安全設計、設定範例、LINE／Google／Cloudflare 操作、朋友指南、測試案例、成本配額、故障排除與部署文件。
- 自助綁定可在不輸入邀請碼時建立短效 OAuth 連結；授權與 Drive 初始化完成後，若 `REQUIRE_ADMIN_APPROVAL=true`，Users 會先寫入 `PENDING_APPROVAL`／`Enabled=false`。管理者以 `ADMIN_LINE_USER_HASHES` 白名單執行 `待審核`、`核准 <編號>`、`拒絕 <編號>`；既有 `綁定 <邀請碼>` 流程仍直接核准並保留原有邀請次數規則。
- 未核准且已有 Users 記錄的使用者不會備份私訊內容；群組附件與 `#筆記` 可由任一成員提供，但必須由已核准且啟用的群組 owner 提供目標資源。只有 owner／管理者可解除群組或執行管理指令；個人綁定與審核指令限私訊。Users 新增的 `ApprovalStatus` 會附加在最後一欄，舊版 10 欄資料會安全補欄，不重排既有資料。
- 管理者審核支援 `核准／拒絕 1,2,3` 指定多筆，以及 `核准全部`／`拒絕全部` 的 5 分鐘同管理者二次確認；結果回覆成功、略過與失敗筆數，已核准／已拒絕資料不會重複處理。確認碼只保存雜湊並在成功消耗後刪除。
- 自助綁定依 `REQUIRE_ADMIN_APPROVAL` 分流：`true` 完成 OAuth／Drive 初始化後為 `PENDING_APPROVAL`／停用；`false` 則在同一受鎖完成階段寫入 `APPROVED`／啟用，OAuth 成功頁顯示「Google 授權完成，已啟用備份」。既有邀請碼流程維持直接核准。
- 「說明」依私訊／群組與管理者身分分流；一般使用者不會看到管理者指令，群組只顯示附件、`#筆記`、狀態與權限規則，個人 OAuth 與審核指令均要求私訊。
- 新增 `紀錄`／`查詢紀錄`／`群組紀錄` 查詢中心。Bot 回覆 10 分鐘有效的 GAS shortCode 連結（`route=q&id=短碼`），Script Properties 只保存短碼 HMAC 雜湊；查詢頁讀取授權範圍內的備份 Sheet，群組內不建立查詢連結，結果遮罩識別碼與 Email。
- 備份紀錄 Sheet 現在以標題列名稱對應寫入，新增「傳送者名稱」欄位。既有 Sheet 只會在最右側補上缺少的欄位，不重建、不清空、不重排資料；舊資料可保留空白。Worker 在記憶體內呼叫 LINE Profile／群組成員 Profile／群組摘要 API 後，只將清理過的顯示名稱與 hash 傳入 Queue，失敗時使用 `user_<hash-prefix>` 或 `unknown_user`。
- 查詢中心結果新增「傳送者名稱」，關鍵字可搜尋傳送者名稱、群組名稱、原始檔名、文字內容、網址與標籤；不輸出 raw LINE userId、groupId、Email、Token 或 Secret。
- 新增私訊 `容量`、`空間`、`Drive容量` 與 `群組容量`。GAS 以使用者自己的 `drive.file` OAuth Token 呼叫 Drive quota API，遞迴估算備份 root／個人／群組資料夾與 Sheet 的檔案大小；結果以 `lineUserHash` 快取 600 秒。群組內只提示改用私訊，不公開 owner 容量。
- `說明` 已依私訊一般使用者、管理者與群組情境分流；一般說明涵蓋綁定、個人備份、紀錄、容量、群組規則及 20 MB 限制，管理者指令僅管理者可見，群組不顯示 OAuth／查詢連結或審核操作。
- 群組摘要（`備份清單`、`今日備份清單`、`本週備份清單` 與月份格式）現在是群組層級唯讀功能；所有群組成員均可查詢，不要求發話者個人綁定、核准或 owner 身分。摘要查詢失敗時會回覆安全提示，不再因 Queue retryable 分支而靜默無回應；安全記錄只包含摘要指令、雜湊前綴、權限布林值與 correlationId。
- 群組摘要最新紀錄會顯示 Asia/Taipei 的 `MM/dd HH:mm`、傳送者名稱，以及無原始檔名圖片的穩定 `image_yyyyMMdd_HHmmss_<hash-prefix>.jpg` 顯示名稱；群組摘要仍不公開 Drive URL、查詢中心 URL 或完整 File ID。
- 新增 `testOwnerAuthorizationHealth` 部署後授權健康檢查：只讀取必要設定、管理 Sheet、受控外部請求與執行環境資訊，不寫入備份、不呼叫 LINE、不建立 OAuth／Drive 資源；授權完成時記錄 `PASS testOwnerAuthorizationHealth`。
- 容量查詢與狀態／個人備份共用使用者綁定狀態。`Enabled=true` 且舊資料 `ApprovalStatus` 空白會相容視為 `APPROVED`；缺少 OAuth Token、授權不足與暫時錯誤分別回覆安全訊息並以 `drive-quota` 欄位記錄診斷。提供管理者手動 `migrateEnabledUsersToApproved`，只補齊既有啟用使用者。
- OAuth Service 名稱集中為 `LineUser_<lineUserHash>`，容量、紀錄、個人備份與 Drive 初始化共用 `getUserAccessToken_()`；新增 `oauth-token` 安全診斷與私訊 `重新授權`。重新授權只更新同一 Google 帳號的 OAuth Token，重用既有 Users、Drive、Sheet 與群組資料；不同 Google 帳號會遭拒絕。
- 新增 `testOAuthProductionReadinessChecklist`，只檢查 OAuth Client 設定是否存在、使用者 scope 是否包含 `drive.file`、是否保留 `重新授權`，並以 Logger 提醒管理者確認 Google Auth Platform 的 Publishing status。Testing 模式可能造成 Drive scope 的 Refresh Token 週期性失效；Production 發布後，既有失效帳號仍需重新授權一次。
- 新增管理者手動 `testOAuthRefreshForConfiguredUser` 與 `testOAuthForceRefreshForConfiguredUser`：從 `TEST_LINE_USER_HASH` 取得 64 碼雜湊，沿用正式 `LineUser_<lineUserHash>` OAuth Service 與容量 `about.get` helper，安全驗證 Token metadata、`hasAccess()`、一般自動刷新及主動 `refresh()`；不輸出 Token、不 reset、不刪除或重建 Users／Drive／Sheet／Groups。
- 私訊新增 Worker 層級 `系統狀態`／`系統診斷`；Queue consumer 直接回覆 Worker、Queue 與最近 GAS 呼叫摘要，不依賴 GAS。GAS 403 HTML 或無 JSON 的典型錯誤會以 Reply API 提醒管理者執行 `testOwnerAuthorizationHealth`，不會改用 Push 或重做備份。
- 私訊 `狀態` 會以共用 `LineUser_<lineUserHash>` OAuth Service 顯示 `hasAccess()`、Access Token 剩餘時間（可取得時）、Refresh Token 是否存在、檢查時間與最多 10 個管理中群組名稱；群組內 `狀態` 維持只顯示綁定狀態。
- 已將 Token 失效與未綁定訊息分離：已有 Users 但 OAuth Token 不可用時提示「重新授權」，沒有 Users 記錄時提示「綁定」；重新授權不刪除或重建既有資料。
- 新增群組 owner／管理者限定的 `補備份` 與私訊 `群組補備份`。GAS 從 owner 備份 Sheet、Jobs 與既有安全 metadata 篩選已收到 webhook 的失敗／未完成項目，建立 `ReplayRequests` 稽核列並以 `RETRY_REQUESTED` 狀態送入 Worker `/internal/replay`；沿用原有租約、Drive appProperties 與去重保護。
- 補強 OAuth Token 失效處理：`hasAccess()`、Token 讀取失敗及 Drive／Sheets 401／403 `insufficientPermissions` 會把已 claim 工作標為 `OAUTH_REAUTH_REQUIRED`，保留安全 Jobs metadata 並立即以 Reply API 提醒重新授權；群組提醒以 hash 快取 30 分鐘冷卻。
- 私訊 `補備份 今日` 可在重新授權後重送個人附件；群組仍使用 `群組補備份`。沒有成功保存原文的私人文字／`#筆記` 不會將完整內容寫入管理 Jobs，會安全略過。
- OAuth Token 失效時，已啟用使用者的附件與群組 owner 附件／`#筆記` 不再靜默丟棄；Jobs 會保留事件、訊息、類型、檔名、時間與安全雜湊 metadata，狀態為 `OAUTH_REAUTH_REQUIRED`，並以 Reply API 提示重新授權與補備份方式。群組相同 owner 授權錯誤以 `groupIdHash + errorCode` 快取 30 分鐘，避免洗版。
- `getUserAccessToken_()`、容量、紀錄、個人備份與 Drive 初始化共用 `LineUser_<lineUserHash>` OAuth Service；Token 讀取／刷新失敗會帶安全 correlationId，Drive／Sheets 401／403 `insufficientPermissions` 也會進入待重新授權流程。
- 私訊 `補備份 今日` 會處理 `OAUTH_REAUTH_REQUIRED`、`RETRY_REQUESTED_PENDING_REAUTH`、`FAILED`、`PENDING`、`PROCESSING_TIMEOUT` 與 `RETRYABLE` 的附件；已完成、缺少 messageId、LINE Content 已不可下載或未保存原文的項目會安全略過，不會抓取 LINE 歷史紀錄。

## 本機驗證

- `npm run typecheck`：成功，TypeScript strict 無錯誤。
- `npm run lint`：成功，ESLint 無錯誤。
- `npm test`：成功，8 個 test files、119 個 tests 全部通過；新增群組摘要指令在所有成員情境均排入可回覆工作，以及補強群組摘要日期、權限與圖片顯示名稱測試。Coverage statements 85.11%、branches 83.01%、functions 94.36%、lines 85.07%。
- Coverage：statements 85.11%、branches 83.01%、functions 94.36%、lines 85.07%。`gas-client.ts`、`line-client.ts`、Queue retry／ack、Profile fallback、指令解析、Bind Token 與補備份端點均有測試。
- `npm run build`：成功，Wrangler dry-run bundle 38.75 KiB、gzip 9.19 KiB；本輪正式部署版本為 `387007d5-d5bb-4d7c-aa67-22f24615cb51`。
- `npm audit --audit-level=high`：發現 1 個 `nanoid` high advisory（由 Vitest／Vite 開發相依套件帶入）；不在 Worker runtime bundle，已記錄於 `docs/KNOWN_ISSUES.md`，本輪不做 breaking 或無關依賴升級。
- GAS 語法：22 個 `.gs` 以 Node.js `vm.Script` UTF-8 parser 全部通過；另有 3 個 HTML 與 `appsscript.json`，已以 clasp 推送 26 個檔案並更新既有 Web App 至 `@31`。
- JSON／JSONC：`appsscript.json`、`script-properties.example.json`、`package.json`、`package-lock.json`、`.clasp.json.example` 解析成功；`wrangler.jsonc.example` 的格式、`GAS_REQUEST_TIMEOUT_MS=55000`、`max_retries >= 5` 與 DLQ 設定均驗證成功。
- Secret 掃描：10 類高風險憑證格式為 0 命中；Repository 內沒有正式 `.env`、`.dev.vars`、`wrangler.jsonc`、`.clasp.json` 或 `.clasprc.json`。
- 文件：19 份 Markdown 的相對連結檢查通過；已補充一次性 HMAC 診斷開關與關閉流程。
- Worker 部署：`/health` 回 HTTP 200 與 `{"status":"ok"}`；Queue producer／consumer 維持 `line-google-drive-backup` 與 DLQ 設定。GAS `WORKER_REPLAY_ENDPOINT` 尚需由管理者依實際 Worker URL 填入，未由本輪自動設定。
- Git：本輪不建立 Commit、不 Push；保留既有 `main` 分支與工作區中使用者原有的 untracked 檔案。

Wrangler dry-run 以明確 `src/index.ts` 入口驗證 bundle，因此顯示 `No bindings found`；正式人工測試部署時才會複製 `wrangler.jsonc.example` 為被忽略的 `wrangler.jsonc`，由 Wrangler 載入 Queue bindings。Vitest 與 Wrangler 在 Windows 沙箱內因暫存檔／診斷 Log 權限遇到 `EPERM`，改在獲准的沙箱外執行後均通過。

## 尚需人工完成

- 在專用測試管理 Sheet 執行 `TEST_CASES.md` 列出的 GAS TestFunctions，尤其是 `testOwnerAuthorizationHealth`、`testOAuthServiceConsistency`、`testOAuthTokenAvailableForConfiguredUser`、`testDriveQuotaHelpers`、`testDriveQuotaUserBindingCompatibility`、已綁定／未綁定容量查詢、403 `insufficientPermissions`、備份資料夾遞迴估算與 600 秒快取，以及原有租約、Drive 冪等與 OAuth 恢復測試。
- 以測試帳號手動驗證 `REQUIRE_ADMIN_APPROVAL=false` 的自助 OAuth 成功頁與立即備份，並測試 `紀錄` 查詢頁的日期／關鍵字／類型篩選、過期連結與跨使用者拒絕。
- 用管理者測試帳號驗證 OAuth2 Library state、Google `handleCallback`、Sheets API 最終批次、`drive.file` 對應用程式建立之 Sheet 的存取，以及 `resumeAuthorizedBinding()` 恢復流程。
- 建立測試用 LINE、Google、Apps Script 與 Cloudflare 資源後，驗證 Queue retry／DLQ、PROCESSING 租約逾期回收、Drive appProperties 查找、Reply Token 逾期、可選 Push，以及一般群組 owner 與多帳號 Drive 隔離。
- 正式提供朋友使用前，先由管理者自己完成小檔端對端測試、撤銷／重綁與錯誤復原演練；不要一開始就提高到 45 MiB。

## 部署判斷

自助綁定、群組權限、角色化說明、紀錄查詢中心、傳送者名稱欄位、容量查詢、重新授權、群組備份清單與補備份程式已完成本機驗證。GAS 已同步 26 個檔案，既有 Web App 已更新至 `@34`；Worker 已部署版本 `387007d5-d5bb-4d7c-aa67-22f24615cb51`，`/health` 回 HTTP 200。`HMAC_DIAGNOSTIC_ENABLED` 維持 `false`；`WORKER_REPLAY_ENDPOINT` 尚須由管理者依文件設定，未在本輪寫入任何 Script Property、Secret 或邀請碼。

## 群組備份清單功能（本輪）

- 新增群組 `備份清單`、`今日備份清單`、`本週備份清單`、月份／年月格式查詢，以及私訊 `群組紀錄` 完整查詢流程。
- 備份紀錄 Sheet 新增「群組識別」安全 HMAC 欄位；舊 Sheet 只在最右側補欄，新資料依標題名稱寫入。
- Worker 本機測試目前 108 tests 全部通過；GAS 20 個 `.gs` 已通過 Node.js `vm.Script` 語法檢查。已同步 GAS 24 個檔案、更新既有 Web App 至 `@24`，並部署 Worker 版本 `30744b55-9a82-4c97-9f6d-b0691b8259d6`；`/health` 回 HTTP 200 與 `{"status":"ok"}`。

## 群組紀錄短連結與舊資料相容（本輪）

- `群組紀錄` 與個人 `紀錄`／`查詢紀錄` 改由 GAS 產生 10 碼隨機 shortCode，LINE 回覆只含 `/exec?route=q&id={shortCode}`；短碼雜湊、期限、scope 與查詢條件留在 GAS Script Properties，完整長 Token 不再由 Bot 產生。
- 群組完整查詢仍優先比對「群組識別」。舊列若識別空白，僅在 owner／管理者、owner Sheet、來源類型為 group、群組名稱唯一一致時 fallback；不確定或同名資料會拒絕。
- 新增管理者手動函式 `migrateLegacyGroupRecordHashes()`，只補唯一可判斷的舊列，不刪除或重建資料。

## 群組補備份（本輪）

- 新增群組 `補備份 今日`、日期／月份／區間格式，以及 owner／管理者私訊 `群組補備份` 與安全群組代號選擇。
- 補備份只從 owner 備份 Sheet、Jobs 與既有安全 metadata 找出 Bot 曾收到且尚未完成的工作；不抓 LINE 歷史訊息、不在群組公開 Drive URL。
- 新增 GAS `ReplayService.gs`、管理 Sheet `ReplayRequests` 與 Worker `POST /internal/replay` HMAC 端點；候選工作以 `RETRY_REQUESTED` 分批送入主 Queue，沿用原有租約、Drive appProperties 與去重流程。
- 本輪 Worker／GAS 變更已完成本機測試、GAS 同步、Web App `@28` 更新與 Worker 部署；管理者仍須在 Apps Script 執行 `testOwnerAuthorizationHealth`，並依文件填入 `WORKER_REPLAY_ENDPOINT` 後，才能進行實際補備份端對端測試。
