# 故障排除

先判斷問題在哪一層：LINE Verify → Worker webhook → Queue → GAS 驗證 → OAuth → LINE Content → Drive → Sheets。不要為了除錯輸出 Token、Secret、完整 webhook 或附件內容。

| 現象 | 可能原因 | 安全檢查與修正 | 預期修復結果 |
|---|---|---|---|
| Worker `/health` 404 | URL 錯誤或未部署最新版 | 確認是 Worker URL 加 `/health`，重新檢查 deployment | 回 200 `status=ok` |
| LINE Verify 401 | Channel Secret 不同或 webhook URL 錯 | 重新 `wrangler secret put LINE_CHANNEL_SECRET`，URL 必須是 `/webhook` | Verify Success |
| LINE Verify 503 | Queue binding／主 Queue 不存在 | 對照 `BACKUP_QUEUE` 與 Queue 名稱，檢查部署 bindings | webhook 回 200 |
| Verify 成功但沒有工作 | Use webhook 未開、事件不支援 | 開啟 Use webhook；群組一般文字本來就會忽略 | 支援事件出現在 Queue |
| Queue 一直重試 | GAS URL、HMAC Secret、GAS 5xx 或逾時 | 看安全 errorCode；核對兩端 Secret，不要把值印出來 | Jobs 轉 COMPLETED，Queue 清空 |
| 工作進 DLQ | `max_retries=5` 已耗盡，或外部錯誤持續超過可恢復期間 | 先修正根因，再小量重送；確認主 Queue 與 DLQ 設定一致，不要直接全部重播 | 新工作成功且 DLQ 不再增加 |
| GAS `SIGNATURE_INVALID` | `WORKER_GAS_SHARED_SECRET` 不一致 | 在 GAS Properties 與 Wrangler 重新輸入同一新值 | 下一筆請求通過 |
| GAS `NONCE_REPLAYED` | Queue 重放同一 envelope 或惡意重播 | 正常 Consumer 每次重試會建新 envelope；檢查是否有代理快取／自訂重送 | 新 nonce 可通過 |
| Worker 與 GAS 的 lineUserHash 不一致 | `IDENTIFIER_HASH_SECRET` 不同，或誤用 `BIND_TOKEN_SECRET` 建立識別雜湊 | 不要輸出 Secret 或原始 LINE userId；重新核對兩端 `IDENTIFIER_HASH_SECRET` 是否為同一值，並執行 UTF-8 HMAC 固定向量測試 | 同一合成輸入在兩端得到相同 64 位小寫 hex |
| 綁定邀請碼無效 | 格式、期限、次數或 `IDENTIFIER_HASH_SECRET` 問題 | 看 Invitations 的 Enabled／MaxUses／UsedCount／ExpiresAt；不要把原碼寫入 Sheet。正式資料建立後不可用直接輪替 `IDENTIFIER_HASH_SECRET` 當作修復方式 | 新的獨立邀請碼可用 |
| 綁定連結立即過期 | 伺服器時間、Token 過期、BindingSessions 缺列、`BIND_TOKEN_SECRET` 或 `IDENTIFIER_HASH_SECRET` 不同 | 核對 Asia/Taipei 時間、兩端相應金鑰與 BindingSessions；頁面重新整理本身不會消耗 nonce | 顯示授權按鈕 |
| Google `redirect_uri_mismatch` | 使用 `/exec` 或 Deployment ID | Client redirect 改為 `/macros/d/<SCRIPT_ID>/usercallback` | 進入 consent screen |
| Google App blocked／無法存取 | 使用者不在 Test users、Workspace 管理政策 | 將指定朋友加入測試清單，或請其組織管理者依政策處理 | 指定帳號可看到 consent |
| 約 7 天後需重綁 | External OAuth App 仍是 Testing | 依 Google 政策評估 Production／驗證；測試期先重綁 | Refresh Token 可按預期持續 |
| OAuth callback 失敗 | Client ID／Secret 錯、Library 缺少、state／BindingSession 無效或 callback 已重送 | 核對 Script Properties、OAuth2 identifier `OAuth2`、版本與 callback；不要輸出 state 或 nonce | 首次 callback 進入授權／初始化；完成後重送安全拒絕 |
| Google 已授權但初始化失敗 | Drive／Sheets 配額、暫時性 API 錯誤或 Apps Script 中止 | 先排除外部錯誤；確認 BindingSessions 為 `AUTHORIZED`、`PROVISIONING` 或 `FAILED`。暫設 `BINDING_RECOVERY_LINE_USER_HASH` 為該列 64 位雜湊後，無參數執行 `resumeAuthorizedBinding` | 重用部分資源並完成 Users；暫存 Property 自動刪除，邀請只扣 1 次 |
| 需要讓失敗綁定重新授權 | 測試部署期 OAuth Service 內仍保留失敗授權 Token | 管理者暫設 `BINDING_RECOVERY_LINE_USER_HASH` 為 64 位雜湊，手動執行 `clearOAuthTokenForRecoveryLineUserHash`；執行後 Property 會自動刪除，未完成 BindingSessions 會標示 `FAILED` | 該使用者可用新的綁定流程重新授權；不刪 Users、Groups、Invitations 或 Drive 檔案 |
| OAuth 取消或初始化失敗但邀請次數減少 | 使用舊版流程或 Invitations 被人工修改 | 更新至目前版本並核對 BindingSessions；目前只在資源與 Users 備妥後的最後受鎖階段增加 UsedCount | 取消／初始化失敗不扣次數，完成只扣 1 次 |
| 私訊附件說未綁定 | Users disabled 或 OAuth Token 已撤銷 | 私訊 `狀態`，重新用新邀請碼綁定 | Users Enabled=true |
| 自助綁定後無法備份 | Users 的 `ApprovalStatus=PENDING_APPROVAL` 或 `REJECTED` | 請管理者用「待審核」取得安全化代號，再私訊 Bot 輸入「核准 <編號>」；核准前內容不會保存 | Users 為 `APPROVED` 且 `Enabled=true` |
| `REQUIRE_ADMIN_APPROVAL=false` 仍顯示等待審核 | GAS Web App 尚未更新到支援自動核准的版本，或 Property 值含空白／拼字錯誤 | 確認 Script Property 精確為 `false`，再更新既有 Web App deployment；不要修改 Users 既有核准狀態 | 新的自助 OAuth 完成頁顯示「Google 授權完成，已啟用備份」，Users 為 APPROVED／Enabled=true |
| `紀錄` 沒有查詢連結 | 使用者尚未綁定／啟用，或在群組內輸入 | 私訊 Bot 輸入 `紀錄`；確認 Users 已核准且 SheetId 存在。群組只能改用私訊 | 回覆 10 分鐘有效的查詢中心連結 |
| 查詢連結已過期或顯示無效 | 超過 10 分鐘、shortCode 被竄改、nonce 已清理或非原使用者／群組使用 | 回 LINE 私訊重新輸入 `紀錄` 或 `群組紀錄`；不要轉貼舊連結，也不要手動修改 Script Property | 顯示重新取得短連結的安全訊息 |
| 管理者指令被拒絕 | `ADMIN_LINE_USER_HASHES` 未包含指令者的 64 位雜湊，或設定格式錯誤 | 只核對管理 Sheet 的 `LineUserHash` 雜湊，不要輸入或記錄原始 LINE userId | 「待審核」可列出安全化代號 |
| 批次審核確認失敗 | 確認碼過期、已使用、操作類型不符或由其他管理者輸入 | 重新輸入 `核准全部`／`拒絕全部` 取得新確認碼，並由同一管理者在 5 分鐘內輸入對應確認指令 | 回覆「確認碼無效、已過期或不屬於目前管理者」 |
| 附件下載 401／404 | LINE Token 錯、messageId 已失效 | 更新 GAS `LINE_CHANNEL_ACCESS_TOKEN`；不要重用很舊事件 | 新附件可下載 |
| 大檔經常逾時 | Apps Script 記憶體／執行時間或網路 | Worker 與 GAS 預設維持 20 MiB；45 MiB 屬高風險且不保證成功 | 小檔穩定完成 |
| Drive 建檔但 Sheet 無列 | Sheets API／配額在上傳後失敗 | Jobs 應保留 DriveFileId；修復 API 後讓 FAILED 工作重試 | 重用檔案 ID，不重複上傳 |
| Job 長時間停在 `PROCESSING` | Apps Script 逾時／中止，或租約尚未到期 | 查看 Worker 是否收到 `JOB_IN_PROGRESS`。租約有效時應依 `retryAfterSeconds` 延後且不可 ACK；預設租約 600 秒。不要手動清空 DriveFileId，也不要刪除 `PROCESSING` 列 | 原程序完成後重送 ACK；若中止，租約過期後重取並增加 RetryCount |
| Worker 顯示 `GAS_NETWORK_ERROR`，但 GAS 仍在執行 | Worker 55 秒 timeout 先到；Apps Script 不一定同步停止 | 不要手動重送或把 Job 改成 FAILED。讓 Queue 重送；有效租約會回 `JOB_IN_PROGRESS` 並延後至租約到期後 | 不會 ACK 掉唯一工作，也不會在有效租約內重做 |
| Drive 出現重複檔案 | 舊版檔案沒有 `lineBackupEventKey`、目標資料夾錯誤，或 Drive API 查詢失敗 | 檢查同一事件的檔案是否在正確目標資料夾且 appProperties 有相同鍵；新版重試會先查詢並重用 File ID。不要只依檔名或未確認事件批次刪除 | Jobs、Sheet 與單一 Drive File ID 對應一致 |
| `容量` 回覆「請先完成 Google 帳號綁定」 | Users 不存在、未核准或 Enabled=false | 私訊完成 Google OAuth，並確認管理者已核准（若啟用審核） | 可查詢自己的 Drive 與備份資料夾容量 |
| GAS Web App 回 HTTP 403 HTML、LINE 指令無回覆 | 擁有者尚未完成 Apps Script 授權、Web App 非匿名存取或 Worker 的 GAS endpoint 不是目前啟用的 `/exec` | 每次同步並更新 Web App 後，先執行 `testOwnerAuthorizationHealth`；若出現 Review Permissions，完成授權後確認 Logger 顯示 PASS，再逐字核對 Cloudflare `GAS_ENDPOINT_URL`（不可使用 `/dev`） | GAS Executions 出現新的 `doPost`，Worker 不再記錄 `GAS_HTTP_ERROR` |
| `容量` 回覆「Google 授權已失效」 | OAuth Service `LineUser_<lineUserHash>` 沒有可用 Token，或 Token 無法刷新 | 私訊輸入 `重新授權`，選擇原本綁定的 Google 帳號；不要輸入 `解除綁定`，也不要在 Log 或聊天貼 Token | 既有 Users、Drive、Sheet、群組資料保留，重新授權後可重新查詢 |
| `容量` 回覆「目前 Google Drive 授權不足」 | Drive `about.get` 回傳 403 `insufficientPermissions` | 私訊輸入 `重新授權` 取得新的 `drive.file` 授權；不要在 Log 或聊天貼 Token | 授權恢復後可重新查詢 |
| `容量` 回覆暫時無法取得 | Drive API 逾時、429、5xx 或資料夾掃描失敗 | 稍後重試；檢查安全 Log 的 `component=drive-quota`、`errorCode`、`correlationId` | 不會輸出容量 API 原始回應或檔案 ID |
| 群組輸入 `容量` 沒有數字 | 群組禁止公開 owner 的個人容量 | 私訊 Bot 輸入 `容量`；要查群組資料夾則私訊輸入 `群組容量` | 群組只收到改用私訊的提示 |
| `DRIVE_IDEMPOTENCY_SEARCH_FAILED` | Drive `files.list` 回傳 400／401／403／5xx、OAuth 權限不足或查詢格式錯誤 | 查看 GAS 安全 Log 的 `httpStatus`、`googleReason`、`googleDomain`、`googleMessageSummary` 與 `correlationId`；不得記錄完整 q、File ID 或 Token。確認 `drive.file` 授權與目標資料夾仍由本應用程式建立 | 200 且 `files=[]` 會建立新資料夾；非 2xx 會保留 FAILED BindingSession，可執行 `resumeAuthorizedBinding` |
| 群組一般聊天沒保存 | 這是設計行為 | 使用 `#筆記` 或明確提及 Bot | owner Sheet 新增列 |
| `綁定群組` 說 owner 未綁定 | 指令者尚未完成個人 OAuth | 私訊完成綁定，再回同一群組執行 | Groups Enabled=true |
| 新 owner 無法接管 | 舊 owner 尚未解除 | 原 owner 執行 `解除群組`；若失聯由管理者核對後停用該 Groups 列 | 新 owner 可綁定 |
| 群組一般成員傳附件被拒絕 | 群組 owner 尚未核准、未綁定或群組已停用 | 由 owner 完成個人 OAuth 並取得管理者核准；一般成員不需要個人綁定 | 附件進入 owner Drive |
| 「傳送者名稱」顯示 `user_<hash>` | LINE Profile／群組成員 Profile API 失敗、權限不足或暫時逾時 | 不需重送備份；確認 LINE Channel Access Token 與 API 權限，名稱欄位失敗不影響 Drive／Sheet 備份 | 下一筆可取得 displayName；既有 fallback 名稱保留 |
| 舊紀錄 Sheet 沒有「傳送者名稱」欄 | 舊版 Sheet 標題列缺少新欄位 | 讓下一次初始化或備份流程執行 `ensureBackupSheetHeaders_`；程式只在最右側補欄，不重建 Sheet | 舊資料保留，新資料依標題名稱寫入 |
| 群組成員執行 `解除群組` 被拒絕 | 非 owner 且非管理者 | 請 owner 或管理者執行；一般成員不可接管或解除 | Groups 不被修改 |
| 群組出現審核／綁定連結 | 個人綁定或管理者指令誤在群組輸入 | 個人綁定與管理者審核請改用私訊；群組 `狀態` 只顯示群組綁定狀態 | 不公開 OAuth 連結、不執行審核 |
| 備份或指令成功但無 LINE 回覆 | 所有指令都經 Queue，Reply Token 在處理後過期 | 先看 Drive／Sheet 與 Jobs，無需重傳。預設 `ENABLE_PUSH_FALLBACK=false`；若需補送，評估訊息用量後才設 `true` | 資料仍為 COMPLETED；明確 Token 無效時可選擇 Push |
| Reply 失敗後仍未收到 Push | fallback 關閉、LINE 錯誤不是 Token 無效、沒有收件者，或 Push API 失敗 | 核對 Worker 非 Secret var 與安全 errorCode；不要為了回覆失敗重播備份。Push 可能計入 LINE 官方帳號訊息用量 | 符合條件時 Push 成功；不符合時保持不補送且工作仍完成 |
| `unsend` 沒刪 Drive | 預設 `DELETE_DRIVE_ON_UNSEND=false` | 這是資料保護預設；需要時先評估再改 `true` | false 只標記、true 嘗試刪除 |
| 管理 Sheet 標頭錯誤 | 手動改名、搬欄或舊版本 | 先備份，再恢復 `UserRepository.gs` 定義的精確欄位順序 | 初始化函式通過 |
| Properties quota exceeded | 使用者過多或 Token 資料累積 | 停止邀請新使用者，解除不用帳號；長期改外部加密儲存 | OAuth refresh 恢復 |
| 管理 Sheet 持續增大 | 未定期清理 Nonces、BindingSessions、Errors 或已完成 Jobs | 設定保留天數後手動執行 `cleanupExpiredAdminRecords`；不可刪 Users、Groups、Invitations 或 Drive 檔案 | 執行記錄只顯示安全的刪除筆數 |

| 群組輸入「備份清單」格式錯誤 | 月份不在 1～12、日期格式不是支援格式，或指令在私訊使用 | 使用 `備份清單`、`今日備份清單`、`本週備份清單`、`8月備份清單` 或 `2026年8月備份清單`；摘要指令請在群組輸入 | 顯示安全格式提示，不產生查詢連結 |
| 群組摘要查無資料 | 日期範圍沒有成功／已備份紀錄，或舊資料缺少安全群組識別 | 確認新版本已讓 Sheet 最右側出現「群組識別」；不要用 raw groupId 補欄 | 顯示「查無此期間的群組備份紀錄。」或安全舊資料提示 |
| `群組紀錄` 沒有連結 | 要求者不是群組 owner／管理者、群組代號錯誤，或 owner 尚未啟用 | 先私訊 `群組紀錄` 取得安全代號；owner 再輸入 `群組紀錄 YYYY-MM g_xxxxxxxx` | 只在授權範圍內產生 10 分鐘查詢連結 |
| 群組完整查詢顯示舊紀錄識別不足 | 舊列的「群組識別」空白，且同一 owner 有同名群組或無法確認唯一性 | 只在 owner／管理者查詢 owner Sheet；確認唯一後可執行 `migrateLegacyGroupRecordHashes()`，不要手動填 raw groupId | 唯一條件成立時顯示相容提示；否則顯示「舊紀錄缺少群組識別，且群組名稱無法唯一確認，請僅查詢新版本後的群組紀錄。」 |

每次 GAS 同步與 Web App 更新後，固定先執行 `testOwnerAuthorizationHealth`；若出現 Review Permissions，完成授權並確認 `PASS testOwnerAuthorizationHealth`，再依序測試 LINE 私訊 `說明`、群組 `說明` 與 `備份清單`。不要直接以 Queue 重送取代授權健康檢查。

## 安全地收集診斷資料

遇到 GAS `SIGNATURE_INVALID` 時，先確認兩端 `WORKER_GAS_SHARED_SECRET` 完全相同。若仍無法判斷，才在 Worker 與 GAS 同時暫時設定 `HMAC_DIAGNOSTIC_ENABLED=true`，執行一次受控的「說明」測試。安全 Log 只會出現固定長度的 Secret／signing input／Signature 指紋與 Script ID 尾碼，不會出現 Secret、payload、nonce、Token、GAS URL、LINE userId 或完整 Signature。完成比對後，立即將 GAS Property 與 Worker var 改回 `false` 並重新更新／部署；不要長期啟用，也不要把 Log 公開。

可以提供：時間（Asia/Taipei）、元件、errorCode、截短的 correlationId、HTTP 狀態與是否可重現。不要提供：Authorization header、Channel Secret、Access／Refresh Token、OAuth Client Secret、完整 Apps Script／Worker URL、原始 LINE userId／groupId、邀請碼、訊息內容或附件。
