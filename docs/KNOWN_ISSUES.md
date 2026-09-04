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
12. Drive 初始化的 appProperties 查詢若遭 Google API 拒絕，GAS 只會在安全 Log 提供 HTTP status、reason、domain、摘要與 correlationId；完整 Drive query、File ID、Token 不會記錄。`files.list` 空結果是正常的不存在狀態，會進入冪等建立流程；非 2xx 會將 BindingSession 保留為 FAILED 供恢復。
13. 自助綁定的管理者審核目前是 LINE 指令流程，依賴 `ADMIN_LINE_USER_HASHES` 事先填入正確的 64 位識別雜湊；審核代號只取雜湊前綴，若發生極低機率碰撞會拒絕更新並要求管理者重新查詢。批次與整批操作仍沒有獨立管理者後台。
14. 自助綁定只會在 `ENABLE_SELF_SERVICE_BINDING=true` 時接受無邀請碼的 `綁定`。若屬性未設定或設為 `false`，系統仍只接受既有的 `綁定 <邀請碼>` 流程；這是為了讓既有部署能明確選擇啟用新流程。
15. 自助流程完成 OAuth 與資源初始化後才進入 `PENDING_APPROVAL`；若初始化失敗，Session 會保留為可恢復狀態，使用者不會出現在審核清單，需先由管理者執行既有恢復流程。
16. `npm audit --audit-level=high` 目前回報 `nanoid@3.3.16` 的 high advisory；它是 Vitest → Vite → PostCSS 的開發相依套件，不會被 Wrangler 打包進 Worker runtime。升級需評估測試工具相容性，本輪不執行可能帶來 breaking change 的自動修復；部署前仍應在依賴升級後重新執行完整測試。

17. 群組備份摘要與完整查詢依賴新版 Sheet 的「群組識別」欄位。舊 Sheet 會在下一次初始化／寫入時於最右側補欄，舊列不回填；摘要只在唯一群組名稱可安全比對時 fallback，完整查詢若缺欄會提示只能查詢新版本紀錄。
18. 群組摘要讀取 owner 的 Google Sheet，仍受 `drive.file`、Apps Script 執行時間與 Sheets API 配額限制；摘要只列最新 5 筆，完整查詢才顯示 Drive 連結。
19. 群組完整查詢目前使用 GAS `/exec?route=q&id={shortCode}` 短連結，shortCode 只保存 HMAC 雜湊並在 10 分鐘後失效；舊版長 Token 仍可相容驗證，但 Bot 不再產生長連結。舊列缺少群組識別時，名稱 fallback 僅在 owner／管理者、owner Sheet 與唯一名稱條件成立時啟用；同名或不確定資料會拒絕查詢。`migrateLegacyGroupRecordHashes()` 需由管理者手動執行，且只補唯一可判斷列。
20. Google OAuth App 若仍為 Testing，使用 `drive.file` 等非基本身分 scope 時，Refresh Token 可能週期性失效；這是 Google OAuth App 發布狀態限制，不是本專案可由程式自動修正的問題。管理者需依 `docs/GOOGLE_CLOUD_SETUP.md` 手動發布到 Production；已失效使用者仍需執行一次 `重新授權`。本專案不會自動操作 Google Cloud Console 或修改 Client ID／Secret。
21. `補備份` 只會重試 owner 備份 Sheet 與 Jobs 中仍有 messageId 的失敗／未完成項目；LINE Content API 已不可下載、缺少必要 metadata、已完成或明確拒絕的項目會略過。此功能不是 LINE 歷史訊息抓取，無法補 Bot 收到前或系統未收到的內容。
22. 補備份需在 GAS Script Properties 設定 `WORKER_REPLAY_ENDPOINT`（部署 Worker URL 加上 `/internal/replay`）；未設定或兩端共享金鑰不一致時，只會建立候選紀錄但無法送入 Queue，管理者應查看安全錯誤碼 `REPLAY_*`。
23. `/internal/replay` 目前以既有 Worker→GAS shared HMAC 及 Jobs／Drive 冪等保護重放；Queue 至少一次傳遞仍可能在短時間內出現重試訊息，最終由 Jobs 終態與 Drive appProperties 去重，不保證跨服務交易原子性。

24. 使用者或群組 owner 的 OAuth Token 失效時，工作會保留為 `OAUTH_REAUTH_REQUIRED` 並回覆重新授權提示；群組相同錯誤 30 分鐘內只提醒一次。重新授權後需手動執行 `補備份 今日` 或 `群組補備份`，不會自動抓取 LINE 歷史紀錄。
25. 管理 Jobs 不保存尚未寫入使用者 Sheet 的完整文字內容；因此授權失效期間的純文字／`#筆記` 若沒有既有 Sheet 列，補備份會安全略過。附件仍可在 messageId 與 LINE Content API 有效時重試。
26. Jobs metadata 欄位會由 `ensureAdminSheets_()` 在既有 10 欄 Jobs 表最右側補上；若管理者自行修改前 10 欄標題，系統會停止初始化並要求先恢復標題，不會覆蓋既有資料。
27. OAuth Token 刷新手動測試需要管理者在 Script Properties 暫設 `TEST_LINE_USER_HASH`（64 碼小寫雜湊），並且必須先完成 `testOwnerAuthorizationHealth`。測試只驗證既有 OAuth Service、Token metadata、`hasAccess()`、`getAccessToken()`、`refresh()` 與 Drive `about.get`；不會顯示或由本專案直接寫入／reset Token。OAuth2 Library 依正常流程可能持久化刷新後的授權 Token；Production 狀態、Google Workspace 政策、撤銷授權與 Refresh Token 配額仍須以實際帳號人工驗證。

28. Worker 的最近 GAS 健康狀態只保存在 isolate 記憶體；Worker 重啟、擴容或切換 isolate 後會顯示「未知」，不代表 GAS 當下不可用。`系統診斷` 僅顯示白名單錯誤碼，Worker 尚未同步 GAS 的管理者 hash 清單，因此不在 Worker 端判斷管理者身分。
29. GAS 403 HTML fallback 只能在 Queue consumer 尚有有效 Reply Token 時提示；Reply Token 失效時只記錄安全錯誤。若 GAS 已開始執行但回應遺失，仍由 Jobs 去重、租約與 Queue 重試確保工作可恢復，無法保證每次都能即時回覆。

## 必須在正式帳號人工驗證

- LINE Verify、實際 webhook 簽章、Bot 加群組與 mention 的完整 payload。
- Google OAuth consent、`/usercallback` redirect URI、Refresh Token 更新及撤銷。
- OAuth2 Library `getAuthorizationUrl()` 額外參數經 state 回傳，以及頁面重新整理、取消、成功與重複 callback 的實際行為。
- AUTHORIZED／PROVISIONING／FAILED 恢復、資源 appProperties 重用，以及最終 Users／邀請扣次／BindingSession／nonce 原子 `values.batchUpdate` 在部署者帳號授權下可成功執行。
- Apps Script OAuth2 Library 第 43 版可用性；部署時若編輯器顯示更新版，應先在測試部署驗證再升級。
- `drive.file` 對由應用程式建立之 Sheet 的 Sheets API 讀寫。
- 20 MiB 預設上限在實際 Apps Script 帳號配額與網路條件下的成功率；若刻意提高到 45 MiB，視為高風險壓力測試。
- Queue 重試、DLQ、Reply Token 逾期與 Cloudflare 免費方案目前配額。
- 重新授權流程已限制必須使用原本綁定的 Google Subject；本機只能驗證指令解析與資源重用 helper，實際 OAuth callback、Token 儲存與 Google 帳號選擇仍需由管理者以測試使用者手動驗證。
- `JOB_IN_PROGRESS` 不寫 Errors、不改 FAILED、PROCESSING 租約回收、FAILED Job 沿用 DriveFileId、Drive appProperties 查找及清理函式目前只能由 Apps Script 手動測試及實際管理 Sheet 驗證；本機已完成 GAS 語法與 Worker retry／ack 邏輯測試。
- 群組摘要查詢依群組 owner 的備份 Sheet 讀取；查詢權限不要求一般成員具備個人 Users／ApprovalStatus。若 owner 資源停用或 Sheet／Sheets API 暫時失敗，摘要會回覆安全提示並記錄 `group-query`，不會把錯誤轉成無回覆的 Queue retry。
- Google／LINE／Cloudflare UI 名稱可能隨平台改版，文件以功能名稱與預期結果輔助定位。

## 未納入 MVP

- LINE 社群、公開註冊、管理後台、AI、OCR、付費會員。
- Token 外部加密資料庫、跨區備援、端到端加密、自動資料保留排程。
- 已提供管理者手動執行的 `cleanupExpiredAdminRecords`，但不會自動建立時間觸發器；執行頻率仍需依 `COST_AND_QUOTAS.md` 人工安排。
- 自動化 GAS 測試 runner。GAS 測試須在 Apps Script 編輯器由管理者手動執行。
- 管理者審核目前不會自動通知管理者；管理者需主動執行 `待審核`，核准或拒絕後再由使用者執行 `狀態` 確認。
