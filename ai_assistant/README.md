# AI Agent 離線示範

這是一個可以在本機執行的 Python AI agent 範例。它展示 agent 的四個核心能力：

- 感知：接收並整理使用者輸入
- 思考：判斷意圖，決定要使用哪個工具
- 行動：執行計算、時間查詢、筆記、待辦與記憶操作
- 記憶：把事實、筆記、待辦與互動歷史存到 `assistant_memory.json`

這個版本不需要網路，也不需要 API key。它不是大型語言模型，而是一個清楚可讀、方便擴充的 agent 架構。

## 執行方式

```bash
python ai_assistant.py
```

## 可以試的指令

```text
help
目標：幫我做一個 AI agent
記住 名字 = Frank
回想 名字
筆記 今天完成了 agent 雛形
顯示筆記
待辦 新增 測試計算功能
待辦
完成 1
下一步
計算 (12 + 8) * 3
現在幾點
exit
```

## 運作流程

```text
使用者輸入
  -> 感知 perceive
  -> 思考 decide
  -> 行動 act
  -> 記憶 memory
  -> 回覆使用者
```

## 主要檔案

- `ai_assistant.py`：agent 主程式
- `assistant_memory.json`：執行後自動產生的記憶資料

## 擴充方向

你可以在 `AIAgent._decide()` 增加新的意圖判斷，並在 `AIAgent._act()` 增加新的工具，例如網頁搜尋、檔案整理、寄信、行事曆提醒，或接上真正的 AI API。
