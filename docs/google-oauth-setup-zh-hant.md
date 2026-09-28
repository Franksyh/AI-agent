# Mini Codex Google 帳號連結設定

這份設定會啟用公開網站的 Google 帳號連結。Google 登入只用於確認帳號；Drive 和 Gmail 的唯讀權限會在使用者分別按下讀取按鈕時才要求。網站以 Google Identity Services 的瀏覽器 token popup 取得短期權杖；權杖只留在目前頁面的記憶體，不會傳到 Mini Codex 伺服器或寫入瀏覽器儲存。

## 1. 建立 Google Cloud 專案並設定同意畫面

1. 前往 [Google Cloud Console](https://console.cloud.google.com/) 並登入自己的 Google 帳號。
2. 建立一個專案，例如 `Mini Codex`，或選擇專門給 Mini Codex 使用的專案。
3. 開啟 **Google Auth Platform → Branding**，按 **Get started**（如果尚未設定）。填入應用程式名稱 `Mini Codex`、使用者支援電子郵件和開發者聯絡電子郵件，再儲存。
4. 到 **Audience**。若要用一般個人 Google 帳號測試，選 **External**，並先將自己的 Google 電子郵件加到 **Test users**。在測試期間，未列入的帳號不能完成授權。
5. 暫時先留在測試模式。公開服務及 Gmail 權限是否需送 Google 驗證，要在測試成功、準備正式開放前處理。

## 2. 開啟需要的 Google API

在 Google Cloud Console 的 **APIs & Services → Library** 搜尋並啟用：

- **Google Drive API**：要使用 Mini Codex 的 Drive 文件清單與匯入功能時需要。
- **Gmail API**：要使用 Gmail 郵件清單與匯入功能時需要。

只想先測試 Google 帳號連結，可先不使用 Drive/Gmail 功能；它們會在你按下個別按鈕時才要求額外權限。

## 3. 建立 Web OAuth Client ID

1. 開啟 **Google Auth Platform → Clients**，選 **Create client**。
2. Application type 選 **Web application**，名稱可填 `Mini Codex Websites`。
3. 在 **Authorized JavaScript origins** 加入兩個正式網站來源（只填協定與網域，不要加路徑）：

   ```text
   https://future-assistant-jade.vercel.app
   https://franksyh-ai-agent.netlify.app
   ```

4. 這個網站目前使用瀏覽器 popup token 流程，**Authorized redirect URIs 留空即可**。
5. 按建立並複製 **Client ID**。它通常以 `.apps.googleusercontent.com` 結尾。

Client ID 是網站需要的公開識別碼；**不要複製或傳送 Client Secret**。這個 Mini Codex 瀏覽器流程不需要 Client Secret。

## 4. 設定網站擁有者帳號並驗證

在部署平台的 **Project/Site settings → Environment variables** 設定兩個 production 環境變數，並重新部署：

- `GOOGLE_CLIENT_ID`：上一節建立的 Web OAuth Client ID。它是公開識別碼，不是密碼。
- `OWNER_GOOGLE_EMAIL`：你要作為網站擁有者的 Google 帳號電子郵件。只能有這個已驗證帳號取得雲端網站擁有者身分；其他 Google 帳號仍是訪客。

Vercel 在 **Settings → Environment Variables** 設定；Netlify 在 **Project configuration → Environment variables** 設定。兩個網站分開設定。完成後觸發新的 Production 部署。不要把 Google Client Secret、密碼或 API 金鑰貼到聊天或寫進原始碼；這個登入流程不需要 Client Secret。

如果由維護者代為設定，只需提供 Client ID 和擁有者 email，不能提供密碼或任何 secret。環境變數設好前，登入按鈕會維持關閉。

部署完成後可檢查：

- Vercel：[Google OAuth 狀態](https://future-assistant-jade.vercel.app/api/auth/google)
- Netlify：[Google OAuth 狀態](https://franksyh-ai-agent.netlify.app/api/auth/google)

兩個網址的 `/api/auth/google` 都應回傳 `ownerLogin.enabled: true`。開啟網站「設定 → 權限」後，按 Google 登入；只有 `OWNER_GOOGLE_EMAIL` 指定的已驗證帳號會顯示「網站擁有者」，一般訪客不會得到本機電腦存取權。管理者登入使用伺服器驗證的 Google ID token 與最長一小時的 HttpOnly Cookie；登出後會清除 Cookie。Drive 與 Gmail 是不同的唯讀授權，需在「AI 與帳號連結」各自操作。

## 正式公開前的重要限制

- `https://www.googleapis.com/auth/gmail.readonly` 是 Google 分類的 **restricted scope**。公開給一般使用者前可能需提交 OAuth 驗證；若應用程式在自己的伺服器儲存或傳送受限制資料，Google 另可能要求安全評估。Mini Codex 目前把 Google 權杖留在瀏覽器，但正式申請仍須如實申報資料流向與功能。
- Google 可能要求完成品牌驗證、公開隱私權政策及其他審查。未驗證前先用 Test users；不要承諾一般訪客已可使用 Gmail 讀取。
- 這組 OAuth 用戶端設定只啟用**網頁版** Google OAuth；Windows 桌面封裝、iOS/Android 原生 App 需要各自評估適用的用戶端類型與商店政策。

## 官方文件

- [建立 Google API Client ID](https://developers.google.com/identity/oauth2/web/guides/get-google-api-clientid)
- [設定 OAuth 同意畫面與 scopes](https://developers.google.com/workspace/guides/configure-oauth-consent)
- [Google Identity Services Token Model](https://developers.google.com/identity/oauth2/web/guides/use-token-model)
- [Google ID token 的伺服器端驗證](https://developers.google.com/identity/sign-in/web/backend-auth)
- [啟用 Google Workspace APIs](https://developers.google.com/workspace/guides/enable-apis)
- [Gmail API 權限範圍與驗證分類](https://developers.google.com/workspace/gmail/api/auth/scopes)
