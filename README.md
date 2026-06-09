# Future Assistant

Future Assistant 是一個動態 AI Agent 工作台，支援手機版、電腦版與網頁版遠端連線，用來展示「理解目標、拆解步驟、使用工具、交付結果」的完整流程。

公開網站：

https://franksyh-ai-agent.netlify.app

## 這次優化

- 從純靜態頁升級為 Netlify 動態網站。
- 新增跨裝置遠端連線：電腦版建立 session，手機版/網頁版用配對碼或 QR code 加入。
- 遠端 session 使用 Netlify Blobs 保存裝置、心跳與指令事件。
- 新增 Netlify Functions API：`/api/state`、`/api/chat`、`/api/plan`、`/api/workflows`、`/api/brief`、`/api/remote`。
- 聊天回覆、任務拆解、工作流程模板、檔案摘要會由伺服器端即時產生。
- 前端保留瀏覽器備援模式，API 暫時不可用時仍能操作。
- 修正介面文字亂碼，改成完整繁體中文。
- 將首頁改成可直接操作的 AI Agent 工作台。
- 加入目標拆解器，可把任務轉成四階段工作計畫。
- 加入 GitHub + Netlify 發布流程模板。
- 加入檔案摘要工具，支援文字、Markdown、CSV、JSON、HTML、CSS、JS。
- 加入搜尋草稿、工作流程模板、語音輸入與無障礙設定。
- Netlify 公開站會自動偵測動態 API，並在介面顯示 `Dynamic`。

## 動態 API

Netlify Functions 位於：

```text
netlify/functions/agent.mts
```

主要端點：

```text
GET  /api/state
GET  /api/workflows
POST /api/chat
POST /api/plan
POST /api/brief
POST /api/remote
```

## 遠端連線

1. 在電腦版或網頁版打開公開網站。
2. 進入「遠端連線」分頁，選擇裝置類型並建立主控連線。
3. 系統會產生配對碼、連線網址與 QR code。
4. 手機版或另一個瀏覽器開啟連線網址，或輸入配對碼加入。
5. 加入後可看到裝置清單、在線狀態，並透過指令佇列傳送文字、連線測試、開啟網址或確認請求。

這個版本提供跨裝置遠端連線基礎設施；真正執行電腦控制時，仍建議由桌面端 Agent 保留人工確認點。

## 本機執行

前端可直接由瀏覽器開啟 `index.html`，此時會使用瀏覽器備援模式。

若要在本機測試 Netlify 動態 API，建議使用：

```powershell
npx netlify-cli dev
```

若要啟動本機 Python 助理服務：

```powershell
python .\assistant_server.py
```

預設網址：

```text
http://127.0.0.1:8765
```

指定其他 port：

```powershell
python .\assistant_server.py 8899
```

## 部署流程

1. 檢查工作區狀態。
2. Commit 並推送到 GitHub `main`。
3. 部署到 Netlify 專案 `franksyh-ai-agent`。
4. 驗證公開網址可正常開啟。

## Repo 維護

`.gitignore` 已忽略 Netlify 本機狀態與 Python 快取檔，避免把產生物提交到 GitHub。
