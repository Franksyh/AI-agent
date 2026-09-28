# Mini Codex 分階段執行表

依需求分段交付；每個階段先驗證，再接續下一階段。公開服務不取得 Windows 本機權限，所有跨平台功能都要清楚標示實際可用狀態。

## 第 1 階段：公開網站與本機工作台 — 已完成

- Vercel：<https://future-assistant-jade.vercel.app>
- Netlify 備援：<https://franksyh-ai-agent.netlify.app>
- GitHub：<https://github.com/Franksyh/AI-agent>
- 公開版支援手機／桌面 PWA 安裝、響應式 Codex 風格工作區、對話、語音文字、縮放、隱藏 Mini 與開源來源更新。
- Windows ZIP：<https://github.com/Franksyh/AI-agent/archive/refs/heads/main.zip>；本機版透過 Codex App Server 工作，讀取或編輯電腦檔案由擁有者在本機核准。
- 已驗證 Vercel 與 Netlify 公開頁、隱私頁、API、安裝圖示可回應，且現有 15 項 Python 測試通過。

## 第 2 階段：帳號與 AI 服務串接 — 部分完成

- Google OAuth 與 Drive／Gmail 唯讀匯入流程已寫好；正式部署尚未設定 `GOOGLE_CLIENT_ID`，因此目前顯示未設定。完成 Google Cloud Web OAuth 用戶端與同意畫面後，才可啟用。
- 開源來源目前更新 GitHub 公開中繼資料；分數不是 AI 程式碼審查。Windows 本機版可透過使用者已登入的 Codex 做唯讀程式審查。
- Gemini、Perplexity、ChatGPT API、Siri／Apple Intelligence 目前不是可互換的完整雲端代理。下一步要逐一使用官方 API 或官方 CLI、完成憑證設定與能力測試，再做模型選擇與回退。
- 一般使用者的公開聊天目前以規則式工作規劃為主，尚未連上雲端大型語言模型。

## 第 3 階段：帳號、方案、會員付款 — 尚未開始

- 免費／會員選項目前只是介面偏好，尚無登入會員資料、訂閱狀態、付費牆或收款。
- 需先選定會員權益、價格、退款／服務條款和收款商；若使用綠界 ECPay，還需商家帳號及測試環境資料。
- 實作需包含伺服器端建立訂單、驗證付款回呼、持久化會員狀態及權限檢查；不能只依瀏覽器回報「已付款」。

## 第 4 階段：手機與桌面安裝包 — 部分完成

- 現在可直接安裝 PWA；Windows 本機伴侶程式可下載 ZIP 後執行啟動檔。
- Android AAB、Windows MSIX 與原生 iOS 專案尚未生成／送審。需設定應用程式識別碼、簽章和各商店開發者帳號；iOS 原生簽署建置需 macOS／Xcode。

## 第 5 階段：商店與正式營運 — 尚未開始

- Microsoft Store、Google Play、Apple App Store 均未提交。
- 上架前需要平台帳號、商店圖片與文案、資料安全／隱私聲明、支援方式、簽署憑證和審核。
- Google Play 新個人開發者帳號可能有封閉測試要求；Apple 會審核 app 的功能與品質。

## 需要營運者在自己的平台完成的設定

1. Google Cloud：建立 Web OAuth Client，加入正式網站來源，並在 Vercel／Netlify 設定 `GOOGLE_CLIENT_ID`。
2. AI 服務：依選用的官方服務，在部署平台祕密環境變數設定 API 金鑰；不可把金鑰提交 GitHub 或貼在聊天。
3. 會員付款：決定方案、價格與付款商，申請商家帳號並以沙箱資料測試。
4. 商店發布：準備 Microsoft Partner Center、Google Play Console 與 Apple Developer 帳號及產品資料。
