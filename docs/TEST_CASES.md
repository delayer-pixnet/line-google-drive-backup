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
| W09 | 7 個指定文字指令 | 名稱與參數正確 |
| W10 | `#標籤` 與網址 | 去重、移除句尾標點、排除控制標籤 |
| W11 | 安全 Log | 只輸出白名單欄位，不含測試 Secret |
| W12 | 群組文字規則 | 一般聊天忽略，mention 建立工作 |
| W13 | GAS client 正常 JSON 與無效 JSON | 正常回應解析；非 JSON 回 `GAS_INVALID_RESPONSE` |
| W14 | GAS HTTP 500／400 | 500 標示 retryable；400 標示 non-retryable |
| W15 | LINE Reply／Push 成功與失敗 | 成功完成；非 2xx 回安全錯誤，且一般 400／Channel Token 401 不誤判為 Reply Token 無效 |
| W16 | Queue retry／ack | retryable 呼叫 retry；non-retryable 呼叫 ack |
| W17 | 備份完成但 Reply Token 失效 | fallback 關閉時只 ack；開啟時 Push 成功或失敗都不再次呼叫 GAS、retry 或重做備份 |
| W18 | 重複工作 | GAS 回傳已處理時 ack，不重複上傳 |
| W19 | 安全 Log 敏感欄位 | Secret、Token、原始文字與 LINE 識別碼都不出現在 Log |
| W20 | 永久識別雜湊金鑰分離 | 輪替 `BIND_TOKEN_SECRET` 不改變 lineUserHash；輪替 `IDENTIFIER_HASH_SECRET` 才會改變 |
| W21 | 一般成功附件 | GAS 沒有 `replyMessage` 時，即使 fallback 開啟也不呼叫 Push API |
| W22 | GAS `retryAfterSeconds` 解析 | 30、605、900 接受；29、901、非整數與字串忽略 |
| W23 | PROCESSING 有效租約 | `JOB_IN_PROGRESS` 使用 GAS 指定延遲呼叫 retry，絕不 ack |
| W24 | 無效租約延遲 | 回退 60 秒 retry，不 ack |
| W25 | 原處理程序稍後完成 | 第一次延後，後續 GAS 回 COMPLETED／`ok=true` 時正常 ack |

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
| `testCreatePersonalBackupSheet` | 使用者 Sheets API | 測試資料夾內出現 16 欄 Sheet |
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
| E11 | 群組多成員附件 | 只進 owner Drive，sender hash 不同 |
| E12 | 非 owner 解除群組 | 拒絕，不改 Groups |
| E13 | 解除個人綁定 | Token reset、Users false、既有檔案保留 |
| E14 | Google 安全頁撤銷後傳檔 | 顯示需重新綁定或安全錯誤，不洩漏 Token |
| E15 | 模擬 OAuth 成功後初始化暫時失敗，再執行管理恢復 | OAuth Token 與部分資源保留；`resumeAuthorizedBinding` 重用資源，完成後邀請只扣 1 次 |
| E16 | 測試環境讓指令 Reply Token 明確失效 | fallback 關閉時不 Push；開啟時只嘗試 1 次 Push，Push 失敗不重做備份 |
| E17 | 模擬 Worker timeout 後同一工作重送 | 有效租約回 `JOB_IN_PROGRESS` 且 Queue 不 ACK；原程序完成則後續 ACK，中止則租約過期後重取 |

驗收時只用無敏感內容的小型測試檔。預設先以 20 MiB 以下檔案驗收；若管理者刻意提高到 45 MiB，該壓力測試應放在最後，且結果不保證成功，需同時觀察 Apps Script Executions 與 Queue DLQ。
