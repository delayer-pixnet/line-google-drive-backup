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
| OAuth 取消或初始化失敗但邀請次數減少 | 使用舊版流程或 Invitations 被人工修改 | 更新至目前版本並核對 BindingSessions；目前只在資源與 Users 備妥後的最後受鎖階段增加 UsedCount | 取消／初始化失敗不扣次數，完成只扣 1 次 |
| 私訊附件說未綁定 | Users disabled 或 OAuth Token 已撤銷 | 私訊 `狀態`，重新用新邀請碼綁定 | Users Enabled=true |
| 附件下載 401／404 | LINE Token 錯、messageId 已失效 | 更新 GAS `LINE_CHANNEL_ACCESS_TOKEN`；不要重用很舊事件 | 新附件可下載 |
| 大檔經常逾時 | Apps Script 記憶體／執行時間或網路 | Worker 與 GAS 預設維持 20 MiB；45 MiB 屬高風險且不保證成功 | 小檔穩定完成 |
| Drive 建檔但 Sheet 無列 | Sheets API／配額在上傳後失敗 | Jobs 應保留 DriveFileId；修復 API 後讓 FAILED 工作重試 | 重用檔案 ID，不重複上傳 |
| Job 長時間停在 `PROCESSING` | Apps Script 逾時／中止，或租約尚未到期 | 查看 Worker 是否收到 `JOB_IN_PROGRESS`。租約有效時應依 `retryAfterSeconds` 延後且不可 ACK；預設租約 600 秒。不要手動清空 DriveFileId，也不要刪除 `PROCESSING` 列 | 原程序完成後重送 ACK；若中止，租約過期後重取並增加 RetryCount |
| Worker 顯示 `GAS_NETWORK_ERROR`，但 GAS 仍在執行 | Worker 55 秒 timeout 先到；Apps Script 不一定同步停止 | 不要手動重送或把 Job 改成 FAILED。讓 Queue 重送；有效租約會回 `JOB_IN_PROGRESS` 並延後至租約到期後 | 不會 ACK 掉唯一工作，也不會在有效租約內重做 |
| Drive 出現重複檔案 | 舊版檔案沒有 `lineBackupEventKey`、目標資料夾錯誤，或 Drive API 查詢失敗 | 檢查同一事件的檔案是否在正確目標資料夾且 appProperties 有相同鍵；新版重試會先查詢並重用 File ID。不要只依檔名或未確認事件批次刪除 | Jobs、Sheet 與單一 Drive File ID 對應一致 |
| 群組一般聊天沒保存 | 這是設計行為 | 使用 `#筆記` 或明確提及 Bot | owner Sheet 新增列 |
| `綁定群組` 說 owner 未綁定 | 指令者尚未完成個人 OAuth | 私訊完成綁定，再回同一群組執行 | Groups Enabled=true |
| 新 owner 無法接管 | 舊 owner 尚未解除 | 原 owner 執行 `解除群組`；若失聯由管理者核對後停用該 Groups 列 | 新 owner 可綁定 |
| 備份或指令成功但無 LINE 回覆 | 所有指令都經 Queue，Reply Token 在處理後過期 | 先看 Drive／Sheet 與 Jobs，無需重傳。預設 `ENABLE_PUSH_FALLBACK=false`；若需補送，評估訊息用量後才設 `true` | 資料仍為 COMPLETED；明確 Token 無效時可選擇 Push |
| Reply 失敗後仍未收到 Push | fallback 關閉、LINE 錯誤不是 Token 無效、沒有收件者，或 Push API 失敗 | 核對 Worker 非 Secret var 與安全 errorCode；不要為了回覆失敗重播備份。Push 可能計入 LINE 官方帳號訊息用量 | 符合條件時 Push 成功；不符合時保持不補送且工作仍完成 |
| `unsend` 沒刪 Drive | 預設 `DELETE_DRIVE_ON_UNSEND=false` | 這是資料保護預設；需要時先評估再改 `true` | false 只標記、true 嘗試刪除 |
| 管理 Sheet 標頭錯誤 | 手動改名、搬欄或舊版本 | 先備份，再恢復 `UserRepository.gs` 定義的精確欄位順序 | 初始化函式通過 |
| Properties quota exceeded | 使用者過多或 Token 資料累積 | 停止邀請新使用者，解除不用帳號；長期改外部加密儲存 | OAuth refresh 恢復 |
| 管理 Sheet 持續增大 | 未定期清理 Nonces、BindingSessions、Errors 或已完成 Jobs | 設定保留天數後手動執行 `cleanupExpiredAdminRecords`；不可刪 Users、Groups、Invitations 或 Drive 檔案 | 執行記錄只顯示安全的刪除筆數 |

## 安全地收集診斷資料

可以提供：時間（Asia/Taipei）、元件、errorCode、截短的 correlationId、HTTP 狀態與是否可重現。不要提供：Authorization header、Channel Secret、Access／Refresh Token、OAuth Client Secret、完整 Apps Script／Worker URL、原始 LINE userId／groupId、邀請碼、訊息內容或附件。
