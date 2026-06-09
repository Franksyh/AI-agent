#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
離線 AI agent 示範程式。

這不是大型語言模型，而是一個小型、可閱讀、可擴充的 agent 架構：
1. 感知：清理並理解使用者輸入
2. 思考：判斷意圖並選擇工具
3. 行動：執行計算、記憶、待辦、時間查詢等工具
4. 記憶：把重要資料存在 JSON 檔案，讓下次啟動仍可使用

執行：
    python ai_assistant.py
"""

from __future__ import annotations

import ast
import json
import operator
import os
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable


def default_memory_path() -> Path:
    configured = os.environ.get("AI_AGENT_MEMORY_FILE")
    if configured:
        return Path(configured)
    return Path(__file__).with_name("assistant_memory.json")


def now_text() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


class MemoryStore:
    """把 agent 的長期記憶存成簡單 JSON。"""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path or default_memory_path()
        self.data: dict[str, Any] = self._empty_data()
        self.load()

    @staticmethod
    def _empty_data() -> dict[str, Any]:
        return {"facts": {}, "notes": [], "tasks": [], "history": []}

    def load(self) -> None:
        if not self.path.exists():
            return

        try:
            loaded = json.loads(self.path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return

        base = self._empty_data()
        if isinstance(loaded, dict):
            for key in base:
                if key in loaded:
                    base[key] = loaded[key]
        self.data = base

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps(self.data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def remember(self, key: str, value: str) -> None:
        self.data.setdefault("facts", {})[key.strip()] = value.strip()
        self.save()

    def recall(self, key: str | None = None) -> str:
        facts = self.data.get("facts", {})
        if not facts:
            return "目前還沒有任何記憶。"

        if key:
            keyword = key.lower()
            matches = [
                f"{fact_key}: {value}"
                for fact_key, value in facts.items()
                if keyword in fact_key.lower() or keyword in str(value).lower()
            ]
            if matches:
                return "\n".join(matches)
            return f"找不到和「{key}」相關的記憶。"

        return "\n".join(f"- {fact_key}: {value}" for fact_key, value in facts.items())

    def add_note(self, text: str) -> None:
        self.data.setdefault("notes", []).append({"time": now_text(), "text": text.strip()})
        self.save()

    def list_notes(self) -> str:
        notes = self.data.get("notes", [])
        if not notes:
            return "目前沒有筆記。"
        recent_notes = notes[-10:]
        return "\n".join(f"- {item['time']}：{item['text']}" for item in recent_notes)

    def _next_task_id(self) -> int:
        tasks = self.data.get("tasks", [])
        ids = [task.get("id", 0) for task in tasks if isinstance(task.get("id"), int)]
        return max(ids, default=0) + 1

    def add_task(self, title: str) -> dict[str, Any]:
        task = {
            "id": self._next_task_id(),
            "title": title.strip(),
            "status": "pending",
            "created_at": now_text(),
            "completed_at": None,
        }
        self.data.setdefault("tasks", []).append(task)
        self.save()
        return task

    def add_tasks(self, titles: list[str]) -> list[dict[str, Any]]:
        tasks = [self.add_task(title) for title in titles if title.strip()]
        return tasks

    def list_tasks(self) -> str:
        tasks = self.data.get("tasks", [])
        if not tasks:
            return "目前沒有待辦。"

        lines = []
        for task in tasks:
            mark = "[x]" if task.get("status") == "done" else "[ ]"
            lines.append(f"{mark} #{task['id']} {task['title']}")
        return "\n".join(lines)

    def complete_task(self, task_id: int) -> str:
        for task in self.data.get("tasks", []):
            if task.get("id") == task_id:
                if task.get("status") == "done":
                    return f"#{task_id} 已經完成了。"
                task["status"] = "done"
                task["completed_at"] = now_text()
                self.save()
                return f"完成 #{task_id}：{task['title']}"
        return f"找不到 #{task_id} 這個待辦。"

    def complete_next_task(self) -> str:
        for task in self.data.get("tasks", []):
            if task.get("status") != "done":
                task["status"] = "done"
                task["completed_at"] = now_text()
                self.save()
                return f"完成下一步：#{task['id']} {task['title']}"
        return "沒有未完成的待辦。"

    def add_history(self, user_text: str, intent: str, summary: str) -> None:
        self.data.setdefault("history", []).append(
            {
                "time": now_text(),
                "input": user_text,
                "intent": intent,
                "summary": summary,
            }
        )
        self.data["history"] = self.data["history"][-50:]
        self.save()


class SafeCalculator:
    """只允許基本數學運算，避免使用 eval。"""

    OPERATORS: dict[type[ast.AST], Callable[[Any, Any], Any]] = {
        ast.Add: operator.add,
        ast.Sub: operator.sub,
        ast.Mult: operator.mul,
        ast.Div: operator.truediv,
        ast.FloorDiv: operator.floordiv,
        ast.Mod: operator.mod,
        ast.Pow: operator.pow,
    }

    UNARY_OPERATORS: dict[type[ast.AST], Callable[[Any], Any]] = {
        ast.UAdd: operator.pos,
        ast.USub: operator.neg,
    }

    def calculate(self, expression: str) -> str:
        try:
            tree = ast.parse(expression, mode="eval")
            result = self._eval(tree.body)
        except Exception as exc:
            return f"計算失敗：{exc}"
        return str(result)

    def _eval(self, node: ast.AST) -> Any:
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            return node.value

        if isinstance(node, ast.BinOp) and type(node.op) in self.OPERATORS:
            left = self._eval(node.left)
            right = self._eval(node.right)
            if isinstance(node.op, ast.Pow) and abs(right) > 12:
                raise ValueError("次方太大，為了安全先拒絕。")
            return self.OPERATORS[type(node.op)](left, right)

        if isinstance(node, ast.UnaryOp) and type(node.op) in self.UNARY_OPERATORS:
            return self.UNARY_OPERATORS[type(node.op)](self._eval(node.operand))

        raise ValueError("只支援數字與 + - * / // % ** ()")


@dataclass
class AgentStep:
    description: str
    tool: str
    arguments: dict[str, Any] = field(default_factory=dict)


@dataclass
class BrainDecision:
    intent: str
    perception: str
    reasoning: str
    steps: list[AgentStep] = field(default_factory=list)
    direct_message: str = ""
    should_exit: bool = False


class AIAgent:
    """一個小型 agent：理解輸入、決定工具、執行動作並更新記憶。"""

    def __init__(self, memory: MemoryStore) -> None:
        self.memory = memory
        self.calculator = SafeCalculator()

    def handle(self, user_text: str) -> str:
        perceived = self._perceive(user_text)
        decision = self._decide(perceived)

        if decision.should_exit:
            return "__EXIT__"

        if decision.direct_message:
            self.memory.add_history(perceived, decision.intent, decision.direct_message)
            return decision.direct_message

        action_results = [self._act(step) for step in decision.steps]
        response = self._format_response(decision, action_results)
        self.memory.add_history(perceived, decision.intent, "; ".join(action_results))
        return response

    def _perceive(self, text: str) -> str:
        return re.sub(r"\s+", " ", text.strip())

    def _decide(self, text: str) -> BrainDecision:
        lowered = text.lower()

        if not text:
            return BrainDecision(
                intent="chat",
                perception="收到空白輸入。",
                reasoning="需要請使用者輸入目標或指令。",
                direct_message="請輸入一個目標或指令。輸入 help 可以查看範例。",
            )

        if lowered in {"exit", "quit", "bye", "再見", "離開", "結束"}:
            return BrainDecision(
                intent="exit",
                perception=f"收到離開指令：{text}",
                reasoning="使用者想結束程式。",
                should_exit=True,
            )

        if lowered in {"help", "指令", "幫助", "說明"}:
            return BrainDecision(
                intent="help",
                perception="使用者想查看指令。",
                reasoning="直接顯示可用工具與範例。",
                direct_message=self._help_text(),
            )

        remember_match = re.match(
            r"^(?:記住|remember)\s+(.+?)\s*(?:=|:|：|是|為)\s*(.+)$",
            text,
            re.IGNORECASE,
        )
        if remember_match:
            key, value = remember_match.groups()
            return BrainDecision(
                intent="remember",
                perception=f"要記住「{key.strip()}」。",
                reasoning="這是長期記憶寫入需求，選擇 memory 工具。",
                steps=[
                    AgentStep(
                        "寫入記憶",
                        "remember",
                        {"key": key.strip(), "value": value.strip()},
                    )
                ],
            )

        recall_match = re.match(r"^(?:回想|查記憶|recall)\s*(.*)$", text, re.IGNORECASE)
        if recall_match or text in {"記憶", "所有記憶"}:
            key = recall_match.group(1).strip() if recall_match else ""
            return BrainDecision(
                intent="recall",
                perception="使用者想讀取記憶。",
                reasoning="這是記憶查詢需求，選擇 recall 工具。",
                steps=[AgentStep("讀取記憶", "recall", {"key": key})],
            )

        if text in {"顯示筆記", "筆記列表", "notes", "show notes"}:
            return BrainDecision(
                intent="notes",
                perception="使用者想查看筆記。",
                reasoning="選擇 notes 工具列出最近筆記。",
                steps=[AgentStep("列出筆記", "notes")],
            )

        note_match = re.match(r"^(?:筆記|note)\s+(.+)$", text, re.IGNORECASE)
        if note_match:
            return BrainDecision(
                intent="note",
                perception="使用者想新增一則筆記。",
                reasoning="選擇 note 工具保存文字。",
                steps=[AgentStep("新增筆記", "note", {"text": note_match.group(1).strip()})],
            )

        task_add_match = re.match(r"^(?:待辦|todo)\s*(?:新增|add)\s+(.+)$", text, re.IGNORECASE)
        if task_add_match:
            return BrainDecision(
                intent="task_add",
                perception="使用者想新增待辦。",
                reasoning="選擇 task_add 工具，把任務放進記憶。",
                steps=[AgentStep("新增待辦", "task_add", {"title": task_add_match.group(1)})],
            )

        task_done_match = re.match(
            r"^(?:(?:待辦|todo)\s*)?(?:完成|done)\s*#?(\d+)$",
            text,
            re.IGNORECASE,
        )
        if task_done_match:
            return BrainDecision(
                intent="task_done",
                perception="使用者想完成指定待辦。",
                reasoning="選擇 task_done 工具更新狀態。",
                steps=[
                    AgentStep(
                        "完成待辦",
                        "task_done",
                        {"task_id": int(task_done_match.group(1))},
                    )
                ],
            )

        if text in {"待辦", "待辦列表", "todo", "tasks"}:
            return BrainDecision(
                intent="task_list",
                perception="使用者想查看待辦。",
                reasoning="選擇 task_list 工具列出任務狀態。",
                steps=[AgentStep("列出待辦", "task_list")],
            )

        if text in {"下一步", "執行下一步", "next"}:
            return BrainDecision(
                intent="next_step",
                perception="使用者想推進目前的任務。",
                reasoning="選擇 next_step 工具，完成第一個未完成待辦。",
                steps=[AgentStep("執行下一步", "next_step")],
            )

        calc_match = re.match(r"^(?:計算|幫我算|算|calculate|calc)\s+(.+)$", text, re.IGNORECASE)
        if calc_match:
            return self._calculator_decision(calc_match.group(1))

        if re.fullmatch(r"[0-9+\-*/().% \t]+", text):
            return self._calculator_decision(text)

        if any(keyword in lowered for keyword in ["時間", "幾點", "日期", "time", "date"]):
            return BrainDecision(
                intent="clock",
                perception="使用者想知道目前時間。",
                reasoning="選擇 clock 工具讀取本機時間。",
                steps=[AgentStep("查詢時間", "clock")],
            )

        goal_match = re.match(r"^(?:目標|任務|goal|task)\s*[:：]?\s*(.+)$", text, re.IGNORECASE)
        if goal_match:
            return self._goal_decision(goal_match.group(1).strip())

        if text.startswith(("幫我", "請幫我", "請你", "我要", "我想")):
            return self._goal_decision(text)

        if any(keyword in lowered for keyword in ["為什麼", "怎麼", "如何", "什麼", "why", "how", "what"]):
            return BrainDecision(
                intent="reason",
                perception=f"收到問題：{text}",
                reasoning="這是概念或方法問題，先用結構化方式拆解回答。",
                steps=[AgentStep("產生分析", "reason", {"question": text})],
            )

        if lowered in {"hi", "hello", "hey", "你好", "哈囉"}:
            return BrainDecision(
                intent="chat",
                perception="收到招呼。",
                reasoning="回應招呼並提示可輸入目標。",
                direct_message="你好，我是這台電腦裡的小型 AI agent。給我一個目標，我會拆解、執行可用工具，並把結果記住。",
            )

        return BrainDecision(
            intent="chat",
            perception=f"收到一般輸入：{text}",
            reasoning="沒有符合特定工具，改用一般回應。",
            steps=[AgentStep("一般回應", "chat", {"text": text})],
        )

    def _calculator_decision(self, expression: str) -> BrainDecision:
        return BrainDecision(
            intent="calculate",
            perception=f"偵測到數學式：{expression.strip()}",
            reasoning="這是計算需求，選擇安全計算工具。",
            steps=[
                AgentStep(
                    "執行計算",
                    "calculator",
                    {"expression": expression.strip()},
                )
            ],
        )

    def _goal_decision(self, goal: str) -> BrainDecision:
        plan = self._make_goal_plan(goal)
        return BrainDecision(
            intent="goal",
            perception=f"收到目標：{goal}",
            reasoning="這是開放式任務，先拆成可執行步驟，再寫入待辦記憶。",
            steps=[AgentStep("建立任務計畫", "goal_plan", {"goal": goal, "plan": plan})],
        )

    def _make_goal_plan(self, goal: str) -> list[str]:
        lower_goal = goal.lower()

        if any(keyword in lower_goal for keyword in ["ai agent", "人工智慧代理", "代理"]):
            return [
                "定義 agent 要接收的輸入與可以使用的工具",
                "建立決策流程：先判斷意圖，再選擇下一個動作",
                "加入可執行工具，例如計算、記憶、筆記、待辦與時間查詢",
                "把任務結果寫進記憶，讓下次互動可以延續",
                "用幾個常見指令測試 agent 是否能正常行動",
            ]

        if any(keyword in goal for keyword in ["機票", "航班", "旅行", "東京", "大阪", "首爾"]):
            return [
                "確認出發地、目的地、日期、人數與預算",
                "蒐集多個來源的價格、航班時間與行李規則",
                "比較總價、轉機次數、飛行時間與退改票條件",
                "整理前三個選項，標示最便宜與最省時間的方案",
            ]

        if any(keyword in goal for keyword in ["學習", "讀書", "考試", "準備"]):
            return [
                "釐清要達成的學習成果與期限",
                "把主題拆成每天可以完成的小單元",
                "安排練習、複習與自我測驗",
                "追蹤進度並調整下一輪計畫",
            ]

        if any(keyword in goal for keyword in ["寫", "建立", "製作", "做一個", "開發"]):
            return [
                "確認需求與完成標準",
                "設計最小可用版本",
                "實作核心功能",
                "測試結果並修正問題",
                "整理使用方式與下一步建議",
            ]

        return [
            "釐清目標與限制",
            "拆解成可以執行的小步驟",
            "先完成最重要的一步",
            "檢查結果並決定是否調整方法",
        ]

    def _act(self, step: AgentStep) -> str:
        tool = step.tool
        args = step.arguments

        if tool == "remember":
            self.memory.remember(args["key"], args["value"])
            return f"已記住：{args['key']} = {args['value']}"

        if tool == "recall":
            return self.memory.recall(args.get("key") or None)

        if tool == "note":
            self.memory.add_note(args["text"])
            return f"已新增筆記：{args['text']}"

        if tool == "notes":
            return self.memory.list_notes()

        if tool == "task_add":
            task = self.memory.add_task(args["title"])
            return f"已新增待辦 #{task['id']}：{task['title']}"

        if tool == "task_done":
            return self.memory.complete_task(args["task_id"])

        if tool == "task_list":
            return self.memory.list_tasks()

        if tool == "next_step":
            return self.memory.complete_next_task()

        if tool == "calculator":
            result = self.calculator.calculate(args["expression"])
            return f"{args['expression']} = {result}"

        if tool == "clock":
            return f"現在時間：{now_text()}"

        if tool == "goal_plan":
            plan = args["plan"]
            tasks = self.memory.add_tasks(plan)
            lines = [f"{index}. {title}" for index, title in enumerate(plan, start=1)]
            task_ids = ", ".join(f"#{task['id']}" for task in tasks)
            return "已建立計畫並寫入待辦：\n" + "\n".join(lines) + f"\n待辦編號：{task_ids}"

        if tool == "reason":
            question = args["question"]
            return (
                f"我會這樣拆解「{question}」：\n"
                "1. 先確認問題的目標是理解概念、做決策，還是完成任務。\n"
                "2. 找出需要的資訊與限制。\n"
                "3. 把答案整理成可以行動的步驟。\n"
                "4. 如果需要執行，就轉成待辦或呼叫工具。"
            )

        if tool == "chat":
            return f"我收到：「{args['text']}」。你也可以輸入「目標：...」，我會幫你拆解並建立待辦。"

        return f"未知工具：{tool}"

    def _format_response(self, decision: BrainDecision, action_results: list[str]) -> str:
        action_text = "\n".join(f"- {result}" for result in action_results)
        return (
            f"感知：{decision.perception}\n"
            f"思考：{decision.reasoning}\n"
            f"行動：\n{action_text}\n"
            "記憶：這次互動已寫入 history。"
        )

    def _help_text(self) -> str:
        return (
            "可用指令：\n"
            "- 目標：幫我做一個 AI agent\n"
            "- 記住 名字 = Frank\n"
            "- 回想 名字\n"
            "- 筆記 今天完成了 agent 雛形\n"
            "- 顯示筆記\n"
            "- 待辦 新增 測試計算功能\n"
            "- 待辦\n"
            "- 完成 1\n"
            "- 下一步\n"
            "- 計算 (12 + 8) * 3\n"
            "- 現在幾點\n"
            "- exit"
        )


class AssistantApp:
    def __init__(self) -> None:
        self.memory = MemoryStore()
        self.agent = AIAgent(self.memory)

    def run(self) -> None:
        print("AI Agent 已啟動。輸入 help 看範例，輸入 exit 離開。")
        while True:
            try:
                user_text = input("\n你：")
            except (EOFError, KeyboardInterrupt):
                print("\nAgent：再見。")
                break

            answer = self.agent.handle(user_text)
            if answer == "__EXIT__":
                print("Agent：再見，記憶已保存。")
                break
            print(f"Agent：{answer}")


if __name__ == "__main__":
    AssistantApp().run()
