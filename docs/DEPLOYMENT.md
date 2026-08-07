# 完整手動部署順序

本文件是操作核對表，詳細畫面與欄位分別在 LINE、Google Cloud、GAS 與 Cloudflare 文件。執行部署表示會建立外部資源，應由 Repository 擁有者自行完成。

## A. 部署前

- [ ] Repository 的 `git status` 不含 `.dev.vars`、`wrangler.jsonc`、`.clasp.json` 或其他正式設定。
- [ ] `npm ci`、typecheck、lint、test、build 全部通過。
- [ ] 已建立密碼管理器項目，分別保存 `WORKER_GAS_SHARED_SECRET`、`BIND_TOKEN_SECRET` 與 `IDENTIFIER_HASH_SECRET` 3 組不同的高熵 HMAC Secret。
- [ ] 管理 Sheet 只分享給管理者。

## B. Google 與 GAS

- [ ] Drive API、Sheets API 已啟用。
- [ ] OAuth consent 已設定，測試帳號已加入 Test users。
- [ ] OAuth Web Client redirect URI 是 Apps Script `/usercallback`。
- [ ] OAuth2 Library 已加入，identifier 為 `OAuth2`。
- [ ] 17 個 GAS Properties 已逐項核對；`DELETE_DRIVE_ON_UNSEND` 初期為 `false`、`JOB_PROCESSING_LEASE_SECONDS=600`，2 個保留天數已設定；若啟用自助綁定，`ENABLE_SELF_SERVICE_BINDING=true`、`REQUIRE_ADMIN_APPROVAL=true` 且 `ADMIN_LINE_USER_HASHES` 只填管理者雜湊。
- [ ] 管理 Sheet 7 個工作表初始化成功；Jobs 包含 `LeaseExpiresAt`，BindingSessions 包含恢復狀態欄位。
- [ ] GAS Web App 以管理者執行，Anyone 可呼叫；`/exec` health 正常。

預期結果：直接 GET 只顯示 `status=ok`；未帶 Worker HMAC 的 POST 會回安全錯誤，不會建立 Jobs。

## C. Cloudflare

- [ ] 主 Queue 與 DLQ 名稱和 `wrangler.jsonc` 完全相同。
- [ ] 同一 Worker 同時綁定 producer `BACKUP_QUEUE` 與 consumer。
- [ ] 6 個 Secret 已由 `wrangler secret put` 設定，未寫入檔案；其中 3 組 HMAC 金鑰用途分離且兩端一致。
- [ ] `MAX_FILE_SIZE_BYTES` 與 GAS 相同。
- [ ] `ENABLE_PUSH_FALLBACK=false`；若決定啟用，已確認 Push 訊息可能計入 LINE 官方帳號訊息用量。
- [ ] 部署後 `/health` 回 HTTP 200。

預期結果：Cloudflare Dashboard 顯示 1 個 Worker、2 個 Queue，主 Queue consumer 指向該 Worker。

## D. LINE

- [ ] 已允許 Bot 加入群組。
- [ ] Webhook URL 是 Worker `/webhook`，Use webhook 已啟用。
- [ ] Verify 顯示 Success。
- [ ] 自動回應已關閉，避免雙重訊息。

## E. 自己先測

1. 若使用邀請碼模式，建立 1 次性邀請碼並綁定自己；若使用自助模式，先完成自助綁定並由管理者核准自己的安全化代號。
2. 檢查自己的 Drive 資源與 Users 列。
3. 傳文字、網址、`#標籤`、小圖片與小型一般檔案。
4. 檢查 Sheet 16 欄、台北時間、Drive ID／連結與 Jobs COMPLETED。
5. 確認 Jobs 有 `LeaseExpiresAt`，完成後該欄清空；執行 `testDriveEventIdempotencyKey`，並在受控重送同一 webhookEventId 時確認不新增第 2 份 Drive 檔案。`lineBackupEventKey` 屬 Drive appProperties，不會顯示在一般 Drive 網頁介面。
6. 傳超限檔案；預期拒絕且不建立 Drive 檔案。
7. 收回一則已備份訊息；預期 Sheet 標為「已收回」，Drive 檔案預設保留。

## F. 朋友與群組

1. 自助模式下，朋友私訊輸入 `綁定`，管理者從 `待審核` 取得安全化代號後輸入 `核准 <編號>`；邀請碼模式則每人使用獨立邀請碼，不要用一個高次數共用碼。
2. 朋友私訊綁定自己的 Google 帳號，執行私訊隔離測試。
3. 建一般群組並邀 Bot；擁有者輸入 `綁定群組`。
4. 不同成員各傳 1 個附件。預期都進 owner Drive，且 sender 欄是各自不同的 HMAC。
5. 在群組傳一般聊天，預期不入 Queue／Sheet；提及 Bot 或 `#筆記` 才會保存。

## G. 完成後

- [ ] 檢查 Worker Log、Apps Script Executions 與 Errors，確認無 Secret 或原始內容。
- [ ] 檢查 DLQ 為空。
- [ ] 記錄部署版本與日期，但不要記錄 Secret／Token／實際 URL。
- [ ] 告知朋友撤銷與解除綁定方式。
- [ ] 手動執行一次 `cleanupExpiredAdminRecords`，確認只顯示安全刪除筆數；依用量安排日後人工清理。
- [ ] 將 `IDENTIFIER_HASH_SECRET` 標示為「上線後不可直接輪替」；如需輪替，先設計資料與 OAuth Service 遷移。
