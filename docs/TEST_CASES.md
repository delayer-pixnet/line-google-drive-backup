# 測試案例

## Worker 自動測試

在 `cloudflare-worker` 執行：

```powershell
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

測試只使用合成事件與假 Queue，不呼叫正式 LINE、朋友帳號或 Google API。

| 編號 | 測試 | 預期結果 |
|---|---|---|
| W01 | 合法 LINE 簽章 | HTTP 200，中繼資料進假 Queue |
| W02 | 非法 LINE 簽章 | HTTP 401，Queue 為空 |
| W03 | 空 Body | HTTP 400 |
| W04 | 不支援的 postback 事件 | HTTP 200 且安全忽略 |
| W05 | HMAC 產生、變更 Body 與跨平台 UTF-8 固定向量 | 原文通過、變更後失敗；Worker 結果與 GAS 固定向量一致 |
| W06 | 綁定 Token 正常、過期、竄改與內容 | 只有有效 Token 可解析，payload 不含原始 LINE userId |
| W07 | webhook 轉 Queue job | 必填中繼欄位一致，無二進位內容 |
| W08 | 預設 20 MiB 上限 | 等於上限通過，多 1 byte 拒絕 |
| W09 | 指定文字指令與管理者審核指令 | 名稱與參數正確，未授權管理者命令由 GAS 拒絕 |
| W10 | 多筆／整批審核指令解析 | `核准 1,2,3`、`拒絕 1,2,3`、`核准全部`、確認指令解析正確 |
| W11 | `#標籤` 與網址 | 去重、移除句尾標點、排除控制標籤 |
| W12 | 安全 Log | 只輸出白名單欄位，不含測試 Secret |
| W13 | 群組文字規則 | 一般聊天忽略，mention／`#筆記` 建立工作；群組管理指令交由 GAS 做權限檢查 |
| W14 | GAS client 正常 JSON 與無效 JSON | 正常回應解析；非 JSON 回 `GAS_INVALID_RESPONSE` |
| W15 | GAS HTTP 500／400 | 500 標示 retryable；400 標示 non-retryable |
| W16 | LINE Reply／Push 成功與失敗 | 成功完成；非 2xx 回安全錯誤，且一般 400／Channel Token 401 不誤判為 Reply Token 無效 |
| W17 | Queue retry／ack | retryable 呼叫 retry；non-retryable 呼叫 ack |
| W18 | 備份完成但 Reply Token 失效 | fallback 關閉時只 ack；開啟時 Push 成功或失敗都不再次呼叫 GAS、retry 或重做備份 |
| W19 | 重複工作 | GAS 回傳已處理時 ack，不重複上傳 |
| W20 | 安全 Log 敏感欄位 | Secret、Token、原始文字與 LINE 識別碼都不出現在 Log |
| W21 | 永久識別雜湊金鑰分離 | 輪替 `BIND_TOKEN_SECRET` 不改變 lineUserHash；輪替 `IDENTIFIER_HASH_SECRET` 才會改變 |
| W22 | 一般成功附件 | GAS 沒有 `replyMessage` 時，即使 fallback 開啟也不呼叫 Push API |
| W23 | GAS `retryAfterSeconds` 解析 | 30、605、900 接受；29、901、非整數與字串忽略 |
| W24 | PROCESSING 有效租約 | `JOB_IN_PROGRESS` 使用 GAS 指定延遲呼叫 retry，絕不 ack |
| W25 | 無效租約延遲 | 回退 60 秒 retry，不 ack |
| W26 | 原處理程序稍後完成 | 第一次延後，後續 GAS 回 COMPLETED／`ok=true` 時正常 ack |
| W27 | 群組附件與筆記 | 群組附件排入 Queue；`#筆記` 解析為 note，附件成功不自動回覆 |
| W28 | 自助綁定設定分流 | `REQUIRE_ADMIN_APPROVAL=false` 寫入 APPROVED／Enabled=true；`true` 維持 PENDING／停用 |
| W29 | 紀錄指令解析 | `紀錄`、`查詢紀錄` 解析為 records；群組不得產生查詢連結 |
| W30 | Profile metadata | 私訊／群組 Profile 成功時帶入安全顯示名稱；API 失敗仍排入備份，Queue 不含 raw userId／groupId |
| W31 | 容量指令解析 | `容量`、`空間`、`Drive容量` 解析為 `quota`；`群組容量` 解析為 `groupQuota` |
| W32 | 重新授權指令解析 | `重新授權` 只在私訊產生短效 OAuth Bind Token；Token 不含原始 LINE userId |
| W33 | 補備份指令解析 | `補備份`、`群組補備份` 的日期與安全群組代號解析正確 |
| W34 | 補備份內部端點 | GAS HMAC 正確時接受安全 Queue 工作；無效簽章不入 Queue |

Vitest 預期顯示所有 test files 與 tests passed；coverage 是風險參考，不設置虛假的 100% 門檻。

## GAS 手動 TestFunctions

先設定 GAS Script Properties、初始化管理 Sheet，再於 Apps Script 編輯器逐個選擇函式並按 Run。

| 函式 | 目的 | 預期畫面／結果 |
|---|---|---|
| `testHmacVerification` | Worker HMAC | Execution log 顯示通過，Nonces 新增測試 hash |
| `testIdentifierHashSecretSeparation` | 永久識別雜湊與跨平台 UTF-8 HMAC | Bind Token 金鑰輪替不改變識別雜湊；識別金鑰變更才改變，固定向量與 Worker 一致 |
| `testNonceValidation` | nonce 一次性 | 第二次消耗被拒絕，函式整體顯示通過 |
| `testFileNameSanitization` | 路徑與控制字元 | Log 的清理檔名不含 slash、backslash、`..` |
| `testTagExtraction` | 標籤去重 | `筆記` 排除，台北／旅遊各 1 次 |
| `testUrlExtraction` | URL 解析 | 擷取 2 個網址，不含中文句號／逗號 |
| `testInitializeAdminSpreadsheet` | 7 個管理工作表 | 每個工作表標頭正確，包含 BindingSessions |
| `testCreateUserDriveRootFolder` | 使用者 Drive API | 授權帳號出現 `LINE 備份手動測試_...` |
| `testCreatePersonalBackupSheet` | 使用者 Sheets API | 測試資料夾內出現至少 17 欄 Sheet，包含「傳送者名稱」 |
| `testWebhookEventDeduplication` | webhookEventId 去重 | 第一次 claimed，第二次拒絕，Jobs 只有 1 列 |
| `testJobRetryAfterSecondsBoundaries` | 租約剩餘時間與邊界 | 加 5 秒緩衝，並限制在 30 至 900 秒 |
| `testActiveProcessingLeaseCannotBeReclaimed` | 未過期工作租約 | `PROCESSING` 不可重新取得，並回傳 LeaseExpiresAt 與 retryAfterSeconds |
| `testJobInProgressDoesNotWriteError` | 正常租約協調 | doPost 回 retryable `JOB_IN_PROGRESS`，不寫 Errors、不改 FAILED |
| `testCompletedJobAcknowledgesAfterInProgressRetry` | 延後後辨識終態 | 第一次要求 retry；原程序完成後，下一次回 `ok=true` 且不重做 |
| `testExpiredProcessingLeaseCanBeReclaimed` | 過期工作租約 | 過期後可重新取得，RetryCount 增加 1 |
| `testExpiredLeaseReclaimPreservesDriveFileId` | 過期重取保留檔案 | 重新取得後 DriveFileId 不變 |
| `testCompletedJobCannotBeReclaimed` | 終態工作去重 | `COMPLETED` 不可重新取得 |
| `testDriveEventIdempotencyKey` | Drive 事件冪等鍵純函式 | 同一 webhookEventId 得到同一 64 位 HMAC，不同事件得到不同鍵 |
| `testFailedJobPreservesDriveFileId` | 上傳後 Sheet 失敗的重試 | FAILED 仍保留 DriveFileId，下一次可沿用 |
| `testBindingSessionCanBeReopenedBeforeCallback` | 綁定頁重新整理 | PENDING session 可重複驗證，不提前消耗 nonce |
| `testCompletedBindingSessionRejectsReplay` | callback 防重播 | COMPLETED session 重送遭拒絕 |
| `testBindingSessionInvitationConsumption` | 邀請碼延後扣次 | PENDING／AUTHORIZED 不扣次，最後完成後扣 1 次，重送仍維持 1 次 |
| `testAuthorizedBindingFailureIsRecoverable` | 授權後初始化失敗 | Session 保留為可恢復狀態、邀請不扣次，並可重新進入 PROVISIONING |
| `testBindingProvisioningReusesResources` | 綁定資源初始化冪等 | 同一使用者連續初始化會重用相同資料夾與 Sheet ID |
| `testSelfServiceApprovalHelpers` | 自助綁定與審核狀態 | 新使用者為 PENDING_APPROVAL，既有邀請碼與已核准使用者不被降級 |
| `testAdminApprovalSafetyHelpers` | 管理者白名單與安全化代號 | 只有設定的 lineUserHash 可視為管理者；審核代號不含原始識別 |
| `testBatchApprovalHelpers` | 多筆審核與重複處理 | `1,2,3` 只處理目前 PENDING／停用使用者，已核准／已拒絕會略過 |
| `testApprovalConfirmationExpiry` | 整批確認碼 | 確認碼 5 分鐘期限、管理者綁定與操作綁定正確 |
| `testApprovalConfirmationFlow` | 整批確認流程 | 同一管理者第一次確認成功，重送同一確認碼遭拒絕 |
| `testGroupPermissionHelpers` | 群組權限分流 | 一般成員可交內容給已核准 owner；只有 owner／管理者可操作群組管理指令；群組狀態不含個人資訊 |
| `testBackupSheetHeaderMappingHelpers` | Sheet 欄位相容 | 舊欄位只在右側補「傳送者名稱」等缺欄；寫入依標題名稱 mapping，公式前綴安全處理 |
| `testBackupRecordDisplayNameHelpers` | 名稱寫入 | 私訊文字／檔案、群組附件／筆記都使用實際傳送者名稱與 hash，不使用 Bot 識別 |
| `testDriveQuotaHelpers` | 容量輔助邏輯 | bytes／使用率格式化、無上限、原生文件無 size、檔案加總與 600 秒快取 |
| `testDriveQuotaUserBindingCompatibility` | 容量使用者相容性 | 舊版 `Enabled=true`／空白核准狀態、APPROVED、PENDING、停用、Token 遺失與 Drive 權限不足分流 |
| `testOAuthServiceConsistency` | OAuth Service 與資源重用 | 容量、紀錄、個人備份與 Drive 初始化使用同一 `LineUser_<lineUserHash>` Service；既有核准使用者重新授權後保留狀態與資源 |
| `testOAuthTokenAvailableForConfiguredUser` | 重新授權後 Token 讀取 | 先設定 `TEST_LINE_USER_HASH` 並完成 `重新授權`；只記錄安全狀態欄位，確認共用 Service 可讀取 Token |
| `testOAuthRefreshForConfiguredUser` | OAuth Token 自動刷新與 Drive 可用性 | 先設定 64 碼 `TEST_LINE_USER_HASH`；共用 `LineUser_<hash>` Service 通過 `hasAccess()`、`getAccessToken()` 與 Drive `about.get`，只記錄安全 metadata |
| `testOAuthForceRefreshForConfiguredUser` | OAuth Refresh Token 主動刷新 | 管理者偶爾執行；同一 Service 呼叫 `refresh()` 後再次呼叫 Drive `about.get`，成功顯示 PASS，不輸出或 reset Token |
| `testOAuthRefreshSafetyHelpers` | OAuth 刷新測試安全邊界 | 格式錯誤、使用者不存在／未啟用、Token metadata 與安全 Log 不輸出 Token 值 |
| `testOwnerAuthorizationHealth` | GAS 部署後授權健康檢查 | 只讀取必要設定與管理 Sheet，安全外部請求及執行環境可用；成功記錄 `PASS testOwnerAuthorizationHealth` |
| `testOwnerAuthorizationHealthHelpers` | 健康檢查靜態安全檢查 | 必要設定清單與全域手動函式存在，不輸出設定值 |
| `testRoleBasedHelpMessages` | 說明依身分 | 一般使用者不顯示管理指令；管理者顯示審核指令；群組只顯示群組規則 |
| `testRecordQueryTokenHelpers` | 查詢 Token | Token 期限、使用者雜湊綁定與過期拒絕通過；完整 Token 不寫入測試訊息 |
| `testRecordQueryDisplaySafety` | 查詢結果遮罩 | 結果不含 LINE userId、Google Email 或完整識別雜湊 |
| `testGroupBackupQueryHelpers` | 群組摘要查詢 | 日期解析、摘要最多 5 筆、一般成員不需個人權限、群組安全代號、圖片可讀名稱與 Drive URL 遮罩 |
| `testGroupRecordQueryTokenHelpers` | 群組完整紀錄 Token | Token 版本、lineUserHash／groupIdHash 綁定與不暴露完整雜湊 |
| `testRecordQueryShortCodeHelpers` | 群組／個人短查詢連結 | 10 碼 URL-safe、短碼不含識別資訊、Script Properties 只保存 HMAC 雜湊 |
| `testLegacyGroupRecordSafetyHelpers` | 舊群組紀錄相容 | owner／群組名稱唯一性、來源類型與空識別條件；同名群組拒絕 fallback |
| `testManualReplayHelpers` | 補備份純函式 | 日期／月份／區間解析、可補狀態、中文訊息型別與安全 Queue 工作 |
| `testOAuthReauthHandlingHelpers` | OAuth 失效待補 | Token／Drive 401／403 判斷、個人與群組安全提示、30 分鐘提醒冷卻、待補狀態與個人附件候選 |

## 群組備份清單人工案例

- 在已綁定群組輸入 `備份清單`、`今日備份清單`、`本週備份清單`、`8月備份清單` 與 `2026-08 備份清單`；預期只看到摘要與最多 5 筆，沒有 Drive 或查詢 URL。
- 由一般成員、群組 owner 與管理者分別輸入 `本週備份清單`；三者都應收到摘要，不需個人綁定／審核；摘要內圖片若無原始檔名，應顯示 `image_yyyyMMdd_HHmmss_<hash-prefix>.jpg` 與傳送者名稱。
- 在未綁定群組輸入 `備份清單`；預期看到「本群組尚未綁定，請由已完成個人綁定的使用者輸入『綁定群組』。」。
- 一般成員私訊 `群組紀錄 2026-08`；預期沒有可查詢群組。owner 私訊同指令；單一群組直接取得 10 分鐘連結，多群組需再輸入安全代號。
- 以其他使用者或其他群組使用短連結；預期遭拒絕。shortCode 過期後預期顯示「查詢連結已過期，請回 LINE 重新輸入『群組紀錄』取得新連結。」
- 以唯一群組名稱的舊 group 列查詢；預期頁面顯示「部分舊紀錄因早期版本缺少群組識別，已依群組名稱相容查詢。」；建立同 owner 同名群組後重試，預期拒絕 fallback。
- 管理者手動執行 `migrateLegacyGroupRecordHashes()`；預期只補唯一可判斷列，Logger 只顯示掃描、成功、略過與不確定筆數。

`testCreateUserDriveRootFolder`、`testCreatePersonalBackupSheet` 與 `testBindingProvisioningReusesResources` 會使用自己的 Google 授權並可能真的建立或重用 Drive／Sheet 資源，但不呼叫朋友帳號或正式 LINE API。先把自己的 Users `LineUserHash` 暫時設成 Script Property `TEST_LINE_USER_HASH`；確認冪等測試的兩次回傳 ID 相同。前 2 項會建立名稱含「手動測試」的資源；冪等測試可能重用標準「LINE 自動備份」資源，不可把它當成測試垃圾刪除。測試後只刪除明確標示的測試資源與該 Property。

Jobs、邀請與 BindingSession 手動測試會在管理 Sheet 寫入以 `manual-`／`TEST-`／`RECOVER-` 為前綴的合成紀錄。建議先複製一份專用測試管理 Sheet；若必須使用正式管理 Sheet，執行前先備份，完成後只刪除能明確對應本次測試的列，不得依模糊條件批次刪除。

## 端對端驗收

| 編號 | 操作 | 預期結果 |
|---|---|---|
| E01 | LINE Verify | Console 顯示 Success |
| E02 | 自己用 1 次性邀請碼綁定 | Session 經 AUTHORIZED／PROVISIONING 後變成 COMPLETED，建立 3 個資料夾／1 份 Sheet，Users Enabled=true，邀請只扣 1 次 |
| E03 | 重用邀請碼 | 顯示無效或達使用次數 |
| E04 | 私訊文字、URL、2 個標籤 | Sheet 新增列，網址／標籤欄正確 |
| E05 | 私訊圖片／影片／音訊／檔案 | 對應年月與類型資料夾各有檔案 |
| E06 | 傳超限檔案 | Sheet／Jobs 標示拒絕，Drive 無新檔 |
| E07 | 重送相同 webhookEventId | 以 `lineBackupEventKey` 找到既有檔案，不重新下載或建立第 2 份 Drive 檔 |
| E08 | 收回文字／附件 | Sheet 標「已收回」；預設保留 Drive 檔 |
| E09 | 群組一般聊天 | 不寫入 Sheet |
| E10 | 群組 mention／`#筆記` | 寫入 owner Sheet |
| E11 | 群組多成員附件 | 任何成員都可提供內容，只進 owner Drive，sender hash 不同 |
| E12 | 非 owner 解除群組 | 回覆拒絕，不改 Groups；owner／管理者可解除 |
| E13 | 解除個人綁定 | Token reset、Users false、既有檔案保留 |
| E14 | Google 安全頁撤銷後傳檔 | 顯示需重新綁定或安全錯誤，不洩漏 Token |
| E15 | 模擬 OAuth 成功後初始化暫時失敗，再執行管理恢復 | OAuth Token 與部分資源保留；`resumeAuthorizedBinding` 重用資源，完成後邀請只扣 1 次 |
| E16 | 測試環境讓指令 Reply Token 明確失效 | fallback 關閉時不 Push；開啟時只嘗試 1 次 Push，Push 失敗不重做備份 |
| E17 | 模擬 Worker timeout 後同一工作重送 | 有效租約回 `JOB_IN_PROGRESS` 且 Queue 不 ACK；原程序完成則後續 ACK，中止則租約過期後重取 |
| E18 | 自助綁定與管理者核准 | 私訊 `綁定` 取得連結；OAuth 完成後 Users 為 `PENDING_APPROVAL`／停用，管理者以 `待審核`、`核准 <編號>` 後才可備份 |
| E19 | 多筆審核 | 管理者輸入 `核准 1,2,3` 或 `拒絕 1,2,3`，回覆成功／略過／失敗筆數 |
| E20 | 整批審核二次確認 | `核准全部`／`拒絕全部` 先回數量與確認碼；只有同一管理者在 5 分鐘內輸入正確確認指令才執行 |
| E21 | 群組管理與私訊限制 | 群組成員不可覆蓋／解除綁定；審核與個人綁定在群組只回覆改用私訊；群組 `狀態` 只顯示綁定狀態 |
| E22 | 容量查詢 | 私訊 `容量` 顯示 Drive quota 與備份估算；未綁定提示先綁定；群組輸入只提示改用私訊；`群組容量` 僅顯示自己的群組 |
| E23 | 既有使用者重新授權 | 私訊 `重新授權` 更新同一 OAuth Service Token；Users、Drive、Sheet、Groups 不新增或重建；不同 Google 帳號遭拒絕 |
| E24 | OAuth Token 失效後補備份 | 個人或群組 owner 傳附件時立即收到重新授權提示；Jobs 為 `OAUTH_REAUTH_REQUIRED` 且保存安全 metadata；重新授權後 `補備份 今日`／`群組補備份` 可重送可下載附件 |

驗收時只用無敏感內容的小型測試檔。預設先以 20 MiB 以下檔案驗收；若管理者刻意提高到 45 MiB，該壓力測試應放在最後，且結果不保證成功，需同時觀察 Apps Script Executions 與 Queue DLQ。

| E25 | 私訊狀態與系統診斷 | `狀態` 顯示安全 OAuth 狀態、Token 剩餘時間（可取得時）與最多 10 個群組名稱；`系統狀態`／`系統診斷` 在 GAS 不可用時仍由 Worker 回覆，不輸出敏感資料 |
| E26 | GAS 403 HTML | Worker 以 Reply API 顯示管理者授權健康檢查提示；Reply 失敗只記安全欄位，不重做備份、不使用 Push |
