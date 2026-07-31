# LINE Official Account 與 Messaging API 設定

以下介面名稱可能因 LINE Console 改版略有不同；請以功能名稱為準。此步驟只建立服務資料，正式 Worker URL 要等 Cloudflare 部署後才填入。

## 1. 建立 LINE Official Account

1. 使用管理者自己的 LINE Business ID 登入 LINE Official Account Manager。
2. 選擇「建立新帳號」，填入不含個資的帳號名稱、業種與基本資料。
3. 建立後進入帳號首頁。預期會看到帳號名稱、Basic ID 與加入好友 QR code。
4. 到回應設定關閉「自動回應訊息」，並視需要關閉「加入好友的歡迎訊息」，避免同一則訊息同時收到官方預設回覆與 Bot 回覆。

## 2. 啟用 Messaging API Channel

1. 在 Official Account Manager 的設定中啟用 Messaging API，選擇或建立一個 Provider。
2. 進入 LINE Developers Console，打開剛建立的 Messaging API Channel。
3. 預期「Basic settings」會顯示 Channel ID；「Messaging API」頁會顯示 Webhook settings 與 Channel access token 區塊。

## 3. 取得 Channel Secret

1. 在「Basic settings」找到 Channel secret。
2. 這是 Secret，不要貼到文件、Issue、聊天室或 `wrangler.jsonc`。
3. 稍後把同一個值分別設為 Cloudflare `LINE_CHANNEL_SECRET`；GAS 不需要此 Secret。
4. 設錯時，Worker `/webhook` 會對所有 LINE 請求回傳 HTTP 401，LINE Verify 會失敗。

## 4. 發行 Channel Access Token

1. 在「Messaging API」頁找到 Channel access token。依 Console 提供的長效 Token 選項發行 Token。
2. 這是 Secret。稍後同時設為 Cloudflare 與 GAS 的 `LINE_CHANNEL_ACCESS_TOKEN`。
3. Worker 用它呼叫 Reply API；GAS 用它下載 LINE Content 與取得群組摘要。
4. 設錯時，Webhook 仍可能 Verify 成功，但回覆、附件下載或群組綁定會失敗。

本專案的指令會先經過 Cloudflare Queue，因此 LINE 的短效 Reply Token 可能在 GAS 完成前失效。`ENABLE_PUSH_FALLBACK` 預設為 `false`；只有管理者明確設為 `true`，且 LINE 回覆明確表示 Reply Token 已過期或無效時，Worker 才會嘗試以 Push API 補送指令文字。Push 失敗不會重新執行備份，一般附件成功也不會自動 Push；Push 訊息可能計入 LINE 官方帳號的訊息用量。

## 5. 允許加入群組

1. 在 Channel 的「Messaging API」設定開啟「Allow bot to join group chats」。此選項預設可能是關閉。
2. 預期開關顯示 Enabled／已啟用。
3. LINE 一般群組同一時間通常只能有 1 個 Official Account；若無法邀請，先確認群組是否已有其他 Bot。
4. 本專案只處理 source.type=`group`，不支援 LINE 社群；舊式 source.type=`room` 也不處理。

## 6. 稍後設定 Webhook

完成 Worker 部署後回到 Webhook settings：

1. Webhook URL 填入 `https://<你的 Worker 網域>/webhook`，不要把 URL Commit 到 Repository。
2. 開啟「Use webhook」。
3. 按「Verify」。預期看到 Success；若失敗，先開啟 Worker `/health`，再查 `TROUBLESHOOTING.md`。
4. Verify 成功後，把帳號加為好友並輸入「說明」。預期數秒內收到繁體中文指令清單。

## 安全檢查

- 不要截圖包含 Channel Secret 或完整 Access Token 的頁面。
- Token 輪替後，同步更新 Worker 與 GAS，再撤銷舊 Token。
- 不要開啟公開註冊或把邀請碼放在 Rich Menu、貼文或群組公告。
