# Cloudflare Worker 與 Queue 設定

本文件列出部署時才由管理者執行的操作；本次原始碼建立不會登入或建立任何 Cloudflare 資源。

## 1. 本機確認

在 `cloudflare-worker` 目錄執行：

```powershell
npm ci
npm run check
npm test
npm run build
```

預期 typecheck、ESLint、Vitest 與 Wrangler dry-run 都以 exit code 0 結束，`dist` 只產生本機建置輸出且已被 `.gitignore` 排除。

## 2. 建立設定檔

1. 複製 `wrangler.jsonc.example` 為 `wrangler.jsonc`。
2. `name` 改成自己的非敏感 Worker 名稱。
3. Queue 名稱可保留範例或改為相同的自訂名稱；producer 與 consumer 的 `queue` 必須完全一致。
4. `vars` 不是 Secret，只放檔案上限、綁定期限、GAS timeout 與 Push fallback 開關。不要在此放 Token、Secret 或 endpoint。

## 3. 登入與建立 Queue

由管理者自行執行 `npx wrangler login`，瀏覽器預期顯示 Cloudflare 授權頁；確認帳號後允許。接著依 `wrangler.jsonc` 的名稱建立：

```powershell
npx wrangler queues create line-google-drive-backup
npx wrangler queues create line-google-drive-backup-dlq
```

預期每次顯示 Queue created。Dashboard 的 Queues 清單應看到主 Queue 與 DLQ。Queue 名稱只能使用英數與連字號，1 至 63 字元。

同一個 Worker 同時是 producer 與 consumer；不需建立第二個 Worker。設定中的 `BACKUP_QUEUE` 是程式 binding 名稱，不是 Secret。

## 4. Cloudflare Secret 完整對照

以下 6 項逐一執行 `npx wrangler secret put <NAME>`，在提示後貼值。Wrangler 預期顯示已上傳 Secret，不會把值寫進 `wrangler.jsonc`。

| 名稱 | 取得位置與格式 | Secret | 可提交 Git | 設錯現象 |
|---|---|---:|---:|---|
| `LINE_CHANNEL_SECRET` | LINE Channel Basic settings 的 Channel Secret，完整單行 | 是 | 否 | Webhook 全部回 401，Verify 失敗 |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Messaging API 發行的完整 Token | 是 | 否 | 備份可能成功但 Reply API 失敗 |
| `GAS_ENDPOINT_URL` | GAS Web App 完整 `/exec` URL | 敏感設定 | 否 | Queue 出現 `GAS_NETWORK_ERROR`／HTTP error |
| `WORKER_GAS_SHARED_SECRET` | 與 GAS 完全相同，至少 32 隨機 bytes | 是 | 否 | GAS 拒絕簽章，工作重試 |
| `BIND_TOKEN_SECRET` | 與 GAS 完全相同，且不同於其他金鑰；只簽署 Bind Token | 是 | 否 | 綁定 Token 驗證失敗；輪替後未使用的舊連結失效 |
| `IDENTIFIER_HASH_SECRET` | 與 GAS 完全相同，至少 32 隨機 bytes；只建立永久識別雜湊 | 是 | 否 | Worker 與 GAS 算出的 lineUserHash 不同，綁定遭拒；上線後直接輪替會讓既有識別關聯失效 |

`.dev.vars.example` 只示範名稱。若要本機 `wrangler dev`，複製成被忽略的 `.dev.vars` 並只放測試環境值；不要使用正式 Token 做自動測試。

## 5. 非 Secret vars

`wrangler.jsonc` 的 `vars` 共 4 項：

| 名稱 | 範例 | 說明與錯誤現象 |
|---|---:|---|
| `MAX_FILE_SIZE_BYTES` | `20971520` | 預設 20 MiB；GAS 必須設同值。45 MiB 屬高風險且不保證成功；超過 49 MiB 會回退安全預設 |
| `BIND_TOKEN_TTL_SECONDS` | `600` | 綁定連結秒數，允許 1 至 3600；錯誤時用 600 |
| `GAS_REQUEST_TIMEOUT_MS` | `55000` | Worker 等 GAS 毫秒數，最大 60000。timeout 不表示 GAS 已停止；重送遇有效租約時會依 GAS 回傳延後，不可 ACK |
| `ENABLE_PUSH_FALLBACK` | `false` | 預設不補送。設為 `true` 時，只在 LINE 明確回覆 Reply Token 過期或無效、GAS 有回覆文字且有收件者時嘗試 Push；Push 可能計入 LINE 官方帳號訊息用量 |

三組 HMAC 金鑰必須分開保存：`IDENTIFIER_HASH_SECRET` 不得與 `BIND_TOKEN_SECRET` 或 `WORKER_GAS_SHARED_SECRET` 共用。`BIND_TOKEN_SECRET` 可按事件應變程序輪替，但會使尚未使用的舊 Bind Token 失效；系統已有正式資料後不可直接輪替 `IDENTIFIER_HASH_SECRET`，否則既有使用者、群組、邀請、OAuth Service 與 Drive 冪等鍵將無法對應。

## 6. 部署與預期結果

執行 `npx wrangler deploy`。預期輸出 Worker 名稱、Queue producer／consumer bindings 與公開 workers.dev URL。不要把 URL Commit；把它設到 LINE Webhook 即可。

瀏覽 `https://<Worker>/health`，預期 HTTP 200 與 `{"status":"ok"}`。根路徑應回 404。健康檢查不會顯示 Secret 是否存在。

Dashboard 的 Queue Consumers 應只看到這個 Worker。若部署說已有其他 consumer，先確認沒有把同一主 Queue 綁給另一個 Worker，不要任意刪除未知資源。

## 7. 觀測與 DLQ

- Worker Log 只應看到 component、status、correlationId、errorCode，不應看到 Token、原始訊息或附件。
- 範例 consumer 的 `max_retries` 維持 `5`，並設定 `line-google-drive-backup-dlq`。主 Queue 超過最大重試次數後，訊息會進 DLQ；先依 errorCode 修正設定，再用 Dashboard 小量重送，不要在未修正前全部重送。
- GAS 回 `JOB_IN_PROGRESS` 時，Worker 依 `retryAfterSeconds`（30 至 900 秒）呼叫 Queue retry，不 ACK。無效或缺少延遲時使用 60 秒；預設 600 秒租約會依當時剩餘時間加 5 秒，最高約 605 秒。
- 所有指令都先進 Queue，Reply Token 可能在 GAS 完成前過期。若 `ENABLE_PUSH_FALLBACK=false`，失效只留下安全錯誤；若開啟 fallback，只有 LINE 明確判定 Token 無效才嘗試 Push。Reply 或 Push 失敗都不會重做已完成的備份，一般成功附件也不會主動 Push。
