# 專案狀態

最後更新：2026-08-06

目前為完成一次性 HMAC 診斷模式的 MVP。GAS 程式已同步並更新既有 Web App deployment；Worker 已完成本輪部署，未設定 LINE Webhook，也未 Commit 或 Push。

## 已完成

- 新增長期固定的 `IDENTIFIER_HASH_SECRET`。Worker 與 GAS 只用它建立 LINE 使用者、群組、邀請、nonce、OAuth Service、Drive 事件與資源的用途隔離 HMAC；`BIND_TOKEN_SECRET` 只簽短效 Bind Token，`WORKER_GAS_SHARED_SECRET` 只簽 Worker→GAS envelope。UTF-8 固定向量與金鑰輪替行為已有 Worker 自動測試及 GAS 手動測試。
- Jobs 使用 `LeaseExpiresAt`。第一次 claim 會建立 600 秒 PROCESSING 租約；有效租約不可重取，GAS 會回 `JOB_IN_PROGRESS` 與剩餘秒數加 5 秒緩衝，Worker 延後 Queue retry 且不 ACK。過期租約與 FAILED Job 可重取並增加 `RetryCount`，且保留既有 `DriveFileId`；COMPLETED、REJECTED、UNSENT 仍安全 ACK。
- 附件以 webhookEventId 的用途隔離 HMAC 作為 Drive `appProperties.lineBackupEventKey`。沒有 Jobs File ID 時會先在同一目標資料夾查詢，找到即回填 File ID，不重新下載或上傳。
- 綁定流程支援 `PENDING`、`AUTHORIZED`、`PROVISIONING`、`COMPLETED`、`FAILED`。Google 授權成功後保留 OAuth Token；Drive／Sheet 初始化可重試並以 `lineBackupResourceKey` 重用部分資源。只有資源與 Users 資料備妥後，才在 Script Lock 內以單一 Sheets API 批次扣除邀請次數、完成 Session、消耗 nonce 並啟用使用者。
- 新增管理者恢復入口 `resumeAuthorizedBinding()`。AUTHORIZED、FAILED 與租約已過期的 PROVISIONING Session 可在不重新消耗邀請碼的情況下恢復；完成後的 callback 會拒絕重播。
- 新增 `ENABLE_PUSH_FALLBACK=false`。所有指令仍經 Queue；只有 LINE 明確回報 Reply Token 無效、GAS 有回覆文字且存在收件者時，才可選擇嘗試 Push。Reply／Push 失敗不會重做備份，一般成功附件不會自動 Push。
- 新增一次性 `HMAC_DIAGNOSTIC_ENABLED`（Worker／GAS 預設 `false`）。診斷只記錄固定格式的短指紋，不輸出 Secret、payload、nonce、Token、URL 或原始識別碼；本輪受控測試期間暫時啟用，完成後應立即關閉。
- GAS `doPost` 只有在 Worker HMAC、timestamp 與 nonce 完整驗證後，才允許寫入 Errors 或更新 Job；未驗證要求只留下不含輸入內容的安全 Console Log。
- 預設單檔上限為 20 MiB；45 MiB 已在設定與操作文件標示為高風險且不保證成功。
- `cleanupExpiredAdminRecords` 只清除過期 Nonces、已過期的 PENDING／COMPLETED BindingSessions、逾期 Errors 與逾期 COMPLETED Jobs；不刪除可恢復 Session、PROCESSING Jobs、Users、Groups、Invitations 或 Drive 檔案。
- 已同步架構、資料流、安全設計、設定範例、LINE／Google／Cloudflare 操作、朋友指南、測試案例、成本配額、故障排除與部署文件。

## 本機驗證

- `npm run typecheck`：成功，TypeScript strict 無錯誤。
- `npm run lint`：成功，ESLint 無錯誤。
- `npm test`：成功，7 個 test files、61 個 tests 全部通過。
- Coverage：statements 88.01%、branches 83.95%、functions 94.64%、lines 88.05%。`gas-client.ts`、`line-client.ts` 與診斷 Log 分支均有測試。
- `npm run build`：成功，Wrangler dry-run bundle 25.16 KiB、gzip 6.68 KiB；正式部署於本輪驗證後執行。
- `npm audit --audit-level=high`：成功，0 個已知漏洞。
- GAS 語法：17 個 `.gs` 以 Node.js `vm.Script` UTF-8 parser 全部通過。
- JSON／JSONC：`appsscript.json`、`script-properties.example.json`、`package.json`、`package-lock.json`、`.clasp.json.example` 解析成功；`wrangler.jsonc.example` 的格式、`GAS_REQUEST_TIMEOUT_MS=55000`、`max_retries >= 5` 與 DLQ 設定均驗證成功。
- Secret 掃描：10 類高風險憑證格式為 0 命中；Repository 內沒有正式 `.env`、`.dev.vars`、`wrangler.jsonc`、`.clasp.json` 或 `.clasprc.json`。
- 文件：19 份 Markdown 的相對連結檢查通過；已補充一次性 HMAC 診斷開關與關閉流程。
- Git：目前分支為 `main`，Repository 尚無 Commit，67 個交付檔案全部為 untracked；`git diff` 因無已追蹤基準而沒有輸出。本次未 Commit、未 Push。

Wrangler dry-run 以明確 `src/index.ts` 入口驗證 bundle，因此顯示 `No bindings found`；正式人工測試部署時才會複製 `wrangler.jsonc.example` 為被忽略的 `wrangler.jsonc`，由 Wrangler 載入 Queue bindings。Vitest 與 Wrangler 在 Windows 沙箱內因暫存檔／診斷 Log 權限遇到 `EPERM`，改在獲准的沙箱外執行後均通過。

## 尚需人工完成

- 在專用測試管理 Sheet 執行 `TEST_CASES.md` 列出的 GAS TestFunctions，尤其是 `JOB_IN_PROGRESS` 不寫 Errors、租約延遲邊界、延後後辨識 COMPLETED、過期重取、FAILED File ID 保留、Drive 事件冪等鍵及 OAuth 恢復。
- 用管理者測試帳號驗證 OAuth2 Library state、Google `handleCallback`、Sheets API 最終批次、`drive.file` 對應用程式建立之 Sheet 的存取，以及 `resumeAuthorizedBinding()` 恢復流程。
- 建立測試用 LINE、Google、Apps Script 與 Cloudflare 資源後，驗證 Queue retry／DLQ、PROCESSING 租約逾期回收、Drive appProperties 查找、Reply Token 逾期、可選 Push，以及一般群組 owner 與多帳號 Drive 隔離。
- 正式提供朋友使用前，先由管理者自己完成小檔端對端測試、撤銷／重綁與錯誤復原演練；不要一開始就提高到 45 MiB。

## 部署判斷

本輪 Worker 部署版本已通過 `/health` HTTP 200 安全回應驗證；GAS Web App deployment 已更新至版本 3。`HMAC_DIAGNOSTIC_ENABLED` 目前為受控診斷用途暫時啟用，完成一次 LINE「說明」測試並收集必要短指紋後，必須在 GAS 與 Worker 同步改回 `false` 並重新更新／部署。尚未設定 LINE Webhook，也未開始朋友邀請流程；正式提供朋友使用前仍須依 `FIRST_TIME_SETUP.md` 完成人工端對端驗證。
