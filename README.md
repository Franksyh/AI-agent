
# Mini Codex

Mini Codex 是一個繁體中文的 AI 工作台，分成公開的網頁／手機 PWA 與擁有者的 Windows 本機伴侶程式。

- **公開工作台**：規劃任務、閱讀受信任開源來源、顯示服務狀態、語音輸入、文字朗讀、介面縮放、手機版與 PWA。
- **Windows Mini**：透過本機 Codex App Server 顯示真正的 Codex 對話、匯入既有 thread、讀取與修改專案、審查開源更新、用原生檔案選擇器開啟你選取的電腦檔案，以及在每次需要時核准工具操作。
- **安全邊界**：公開網頁永遠無法直接讀取你的檔案、匯入 Codex 對話、使用憑證或控制電腦。這些能力只在 `127.0.0.1` 的本機 Mini，且由擁有者核准。

## 公開連結

部署後可從下列網址使用：

- Vercel：<https://future-assistant.vercel.app>
- Netlify：<https://franksyh-ai-agent.netlify.app>
- GitHub：<https://github.com/Franksyh/AI-agent>

舊的 `/mini-codex-cloud.html` 會自動導向新版首頁。

## 功能

### 公開工作台與手機版

- Codex 風格的三欄介面：對話歷史、聊天／規劃、任務／更新／權限面板。
- 語音輸入只會填入文字框，必須由使用者送出；可選擇朗讀回覆。
- 80%、90%、100%、115%、130% 介面縮放，支援 `Ctrl/Cmd +`、`-`、`0`。
- PWA 可安裝到手機或電腦。
- 開源來源頁會讀取 GitHub 的公開中繼資料，顯示最新 commit、授權和快速篩選分數。
- 公開使用者是「使用與讀取」角色；免費／專業版選擇只是一項本機介面偏好，未連接付款服務，也不會提升權限。
- Google、GitHub、ChatGPT/Codex、Gemini、Perplexity 和 Siri 的狀態會誠實顯示為可用、需設定或平台不支援；網站不蒐集 API 金鑰。

### Windows Mini（擁有者）

1. 雙擊 `Start-Mini-Codex.cmd` 開啟桌面工作台與可拖曳 Mini。
2. 雙擊 `Start-Mini-Web.cmd` 只開啟本機網頁工作台。
3. Mini 右鍵可開啟工作台、複製本機連結、隱藏／重新顯示 Mini、調整 75% 至 150% 的機器人大小，或結束服務。
4. 本機 UI 支援語音輸入、選擇朗讀、縮放與手機對話抽屜。
5. `匯入 Codex 對話紀錄` 會讀取本機 Codex threads，複製顯示紀錄到 Mini；原始 thread 不會被修改或上傳。
6. `開源更新審查` 只追蹤受信任的來源。先檢查授權與最新 commit，再下載至隔離資料夾；擁有者可用唯讀 Codex 分析程式碼，且不會自動安裝、執行或採用。
7. 工作模式預設是唯讀或工作區修改。擁有者可選擇全機協助模式，但每次工具與高風險操作仍由 Codex 的核准流程處理。
8. `選擇並開啟檔案` 只會在桌面 Mini 顯示 Windows 原生檔案選擇器。瀏覽器不會傳送檔案路徑；只有你親自選取的一般檔案才會交給預設應用程式開啟。文字預覽為選用、受限長度的本機顯示，不會自動傳給 AI。

需要 Python 3.10+、Tcl/Tk（桌面 Mini）與已安裝、已登入的 Codex CLI。Mini 不讀取或儲存 OpenAI 帳號憑證。

詳細本機使用方式：[mini_codex/README.md](mini_codex/README.md)。

## 權限模型

| 位置 | 身分 | 可做的事 |
| --- | --- | --- |
| Windows 本機 Mini | 擁有者（啟動 Windows 帳號） | 讀取、編輯、核准、來源審查、匯入本機 Codex 對話、用原生選擇器開啟檔案、選擇電腦協助模式 |
| 公開工作台 | 訪客／一般使用者 | 使用規劃、閱讀公開資料、提出協作訊息 |
| 公開工作台 | 付費方案介面選擇 | 目前僅展示方案偏好；未啟用付款或額度管理 |

公開協作 session 的建立者是該 session 的 owner；加入者是 member。伺服器端限制 member 只能傳遞文字、連線測試或請求，只有 session owner 能關閉 session。這個協作 owner 不等於 Windows 電腦的擁有者。

Google OAuth、付費訂閱與真正的雲端聊天紀錄需要在部署平台另行設定身分驗證、資料庫、OAuth 用戶端與付款服務；程式不會把「未設定」顯示成已連結或已保護。

## API

兩個部署平台提供相同的公開端點：

```text
GET  /api/state
GET  /api/workflows
GET  /api/sources
GET  /api/providers
GET  /api/access
POST /api/chat
POST /api/plan
POST /api/brief
POST /api/remote
```

- Netlify 函式：`netlify/functions/agent.mts`，遠端協作記錄使用 Netlify Blobs。
- Vercel 函式：`api/[...route].js`。沒有設定持久化儲存時，Vercel 的 remote session 僅適合示範，不能作為可靠的跨執行個體協作儲存。

## 開發與驗證

```powershell
npm run check
python -m unittest discover -s mini_codex/tests -v
npx netlify dev
```

## 部署

本專案已連結到 GitHub、Vercel 與 Netlify。推薦流程是先部署 preview、驗證首頁與 `/api/state`、`/api/sources`，最後才部署 production：

```powershell
$env:VERCEL_TELEMETRY_DISABLED='1'
npx --yes vercel deploy --yes
npx --yes vercel deploy --prod --yes
npx --yes netlify deploy --prod
```

部署時不要提交帳號權杖、OAuth secret、API key 或本機 Mini 的資料目錄。

## 參考來源

- [OpenAI Codex App Server](https://developers.openai.com/codex/app-server/)
- [解鎖 Codex 的運作機制](https://openai.com/zh-Hant/index/unlocking-the-codex-harness/)
- [OpenAI gpt-oss](https://github.com/openai/gpt-oss)
- [Gemini CLI](https://blog.google/intl/zh-tw/products/cloud/gemini-cli-your-open-source-ai-agent/)
- [Claude Code](https://code.claude.com/docs/zh-TW/overview)
- [Perplexity Bumblebee](https://www.perplexity.ai/zh-TW/hub/blog/perplexity-is-open-sourcing-bumblebee)
- [Apple Intelligence CLI](https://github.com/onmyway133/apple-intelligence-cli)
- [Siri Ultra](https://github.com/fatwang2/siri-ultra)

Mini Codex 的介面和機器人圖示為本專案原創，不隸屬或偽裝為任何上述服務的官方產品。
