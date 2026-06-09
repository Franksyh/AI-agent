# Future Assistant

Future Assistant 是一個 AI Agent 工作台，用來展示「理解目標、拆解步驟、使用工具、交付結果」的完整流程。

公開網站：

https://franksyh-ai-agent.netlify.app

## 這次優化

- 修正介面文字亂碼，改成完整繁體中文。
- 將首頁改成可直接操作的 AI Agent 工作台。
- 加入目標拆解器，可把任務轉成四階段工作計畫。
- 加入 GitHub + Netlify 發布流程模板。
- 加入檔案摘要工具，支援文字、Markdown、CSV、JSON、HTML、CSS、JS。
- 加入搜尋草稿、工作流程模板、語音輸入與無障礙設定。
- Netlify 靜態部署時不再依賴後端 API，避免公開站功能失效。
- 本機若啟動 Python 後端，前端會自動偵測並切換為本機 Agent 已連線。

## 本機執行

靜態頁面可直接由瀏覽器開啟 `index.html`。

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
