# 資料流程

## 私訊附件

1. LINE 對 Worker `/webhook` 傳送事件與 `X-Line-Signature`。
2. Worker 驗證原始 Body，於記憶體提取 webhookEventId、messageId、型別、時間及檔名／已知大小；以 LINE Profile API 取得顯示名稱後，立即將 source userId／groupId 轉為 HMAC 雜湊。
3. Queue 只保存中繼資料；HTTP 200 在排入成功後立即回傳 LINE。
4. Queue／Consumer 只保存與傳送 `lineUserHash`、`groupIdHash`、清理後的 `senderDisplayName`／`groupDisplayName`，不保存或傳送 raw LINE userId／groupId；Consumer 以 HMAC 呼叫 GAS。
5. GAS 在 Script Lock 內 claim Jobs。若同一事件仍有有效 PROCESSING 租約，不處理內容，也不回成功；改回 `JOB_IN_PROGRESS` 與剩餘租約加 5 秒的 `retryAfterSeconds`。Worker 延後 Queue retry，不 ACK。
6. 若工作可取得，GAS 直接使用 Worker 傳入的 `lineUserHash`／`groupIdHash` 找到資源；原始 ID 不會進入 GAS、Sheet 或 Log。
7. GAS 使用 Script Properties 中該使用者獨立 OAuth Service 取得 Access Token。
8. GAS 建立年月／類型資料夾，並用 webhookEventId 的用途隔離 HMAC 產生 `lineBackupEventKey`；先在目標資料夾查詢相同 Drive appProperty。

## 群組備份清單

1. Worker 將群組文字查詢指令轉為 `groupSummary` 或 `groupRecords`，Queue 只傳送 `groupIdHash`、`lineUserHash`、清理後文字與必要的 display name。
2. `groupSummary` 由 GAS 以 Groups 的 `OwnerLineUserHash` 找到 owner，使用 owner OAuth Token 讀取 `LINE 備份紀錄`，以安全「群組識別」及 Asia/Taipei 日期範圍篩選，只回傳計數與最新 5 筆摘要。
3. `groupRecords` 只允許 owner 或管理者私訊執行，產生 10 分鐘、綁定使用者與群組的隨機短碼；回覆使用 GAS `/exec?route=q&id={shortCode}`，群組內不產生完整查詢連結。
4. 群組摘要不輸出 Drive URL、查詢 URL、File ID、messageId、webhookEventId 或 raw identifier；完整查詢頁只使用 owner Sheet 並重新驗證 Token。
5. 完整查詢先比對「群組識別」；舊列識別空白時，只有 owner／管理者、owner Sheet、來源為 group、群組名稱唯一一致等條件同時成立才 fallback。管理者可手動執行 `migrateLegacyGroupRecordHashes()` 補齊唯一舊列。
9. 若找到既有檔案，直接把 File ID 寫回 Jobs；若找不到，才用系統 LINE Access Token 暫時下載附件、驗證大小，並以使用者 Access Token 上傳帶有 appProperty 的檔案。
10. 下載完成、上傳完成及 Sheet 寫入前後會延長 PROCESSING 租約。GAS 最後以同一使用者 Access Token 寫入自己的備份 Sheet，完成 Jobs 並清除租約。

Worker 的 55 秒 timeout 不表示 GAS 已停止。若 timeout 後原 GAS 仍執行，重送會依第 5 步等待租約；原程序完成後，下一次重送辨識 COMPLETED 並 ACK。若原程序中止，重送會在租約到期後重新取得。若第 9 步上傳成功、但第 10 步失敗，Jobs 的 `FAILED` 仍保留 Drive File ID，重試只補 Sheet 寫入。

## Google 綁定

1. Worker 將原始 LINE userId 以 `IDENTIFIER_HASH_SECRET` 做 HMAC-SHA256；`BIND_TOKEN_SECRET` 只簽署 Bind Token，Token 只保存 `lineUserHash`、nonce 與期限。
2. 使用者可輸入 `綁定 <邀請碼>`，或在 `ENABLE_SELF_SERVICE_BINDING=true` 時輸入不帶邀請碼的 `綁定`。邀請碼流程驗證但不扣次數；自助流程不保存邀請碼。BindingSessions 只保存 session nonce、LINE 使用者與邀請碼雜湊（自助流程為空）。
3. 綁定頁只驗證 Token；`lineUserHash`、`bindNonce`、`expiresAt` 經 OAuth2 Library 加密 state 往返。
4. Google 取消授權時，Session 維持 PENDING。授權成功後先保留 OAuth Token，Session 依序進入 AUTHORIZED 與 PROVISIONING，尚不扣邀請次數。
5. 以 Drive appProperties 建立或重用根目錄、個人／群組目錄與 Sheet。失敗時 Session 轉 FAILED，管理者可安全恢復，不需新邀請碼。
6. 資源與 Users 資料準備完成後，才在 Script Lock 內以單一 Sheets API 原子批次完成 Session、消耗 nonce；邀請碼流程才增加 `UsedCount`。自助流程寫入 `ApprovalStatus=PENDING_APPROVAL`／`Enabled=false`，待管理者以安全化代號核准後才啟用。

## 私訊文字與網址

不呼叫 LINE Content API，也不建立 Drive 檔案。GAS 解析 HTTP／HTTPS 網址與 `#標籤`，保留原始文字並寫入使用者自己的 Sheet。

## 紀錄查詢

1. 私訊 `紀錄` 或 `查詢紀錄` 由 Worker 解析為 `records` 指令，Queue 只傳送中繼資料。
2. GAS 驗證使用者已綁定、已核准且啟用後，產生 10 分鐘隨機 shortCode；短碼以 `lineUserHash`、可選 `groupIdHash`、scope 與期限綁定，Script Property 只保存短碼 HMAC 雜湊。
3. Reply API 回覆 `APP_BASE_URL?route=q&id={shortCode}`。LINE 不再收到完整長 Token；短碼不寫入 Log、管理 Sheet 或其他使用者資料。
4. Web App 每次載入與搜尋都重新驗證短碼雜湊、期限、scope、nonce 與使用者／群組雜湊，再以該使用者或群組 owner OAuth Token 讀取授權 Sheet。群組成員在群組輸入查詢只會收到改用私訊的提示。

## 群組資料

1. `綁定群組` 的擁有者只能是 webhook 事件來源 userId，不能由前端或文字參數指定。
2. Groups 保存 groupId 的 HMAC 雜湊、擁有者雜湊與該擁有者建立的群組資料夾 ID。
3. 任一群組成員的附件與 `#筆記` 都用 Groups 指向的 ownerLineUserHash 取得擁有者 Token；不要求傳送者先綁定或通過審核。
4. 傳送者欄位寫入實際傳送者雜湊與清理後的傳送者名稱，附件與紀錄則落在擁有者資源；群組附件預設不回覆，`#筆記` 可回覆成功訊息。
5. `解除群組` 由 owner 或管理者執行；`綁定群組` 不可由非 owner 覆蓋既有綁定。
6. 一般文字若沒有提及 Bot、`#筆記` 或指令，不離開 Worker，也不進入 Queue。

## 容量查詢

1. Worker 將私訊 `容量`、`空間`、`Drive容量` 解析為 `quota`，`群組容量` 解析為 `groupQuota`；Queue 不新增 Token 或 raw identifier。
2. GAS 驗證 Users 為已核准且啟用後，以該使用者 OAuth Token 呼叫 Drive `about?fields=storageQuota,user`，解析容量上限、使用量、Drive 檔案使用量與垃圾桶使用量。
3. GAS 從使用者備份 root、個人／群組資料夾與 Sheet 逐層列出可存取檔案，加總有 `size` 的檔案；原生 Google 文件沒有 `size` 時略過。
4. 個人與群組容量結果以 `lineUserHash` 對應的 Script Cache 快取 600 秒；群組內不回覆任何 owner 容量數字，只提示改用私訊。

## 收回訊息

`unsend` 以 messageId 尋找原 Jobs，將管理 Jobs 與使用者 Sheet 狀態改為「已收回」。`DELETE_DRIVE_ON_UNSEND=false` 時保留檔案；設為 `true` 才嘗試以擁有者 Token 刪除 Drive 檔案。

## 儲存位置對照

| 資料 | Cloudflare Queue | 管理 Sheet | Script Properties | 使用者 Drive／Sheet |
|---|---|---|---|---|
| 附件 bytes | 不保存 | 不保存 | 不保存 | 保存於擁有者 Drive |
| 原始文字 | 短暫中繼資料 | 不保存 | 不保存 | 保存於擁有者 Sheet |
| LINE userId／groupId | Worker 記憶體短暫使用；Queue 只存 HMAC 雜湊 | 只存 HMAC 雜湊 | 不保存原始值 | Sheet 只存傳送者雜湊 |
| OAuth Token | 不保存 | 不保存 | 每位使用者獨立 Service | 不適用 |
| 綁定 Token／OAuth state | 不保存 | BindingSessions 只存 HMAC 雜湊 | OAuth2 Library 短暫處理 | 不保存 |
| Secret | Cloudflare Secret | 不保存 | GAS Script Properties | 不保存 |
| webhookEventId／messageId | 短暫 | Jobs 去重 | 不保存 | 備份紀錄 |
