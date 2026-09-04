# Google Cloud 與 OAuth 設定

## 1. 建立專案

1. 用管理者 Google 帳號進入 Google Cloud Console，選擇專案選單後按「New Project」。
2. 輸入不含個資的專案名稱，例如 `private-line-backup`，建立並切換到它。
3. 預期頂端專案選單顯示新專案名稱；後續所有 API 與 OAuth Client 都要在同一專案。

## 2. 啟用 API

1. 到「APIs & Services」→「Library」。
2. 搜尋並啟用 Google Drive API。預期按鈕由 Enable 變為 Manage。
3. 搜尋並啟用 Google Sheets API。預期同樣顯示已啟用。
4. 不需要建立 Service Account；本專案必須代表每位朋友自己的 Google 帳號操作。

## 3. 建立 Apps Script 並取得 Script ID

先依 `GOOGLE_APPS_SCRIPT_SETUP.md` 建立空白 Apps Script 專案。到 Apps Script「Project Settings」複製 Script ID。Script ID 不是 Client Secret，但仍不必公開。

OAuth callback URI 必須是：

```text
https://script.google.com/macros/d/<SCRIPT_ID>/usercallback
```

這是 OAuth2 Library 的 callback，絕對不是 Web App 的 `/exec` URL。也可在 Apps Script 手動執行 `logOAuthCallbackUriForAdmin_()`，預期 Execution log 顯示完全相同的 URI；勿把 Log 內容提交 Git。

## 4. 設定 OAuth Consent Screen

1. 到「Google Auth Platform」或「OAuth consent screen」。
2. 私人 Gmail 與跨網域朋友選 External；只有同一 Google Workspace 組織且管理政策允許時才選 Internal。
3. 填 App name、User support email 與 Developer contact email。不要在名稱中放 LINE userId 或朋友姓名。
4. 加入 scope：`openid`、`email`、`profile`、`https://www.googleapis.com/auth/drive.file`。
5. Testing 階段把自己與每位受邀朋友的 Google 帳號加入 Test users。預期使用者清單能看到 email。
6. 注意：External 且 Publishing status 為 Testing 時，只要包含 `drive.file`，Google 一般會讓 Refresh Token 在 7 天後失效。長期私人使用前，須依 Google 當期政策評估切換 Production／驗證；不要用規避方式跳過驗證。若保持 Testing，朋友需定期重新綁定。

## 5. Google OAuth App 發布到 Production

Google OAuth App 若維持 Testing，且使用 `drive.file` 等非 `openid`／`email`／`profile` 的 scope，Refresh Token 可能受到測試期限制而週期性失效。若要提供朋友或正式使用者長期使用，應將 App 發布到 Production；Production 後，新授權使用者不應再因 Testing 模式定期失效。已經失效的使用者仍需重新授權一次取得新 Token。

管理者請依下列步驟手動操作：

1. 進入 Google Cloud Console。
2. 選擇 `LINE Google Drive Backup Test`，或實際使用的 Google Cloud 專案。
3. 進入「Google Auth Platform」→「OAuth consent screen」。
4. 檢查 Publishing status 是否為 `Testing`。
5. 檢查 App name、User support email、Developer contact information 與 Authorized domains。
6. 確認 OAuth scopes 包含 `openid`、`email`、`profile` 與 `https://www.googleapis.com/auth/drive.file`。
7. 確認沒有加入不必要的完整 `https://www.googleapis.com/auth/drive` scope。
8. 完成 Google 要求的檢查或驗證後，選擇「Publish App」，將 App 發布到 `Production`。
9. 發布後，既有已失效使用者私訊 Bot 輸入 `重新授權`；這只更新 OAuth Token，不刪除 Users、Drive、Sheet、群組或備份紀錄。
10. 測試既有帳號的 `狀態`、`容量`、`紀錄` 與小檔案，再測試新使用者的 `綁定`、文字與檔案。

本專案不會自動操作 Google Cloud Console、不讀取或輸出 Client Secret，也不會修改 OAuth Client ID／Secret。

## 6. 建立 OAuth Client

1. 到「Clients」或「Credentials」→「Create credentials」→「OAuth client ID」。
2. Application type 選 Web application。
3. Authorized redirect URIs 加入上一節精確的 `/usercallback` URI，不加 query string、不加 `/exec`，也不要多餘斜線。
4. 建立後預期看到 Client ID 與 Client Secret。兩者稍後放入 GAS Script Properties；Client Secret 絕不可 Commit。
5. 如果授權頁出現 `redirect_uri_mismatch`，比較錯誤頁 URI 與 Client 允許清單，尤其確認使用 Script ID 而不是 Deployment ID。

## 7. OAuth 權限預期畫面

朋友點綁定連結後，預期依序看到 Google 帳號選擇、App 名稱、權限清單與允許按鈕。權限應只包含基本身分與「查看、編輯、建立及刪除這個應用程式所建立或開啟的特定 Google Drive 檔案」類似描述；不應要求讀取所有 Drive。

若 App 尚未驗證，可能看到未驗證警告或只允許 Test users。這是 Google 安全流程，不要把 Client Secret 分享給朋友，也不要教使用者忽略與本專案不一致的權限。
