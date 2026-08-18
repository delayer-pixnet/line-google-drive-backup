# 安全設計

## 信任邊界

- LINE webhook 是未信任輸入，只有通過原始 Body 簽章後才解析。
- Queue 可承受至少一次傳遞，GAS 不把「收到一次」等同「只處理一次」。
- Worker→GAS 是公開 Web App 入口，必須同時通過 HMAC、5 分鐘 timestamp 與一次性 nonce。
- OAuth 頁面的 query string 只接受 Worker 簽發的短效 Token。Token payload 只包含 `lineUserHash`、期限與 nonce，不含原始 `lineUserId`。
- 群組 owner 只能取自 LINE webhook source.userId。
- Worker 只在記憶體短暫使用 source userId／groupId 呼叫 LINE Profile、群組成員 Profile 或 Summary API；送入 Queue 與 GAS 的只有 HMAC 雜湊和清理後顯示名稱。GAS 收到含 `lineUserId`／`groupId` 的舊式 payload 會拒絕。
- 群組附件與 `#筆記` 只要求 Groups 指向的 owner 已核准且啟用；傳送者可以是未綁定或未審核的普通成員。`綁定群組`、`解除群組` 另檢查 owner／管理者身分，管理者審核與個人 OAuth 指令一律限私訊。

## 雜湊用途

`LineUserHash`、`GroupIdHash`、`InviteCodeHash`、`NonceHash`、`SessionNonceHash`、Drive 事件鍵與資源鍵都以長期固定的 `IDENTIFIER_HASH_SECRET` 做用途隔離 HMAC-SHA256，不是無鹽 SHA-256。Worker 與 GAS 使用相同演算法及 UTF-8 輸入，因此可在不傳送原始 LINE userId 的情況下比對身分。`BIND_TOKEN_SECRET` 只簽短效 Bind Token；輪替它不會改變永久識別雜湊。

`IDENTIFIER_HASH_SECRET` 一旦上線便不可直接輪替，否則 Users、Groups、Invitations、Nonces、BindingSessions、OAuth Service 名稱及 Drive appProperties 對應都會失效。未來若需輪替，必須先設計雙讀、重算與 OAuth Service 搬移程序；目前尚未部署，因此不提供舊資料遷移程式。

工作去重直接使用 LINE 提供的 webhookEventId，並以 messageId 支援 unsend 查詢。它們不是 OAuth 憑證，但仍不應出現在公開 Log。

## 固定時間比較

Worker 與 GAS 都以不因第一個不相符字元而提前返回的比較函式驗證 HMAC。長度差異會納入累積結果，避免一般字串比較的明顯 timing 差異。

## Replay Attack

- Worker envelope 時間窗為 5 分鐘。
- nonce 必須是 32 位小寫十六進位；GAS 在 Script Lock 內把 HMAC 後的 nonce 寫入 Nonces，重複值拒絕。
- 綁定 Token 預設 10 分鐘；開啟或重新整理綁定頁只驗證 Token 與待綁定工作階段，不消耗 nonce。
- OAuth state 由 Apps Script OAuth2 Library 的 StateTokenBuilder 簽發並驗證，只帶入 `lineUserHash`、`bindNonce` 與 `expiresAt`，不含原始 LINE userId 或邀請碼。
- OAuth callback 會重新檢查 hash、nonce 格式與期限。Google `handleCallback` 成功後先保存 Token 並把 Session 設為 AUTHORIZED；只有資源初始化及 Users 資料準備完成後，才在 Script Lock 的最終原子批次消耗 nonce。COMPLETED callback 重送會拒絕。

## 邀請碼與待綁定工作階段

- 使用者送出邀請碼時只驗證有效性，不增加 `UsedCount`。GAS 建立以 Bind Token nonce 關聯的 `BindingSessions` 列，工作表只保存 session nonce、LINE 使用者與邀請碼的 HMAC。
- OAuth 成功後 Session 進入 AUTHORIZED 並保留一個邀請名額，再以 PROVISIONING 租約初始化。失敗轉為 FAILED，OAuth Token 與名額保留，管理者可執行恢復。
- 資源準備完成後，GAS 才以單一 Sheets API `values.batchUpdate` 原子更新 Users Enabled、`UsedCount`、Session COMPLETED 與已使用 nonce，避免部分寫入後重送造成重複扣次。
- 自助綁定不保存邀請碼；Session 的 `InviteCodeHash` 留空。資源與 Users 初始化完成後，若 `REQUIRE_ADMIN_APPROVAL=true`，只寫入 `ApprovalStatus=PENDING_APPROVAL` 與 `Enabled=false`。管理者身分以 `ADMIN_LINE_USER_HASHES` 的永久雜湊比對，審核清單只顯示由雜湊前綴產生的安全化代號，不顯示原始 LINE userId 或 Google Email。
- `REQUIRE_ADMIN_APPROVAL=false` 時，自助綁定完成資源初始化後直接寫入 `ApprovalStatus=APPROVED` 與 `Enabled=true`；邀請碼流程仍維持原有核准行為。設定切換不會把已完成使用者降級為待審核。
- 批次審核只接受目前 `PENDING_APPROVAL` 且 `Enabled=false` 的 Users；逗號編號依目前待審核清單的 1-based 順序解析。整批操作的確認碼只保存雜湊、操作類型、期限，並以管理者 `lineUserHash` 分隔的 Script Property 保存；確認碼 5 分鐘後失效，成功消耗後立即刪除，不寫入 Log 或工作表。
- 使用者取消 Google OAuth、初始化失敗或 callback 重送時，不會重複扣除邀請次數。AUTHORIZED 後即使原邀請期限到達，仍可在邀請未停用且額度未被耗盡時完成保留的工作階段。

## 紀錄查詢中心

- `紀錄`、`查詢紀錄` 與 `群組紀錄` 僅允許私訊流程產生短查詢連結；群組輸入不會建立連結，避免把個人查詢 URL 公開在群組。
- 查詢連結使用 10 分鐘有效的隨機 10 碼 shortCode，URL 只含 `route=q&id=shortCode`。GAS 以 `IDENTIFIER_HASH_SECRET` 對短碼 HMAC 後查詢 Script Properties；儲存內容只含短碼雜湊、使用者／群組雜湊、期限、nonce 與 scope，不保存完整短碼或舊版長 Token。
- `searchRecords` 每次呼叫重新驗證 shortCode、期限、scope 與使用者／群組雜湊，再取得授權範圍內的 Users／OAuth Service／Sheet。結果只回傳時間、名稱、群組名稱、訊息、備註、類型與安全 HTTPS Drive link；LINE userId、groupId、Google Email、Token、Secret 與完整雜湊會被遮罩或不返回。
- 備份 Sheet 的「傳送者名稱」只接受清理後 displayName；控制字元會移除，`= + - @` 開頭會加上文字前綴避免試算表公式注入。Profile API 失敗時只寫 `user_<hash前8碼>` 或 `unknown_user`，不會使備份失敗。
- 管理者不會因此取得其他使用者資料；群組 owner 只能透過自己的私訊查詢自己 Sheet 中的群組紀錄，一般群組成員沒有完整群組紀錄查詢權限。

## 容量查詢

- `容量`、`空間` 與 `Drive容量` 只接受私訊；群組只回覆請改用私訊，不會公開 owner 的容量。`群組容量` 也只接受私訊，並只列出目前要求者擁有的群組。
- Drive `about.get`、files.list 與遞迴容量掃描只使用該使用者自己的 OAuth Access Token；不新增 scope，維持 `drive.file`。
- Script Cache key 由 64 位 `lineUserHash` 加固定用途前綴／群組後綴組成，TTL 為 600 秒；不保存 Token、raw LINE userId、groupId 或 Email。
- API 403 `insufficientPermissions` 回覆重新綁定提示；其他 Drive 失敗只回覆暫時無法取得容量，安全 Log 僅含 `component`、`errorCode`、`correlationId`。

## 最小權限與 Token

- Google 朋友授權：`openid email profile drive.file`。
- LINE Channel Access Token 只在 Cloudflare Secret 與 GAS Script Properties 各存一份，供回覆與下載 Content。
- Apps Script OAuth2 Library 的 Script Properties 以 `LineUser_<64 位雜湊>` 分隔服務名稱；解除綁定呼叫 `reset()`。
- 容量、紀錄、個人備份、群組綁定與 Drive 初始化都只能透過共用 `getUserAccessToken_()` 讀取上述 Service。`重新授權` 只允許既有 Users 使用者取得新 Token，callback 會拒絕不同 Google Subject，並重用既有資源。
- 不把 Token 物件、Authorization header、原始 API body 或訊息文字傳給 `safeLog_`。

## 外部輸入限制

- Worker webhook Body 上限 1 MB，事件最多取前 100 筆；LINE 欄位有個別長度限制。
- GAS envelope 與 payload 有長度限制，event type、message type、timestamp 與字串欄位會驗證。
- 單檔預設 20,971,520 bytes（20 MiB）。管理者可提高，但 45 MiB 已接近 Apps Script 記憶體、執行時間與 LINE Content 下載的實務風險區，不保證成功；程式設定最高不得超過 49 MiB。
- URL 只接受 HTTP／HTTPS；標籤最多 20 個、每個 50 字元。
- 回覆最多 5,000 字元；檔名清除路徑與控制字元。

## 安全 Log

Worker Log 只允許 `component`、`status`、`correlationId` 與 `errorCode`。GAS Log／Errors 工作表只保存元件、錯誤碼、安全訊息與關聯 ID。`oauth-token` 診斷額外只允許 `userHashPrefix`、`hasUser`、`enabled`、`approvalStatus`、`hasOAuthToken`、`oauthServiceNameHash` 與短 `correlationId`；不輸出 Service 名稱本身。`doPost` 在 Worker envelope 完整驗證成功前，只能寫不含輸入內容的安全 Console Log；無效 JSON、HMAC、timestamp 或 nonce 不得寫入管理試算表。任何除錯不得臨時輸出 payload、signature、nonce、Token、Request header、Script Properties、OAuth Service storage、原始識別碼、訊息文字或完整 webhook payload。

### 一次性 HMAC 診斷模式

`HMAC_DIAGNOSTIC_ENABLED` 在 Worker 與 GAS 預設為 `false`。只有為定位 `SIGNATURE_INVALID` 而進行的一次性測試才暫時設為 `true`，完成比對後應立即在兩端改回 `false` 並重新部署／更新 Web App。診斷只使用固定公開字串 `line-backup-hmac-diagnostic-v1` 計算 HMAC-SHA256 指紋，並輸出前 16 個小寫十六進位字元；完整 signing input 只輸出 SHA-256 前 16 碼，Signature 只輸出前 16 碼，Script ID 只輸出最後 8 碼。診斷 Log 不包含 Secret、payload、nonce、原始識別碼、完整 Signature、GAS URL 或 Token。診斷關閉時不會產生任何指紋欄位。

## 重試、去重與資料清理

- Jobs 使用 webhookEventId 去重。檔案上傳成功後會先保存 `DriveFileId`；即使後續 Sheet 寫入失敗，FAILED 狀態仍保留該 ID，下一次 Queue 重試會沿用既有檔案，不重新上傳。
- PROCESSING 具有預設 600 秒租約；有效租約不可重取，過期租約可在 Script Lock 內重新取得並保留 File ID。下載、上傳與 Sheet 寫入邊界會延長租約，終態清除租約。
- Drive 上傳使用由 webhookEventId 衍生的 `lineBackupEventKey` appProperty。重試會在同一目標資料夾先查詢相同 key；`drive.file` scope 限制為本應用程式可見的檔案。appProperties 不是唯一約束，完全同時的上傳仍有極小競爭視窗。
- Job 更新以 `PRESERVE`、`SET`、`CLEAR` 明確區分保留、設定與清空 Drive File ID。只有確定沒有可沿用檔案的拒絕流程才清空。
- 管理者可手動執行 `cleanupExpiredAdminRecords`，刪除過期 Nonces、已過期的 PENDING／COMPLETED BindingSessions、超過保留天數的 Errors，以及超過保留天數且狀態為 COMPLETED 的 Jobs。可恢復的 AUTHORIZED／PROVISIONING／FAILED Session 與 PROCESSING Job 不會被刪除；函式也不刪除 Users、Groups、Invitations 或任何使用者 Drive 檔案。
- `ERROR_RETENTION_DAYS` 與 `COMPLETED_JOB_RETENTION_DAYS` 控制保留天數；預設分別為 30 天與 90 天。

## Secret 輪替

1. LINE Channel Secret：先更新 LINE 與 Worker，切換期間 webhook 會驗證失敗；安排短維護窗。
2. LINE Access Token：先在 LINE 發行新 Token，再同時更新 Worker 與 GAS，驗證後撤銷舊 Token。
3. `WORKER_GAS_SHARED_SECRET`：Worker 與 GAS 必須同時切換；短暫不一致會進 DLQ。
4. `BIND_TOKEN_SECRET`：只影響尚未完成的短效 Bind Token；可在清空／等待既有短效連結過期後同步更新 Worker 與 GAS，不影響 Users 或 OAuth Service 名稱。
5. `IDENTIFIER_HASH_SECRET`：上線後不可直接輪替；直接更換會切斷所有永久雜湊與 OAuth／Drive 對應。
6. Google Client Secret：更新 GAS Script Properties，既有 Refresh Token 通常仍可用；若撤銷 OAuth Client，所有人須重綁。

## 群組查詢隔離

- 「群組識別」只保存 `groupId` 的 HMAC 雜湊；舊 Sheet 缺欄或舊列空白時不重排、不清空，查詢只在 owner／管理者、owner Sheet、來源為 group、群組名稱唯一一致等條件成立時 fallback，否則提示只能查詢新紀錄。`migrateLegacyGroupRecordHashes()` 只補唯一可判斷的舊列。
- 群組摘要最多回覆最新 5 筆，移除 Drive URL、File ID、messageId、webhookEventId、raw LINE identifier。完整群組查詢 Token 為版本 2，綁定要求者雜湊、群組雜湊、期限與 nonce；Script Properties 只保存 Token HMAC 雜湊。
- `searchRecords` 重新驗證群組 owner／管理者範圍，並以 owner 的 OAuth Service 讀取 owner Sheet；即使管理者取得連結，也不會把 owner 的 Token 或 Email 傳給頁面。
