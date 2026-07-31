# 私人多人共用 LINE Google Drive 備份 Bot

這是一套可自行部署的邀請制 MVP。所有人共用同一個 LINE Bot，但每位使用者以自己的 Google OAuth Token，把私訊附件存入自己的 Google Drive，並把文字、網址與標籤寫入自己的 Google Sheet。一般群組由一位已綁定使用者擔任備份擁有者。

> 本專案不支援 LINE 社群、公開註冊、AI、OCR 或付費會員。請勿提交任何真實 Secret 或正式 URL。

## 最短啟動路徑

1. 閱讀 [首次設定](docs/FIRST_TIME_SETUP.md) 並建立 LINE、Google Cloud、Apps Script 與 Cloudflare 資源。
2. 在 `cloudflare-worker` 執行 `npm ci`、`npm run check`、`npm test` 與 `npm run build`。
3. 複製 `wrangler.jsonc.example` 為 `wrangler.jsonc`，再依 [Cloudflare 設定](docs/CLOUDFLARE_SETUP.md) 建立 Queue 與 Secret。
4. 複製 `.clasp.json.example` 為 `.clasp.json`，依 [Google Apps Script 設定](docs/GOOGLE_APPS_SCRIPT_SETUP.md) 加入 OAuth2 Library、Script Properties 並部署 Web App。
5. 依 [部署流程](docs/DEPLOYMENT.md) 串接 Worker webhook，完成 LINE Verify 後先測試自己的帳號。

本次產出不會自動部署、建立遠端資源、執行 OAuth 同意或 Push Git。

## 功能摘要

- 私訊：圖片、影片、音訊與一般檔案進入自己的 Drive；一般文字與網址進入自己的備份 Sheet。
- 群組：附件進入群組擁有者的 Drive；文字只在提及 Bot、使用 `#筆記` 或指定指令時處理。
- 指令：`綁定 <邀請碼>`、`狀態`、`解除綁定`、`綁定群組`、`解除群組`、`#筆記 <內容>`、`說明`。
- 防護：LINE 原始 Body 簽章、Worker→GAS HMAC、防重播、工作租約、Drive `appProperties` 冪等、邀請碼雜湊與短效綁定 Token。
- 金鑰分工：`IDENTIFIER_HASH_SECRET` 只建立長期識別雜湊；`BIND_TOKEN_SECRET` 只簽署短效綁定 Token；`WORKER_GAS_SHARED_SECRET` 只驗證 Worker→GAS envelope。首次上線後不可直接輪替 `IDENTIFIER_HASH_SECRET`。
- 預設單檔上限為 20 MiB；45 MiB 屬 Apps Script 高風險設定且不保證成功。
- 附件只在 GAS 執行期間存在記憶體，不永久保存在 Cloudflare 或管理者的 Drive。

所有指令都經 Cloudflare Queue 處理，因此 LINE Reply Token 可能在回覆前過期。可選的 Push fallback 預設關閉，且只在 LINE 明確回覆 Reply Token 無效時使用；備份結果應以 Drive、Sheet 與 Jobs 狀態為準。

## 專案目錄

- `cloudflare-worker/`：TypeScript webhook producer、Queue consumer 與單元測試。
- `google-apps-script/`：GAS OAuth、LINE Content、Drive／Sheets API 與管理試算表 Repository。
- `docs/`：架構、安全、設定、部署、測試與故障排除文件。

完整資料流請見 [DATA_FLOW.md](docs/DATA_FLOW.md)，安全邊界請見 [SECURITY_DESIGN.md](docs/SECURITY_DESIGN.md)，目前驗證狀態請見 [PROJECT_STATUS.md](docs/PROJECT_STATUS.md)。
