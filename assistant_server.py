from __future__ import annotations

import base64
import ctypes
import html
import json
import os
import platform
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser
from dataclasses import asdict, dataclass
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
SCREENSHOT_DIR = STATIC_DIR / "screenshots"
MEMORY_FILE = ROOT / "agent_memory.json"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
MAX_MEMORY_ITEMS = 200


DANGEROUS_COMMAND_PATTERNS = [
    r"\bremove-item\b.*\s-(recurse|r)\b",
    r"\brm\b.*\s-rf\b",
    r"\bdel\b.*\s/[sq]\b",
    r"\bformat\b\s+[a-z]:",
    r"\bdiskpart\b",
    r"\bbcdedit\b",
    r"\bshutdown\b",
    r"\brestart-computer\b",
    r"\bstop-computer\b",
    r"\bclear-recyclebin\b",
    r"\breg\s+delete\b",
    r"\bset-executionpolicy\b",
]


class AssistantError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


@dataclass
class SuggestedAction:
    title: str
    action: str
    payload: dict[str, Any]
    risk: str = "low"


def now_ms() -> int:
    return int(time.time() * 1000)


def json_dumps(data: Any) -> bytes:
    return json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")


def read_json(handler: SimpleHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("Content-Length", "0") or "0")
    raw = handler.rfile.read(length) if length else b"{}"
    if not raw:
        return {}
    try:
        data = json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise AssistantError(f"JSON 格式錯誤：{exc}", 400) from exc
    if not isinstance(data, dict):
        raise AssistantError("請傳入 JSON object。", 400)
    return data


def is_windows() -> bool:
    return platform.system().lower() == "windows"


def powershell_exe() -> str:
    return os.environ.get("POWERSHELL_EXE") or "powershell.exe"


def command_is_dangerous(command: str) -> str | None:
    normalized = command.lower()
    for pattern in DANGEROUS_COMMAND_PATTERNS:
        if re.search(pattern, normalized, flags=re.IGNORECASE):
            return pattern
    return None


def classify_command(command: str) -> str:
    if command_is_dangerous(command):
        return "high"
    if re.search(
        r"\b(new-item|copy-item|move-item|rename-item|set-content|add-content|npm|pip|python|node|git)\b",
        command,
        re.I,
    ):
        return "medium"
    return "low"


def run_powershell(command: str, timeout: int = 30, cwd: str | None = None) -> dict[str, Any]:
    utf8_command = (
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); "
        "$OutputEncoding = [Console]::OutputEncoding; "
        + command
    )
    proc = subprocess.run(
        [
            powershell_exe(),
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            utf8_command,
        ],
        cwd=cwd or str(ROOT),
        capture_output=True,
        text=True,
        timeout=max(1, min(int(timeout or 30), 120)),
        encoding="utf-8",
        errors="replace",
    )
    return {
        "ok": proc.returncode == 0,
        "exitCode": proc.returncode,
        "stdout": proc.stdout[-12000:],
        "stderr": proc.stderr[-12000:],
    }


def execute_command(payload: dict[str, Any]) -> dict[str, Any]:
    command = str(payload.get("command", "")).strip()
    if not command:
        raise AssistantError("請輸入要執行的 PowerShell 指令。")

    confirmed = bool(payload.get("confirmed"))
    safety = str(payload.get("safety", "strict"))
    risk = classify_command(command)

    if not confirmed:
        return {
            "ok": False,
            "needsConfirmation": True,
            "message": "這個動作需要確認後才會執行。",
            "command": command,
            "risk": risk,
        }

    blocked_by = command_is_dangerous(command)
    if safety == "strict" and blocked_by:
        return {
            "ok": False,
            "blocked": True,
            "message": "安全模式已阻擋高風險指令。若你確定要執行，請先關閉嚴格安全模式。",
            "pattern": blocked_by,
        }

    result = run_powershell(
        command,
        timeout=int(payload.get("timeout", 30) or 30),
        cwd=str(payload.get("cwd") or ROOT),
    )
    append_memory("action", f"執行指令：{command}", {"resultOk": result["ok"], "risk": risk})
    return result


def open_url(url: str) -> dict[str, Any]:
    url = url.strip()
    if not url:
        raise AssistantError("請輸入網址。")
    if not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", url):
        url = "https://" + url
    webbrowser.open(url)
    append_memory("action", f"開啟網址：{url}", {"url": url})
    return {"ok": True, "message": f"已開啟 {url}", "url": url}


def open_app(target: str) -> dict[str, Any]:
    target = target.strip()
    if not target:
        raise AssistantError("請輸入應用程式名稱或檔案路徑。")
    try:
        if is_windows():
            os.startfile(target)  # type: ignore[attr-defined]
        else:
            subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", target])
    except OSError:
        subprocess.Popen(target, shell=True)
    append_memory("action", f"開啟：{target}", {"target": target})
    return {"ok": True, "message": f"已嘗試開啟 {target}", "target": target}


def search_files(query: str, base_dir: str | None = None, limit: int = 80) -> dict[str, Any]:
    query = query.strip().lower()
    if not query:
        raise AssistantError("請輸入要搜尋的檔名或關鍵字。")
    base = Path(base_dir or ROOT).expanduser()
    if not base.exists():
        raise AssistantError(f"找不到資料夾：{base}")

    results: list[dict[str, Any]] = []
    skipped = 0
    stop_after = max(1, min(int(limit), 200))
    ignored = {"node_modules", ".git", "__pycache__", ".venv", "venv", "AppData", "Local Settings"}

    for current, dirs, files in os.walk(base):
        dirs[:] = [d for d in dirs if d not in ignored and not d.startswith("$")]
        for name in files:
            if query in name.lower():
                path = Path(current) / name
                try:
                    stat = path.stat()
                except OSError:
                    skipped += 1
                    continue
                results.append(
                    {
                        "name": name,
                        "path": str(path),
                        "size": stat.st_size,
                        "modified": stat.st_mtime,
                    }
                )
                if len(results) >= stop_after:
                    append_memory("action", f"搜尋檔案：{query}", {"count": len(results), "truncated": True})
                    return {"ok": True, "results": results, "skipped": skipped, "truncated": True}

    append_memory("action", f"搜尋檔案：{query}", {"count": len(results), "truncated": False})
    return {"ok": True, "results": results, "skipped": skipped, "truncated": False}


def web_search(query: str, limit: int = 8) -> dict[str, Any]:
    query = query.strip()
    if not query:
        raise AssistantError("請輸入要搜尋的關鍵字。")

    search_url = "https://duckduckgo.com/html/?" + urllib.parse.urlencode({"q": query})
    request = urllib.request.Request(
        search_url,
        headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) LocalAgent/1.0"},
    )

    results: list[dict[str, str]] = []
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            body = response.read(700_000).decode("utf-8", errors="replace")
        pattern = re.compile(
            r'<a[^>]+class="result__a"[^>]+href="(?P<href>[^"]+)"[^>]*>(?P<title>.*?)</a>',
            re.I | re.S,
        )
        for match in pattern.finditer(body):
            href = html.unescape(match.group("href"))
            title = clean_html(match.group("title"))
            parsed = urllib.parse.urlparse(href)
            qs = urllib.parse.parse_qs(parsed.query)
            if "uddg" in qs:
                href = qs["uddg"][0]
            if title and href:
                results.append({"title": title, "url": href})
            if len(results) >= max(1, min(limit, 12)):
                break
    except Exception as exc:
        return {
            "ok": True,
            "results": [],
            "searchUrl": search_url,
            "warning": f"搜尋服務暫時無法解析結果：{exc}",
        }

    append_memory("action", f"網頁搜尋：{query}", {"count": len(results)})
    return {"ok": True, "results": results, "searchUrl": search_url}


def clean_html(value: str) -> str:
    value = re.sub(r"<[^>]+>", "", value)
    value = html.unescape(value)
    return re.sub(r"\s+", " ", value).strip()


def get_clipboard() -> dict[str, Any]:
    result = run_powershell("Get-Clipboard -Raw", timeout=5)
    return {"ok": result["ok"], "text": result["stdout"], "stderr": result["stderr"]}


def set_clipboard(text: str) -> dict[str, Any]:
    proc = subprocess.run(
        [powershell_exe(), "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "$Input | Set-Clipboard"],
        input=text,
        capture_output=True,
        text=True,
        timeout=10,
        encoding="utf-8",
        errors="replace",
    )
    append_memory("action", "更新剪貼簿", {"chars": len(text)})
    return {"ok": proc.returncode == 0, "stderr": proc.stderr, "exitCode": proc.returncode}


def screenshot() -> dict[str, Any]:
    if not is_windows():
        raise AssistantError("截圖功能目前只支援 Windows。")
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"screen-{now_ms()}.png"
    path = SCREENSHOT_DIR / filename
    safe_path = str(path).replace("'", "''")
    script = f"""
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bitmap.Save('{safe_path}', [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
"""
    result = run_powershell(script, timeout=15)
    if not result["ok"]:
        return result
    append_memory("action", "擷取螢幕截圖", {"path": str(path)})
    return {"ok": True, "url": f"/screenshots/{filename}", "path": str(path)}


class WindowsInput:
    KEYEVENTF_KEYUP = 0x0002
    KEYEVENTF_UNICODE = 0x0004
    MOUSEEVENTF_LEFTDOWN = 0x0002
    MOUSEEVENTF_LEFTUP = 0x0004
    MOUSEEVENTF_RIGHTDOWN = 0x0008
    MOUSEEVENTF_RIGHTUP = 0x0010

    VK = {
        "backspace": 0x08,
        "tab": 0x09,
        "enter": 0x0D,
        "shift": 0x10,
        "ctrl": 0x11,
        "control": 0x11,
        "alt": 0x12,
        "esc": 0x1B,
        "escape": 0x1B,
        "space": 0x20,
        "pageup": 0x21,
        "pagedown": 0x22,
        "end": 0x23,
        "home": 0x24,
        "left": 0x25,
        "up": 0x26,
        "right": 0x27,
        "down": 0x28,
        "insert": 0x2D,
        "delete": 0x2E,
        "win": 0x5B,
        "meta": 0x5B,
    }
    VK.update({chr(i + 65).lower(): i + 65 for i in range(26)})
    VK.update({str(i): 0x30 + i for i in range(10)})
    VK.update({f"f{i}": 0x6F + i for i in range(1, 13)})

    def __init__(self) -> None:
        if not is_windows():
            raise AssistantError("電腦控制功能目前只支援 Windows。")
        self.user32 = ctypes.windll.user32
        self._send_input = self.user32.SendInput

    def move(self, x: int, y: int) -> dict[str, Any]:
        self.user32.SetCursorPos(int(x), int(y))
        return {"ok": True, "message": f"滑鼠已移到 {x}, {y}"}

    def click(self, button: str = "left") -> dict[str, Any]:
        if button == "right":
            down, up = self.MOUSEEVENTF_RIGHTDOWN, self.MOUSEEVENTF_RIGHTUP
        else:
            down, up = self.MOUSEEVENTF_LEFTDOWN, self.MOUSEEVENTF_LEFTUP
        self.user32.mouse_event(down, 0, 0, 0, 0)
        self.user32.mouse_event(up, 0, 0, 0, 0)
        return {"ok": True, "message": f"已點擊 {button}"}

    def hotkey(self, keys: list[str]) -> dict[str, Any]:
        if not keys:
            raise AssistantError("請輸入快捷鍵。")
        vk_codes = [self.key_to_vk(key) for key in keys]
        for vk in vk_codes:
            self.user32.keybd_event(vk, 0, 0, 0)
        for vk in reversed(vk_codes):
            self.user32.keybd_event(vk, 0, self.KEYEVENTF_KEYUP, 0)
        return {"ok": True, "message": "已送出快捷鍵 " + "+".join(keys)}

    def type_text(self, text: str) -> dict[str, Any]:
        if not text:
            raise AssistantError("請輸入要打出的文字。")
        for char in text:
            self._send_unicode_char(char)
            time.sleep(0.002)
        return {"ok": True, "message": f"已輸入 {len(text)} 個字元"}

    def key_to_vk(self, key: str) -> int:
        key = key.strip().lower()
        if key not in self.VK:
            raise AssistantError(f"不支援的按鍵：{key}")
        return self.VK[key]

    def _send_unicode_char(self, char: str) -> None:
        class KEYBDINPUT(ctypes.Structure):
            _fields_ = [
                ("wVk", ctypes.c_ushort),
                ("wScan", ctypes.c_ushort),
                ("dwFlags", ctypes.c_ulong),
                ("time", ctypes.c_ulong),
                ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
            ]

        class INPUTUNION(ctypes.Union):
            _fields_ = [("ki", KEYBDINPUT)]

        class INPUT(ctypes.Structure):
            _fields_ = [
                ("type", ctypes.c_ulong),
                ("union", INPUTUNION),
            ]

        scan = ord(char)
        extra = ctypes.c_ulong(0)
        down = INPUT(
            type=1,
            union=INPUTUNION(ki=KEYBDINPUT(0, scan, self.KEYEVENTF_UNICODE, 0, ctypes.pointer(extra))),
        )
        up = INPUT(
            type=1,
            union=INPUTUNION(
                ki=KEYBDINPUT(0, scan, self.KEYEVENTF_UNICODE | self.KEYEVENTF_KEYUP, 0, ctypes.pointer(extra))
            ),
        )
        inputs = (INPUT * 2)(down, up)
        sent = self._send_input(2, ctypes.byref(inputs), ctypes.sizeof(INPUT))
        if sent != 2:
            raise AssistantError("Windows 無法送出文字輸入。")


def computer_action(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    controller = WindowsInput()
    if action == "move":
        return controller.move(int(payload.get("x", 0)), int(payload.get("y", 0)))
    if action == "click":
        return controller.click(str(payload.get("button", "left")))
    if action == "type":
        return controller.type_text(str(payload.get("text", "")))
    if action == "hotkey":
        keys = payload.get("keys")
        if isinstance(keys, str):
            keys = [part.strip() for part in keys.split("+") if part.strip()]
        if not isinstance(keys, list):
            raise AssistantError("快捷鍵格式需為 ctrl+c 或 ['ctrl', 'c']。")
        return controller.hotkey([str(key) for key in keys])
    raise AssistantError(f"未知的電腦控制動作：{action}")


def load_memory() -> list[dict[str, Any]]:
    if not MEMORY_FILE.exists():
        return []
    try:
        data = json.loads(MEMORY_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    return data if isinstance(data, list) else []


def save_memory(items: list[dict[str, Any]]) -> None:
    MEMORY_FILE.write_text(json.dumps(items[-MAX_MEMORY_ITEMS:], ensure_ascii=False, indent=2), encoding="utf-8")


def append_memory(kind: str, text: str, meta: dict[str, Any] | None = None) -> dict[str, Any]:
    item = {
        "id": uuid.uuid4().hex,
        "time": time.strftime("%Y-%m-%d %H:%M:%S"),
        "kind": kind,
        "text": text.strip(),
        "meta": meta or {},
    }
    items = load_memory()
    items.append(item)
    save_memory(items)
    return item


def clear_memory() -> dict[str, Any]:
    save_memory([])
    return {"ok": True, "items": []}


def cleanup_intent_text(text: str, words: list[str]) -> str:
    value = text
    for word in words:
        value = re.sub(re.escape(word), "", value, flags=re.I)
    value = re.sub(r"^[：:\s]+", "", value)
    return value.strip()


def looks_like_url(value: str) -> bool:
    if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", value):
        return True
    return bool(re.match(r"^[\w.-]+\.[a-zA-Z]{2,}(/.*)?$", value))


def local_planner(message: str) -> dict[str, Any]:
    text = message.strip()
    lower = text.lower()
    suggestions: list[SuggestedAction] = []
    memory = load_memory()[-6:]

    if not text:
        raise AssistantError("請輸入目標。")

    reply = "我已理解目標，先把可執行的下一步列出來。"
    reasoning = [
        "讀取使用者目標與目前系統狀態。",
        "依照關鍵字判斷是否需要搜尋、檔案、指令、剪貼簿或電腦控制。",
        "把可能影響電腦的動作放進確認流程。",
    ]

    if any(word in lower for word in ["搜尋", "查詢", "查一下", "google", "search", "網路", "最新"]):
        query = cleanup_intent_text(text, ["搜尋", "查詢", "查一下", "google", "search", "網路", "最新"])
        suggestions.append(SuggestedAction("搜尋網頁", "web_search", {"query": query or text}))
        reply = "我判斷這個目標需要外部資訊，已準備好網頁搜尋。"

    if any(word in lower for word in ["找檔案", "檔案", "文件", "資料夾", "file"]):
        query = cleanup_intent_text(text, ["找檔案", "檔案", "文件", "資料夾", "file"])
        suggestions.append(SuggestedAction("搜尋本機檔案", "file_search", {"query": query or text, "baseDir": str(ROOT)}))
        reply = "我判斷這個目標和本機檔案有關，已準備檔案搜尋。"

    if any(word in lower for word in ["截圖", "螢幕", "畫面", "screenshot", "capture"]):
        suggestions.append(SuggestedAction("擷取螢幕", "screenshot", {}))
        reply = "我可以先感知目前螢幕畫面，再依結果決定下一步。"

    if any(word in lower for word in ["剪貼簿", "clipboard"]):
        suggestions.append(SuggestedAction("讀取剪貼簿", "get_clipboard", {}))
        reply = "我可以讀取剪貼簿內容，作為下一步判斷的輸入。"

    if any(word in lower for word in ["開啟", "打開", "open"]):
        target = cleanup_intent_text(text, ["開啟", "打開", "open"])
        if target:
            if looks_like_url(target):
                suggestions.append(SuggestedAction("開啟網址", "open_url", {"url": target}))
            else:
                suggestions.append(SuggestedAction("開啟應用程式或檔案", "open_app", {"target": target}, "medium"))
        reply = "我已把開啟動作整理成可確認的操作。"

    command_match = re.search(r"(?:指令|命令|run|command|cmd)[:：\s]+(.+)", text, flags=re.I)
    if command_match:
        command = command_match.group(1).strip()
        suggestions.append(SuggestedAction("執行 PowerShell 指令", "run_command", {"command": command}, classify_command(command)))
        reply = "我已辨識出 PowerShell 指令，執行前會先經過安全確認。"

    if any(word in lower for word in ["現在時間", "今天日期", "幾點", "date", "time"]):
        suggestions.append(SuggestedAction("讀取系統時間", "run_command", {"command": "Get-Date"}, "low"))
        reply = "我可以直接讀取目前系統時間。"

    remember_match = re.search(r"(?:記住|記得|remember)[:：\s]*(.+)", text, flags=re.I)
    if remember_match:
        fact = remember_match.group(1).strip()
        suggestions.append(SuggestedAction("寫入記憶", "remember", {"text": fact or text}))
        reply = "我可以把這件事寫入記憶，之後在工作流程裡帶著它。"

    if not suggestions:
        suggestions.extend(
            [
                SuggestedAction("搜尋網頁", "web_search", {"query": text}),
                SuggestedAction("搜尋本機檔案", "file_search", {"query": text, "baseDir": str(ROOT)}),
            ]
        )

    plan = {
        "perception": [
            f"目標：{text}",
            f"工作區：{ROOT}",
            f"平台：{platform.system()} {platform.release()}",
        ],
        "reasoning": reasoning,
        "actions": [item.title for item in suggestions],
        "memory": [item.get("text", "") for item in memory],
    }

    return {
        "ok": True,
        "reply": reply,
        "plan": plan,
        "suggestions": [asdict(suggestion) for suggestion in suggestions],
    }


def call_openai_compatible(payload: dict[str, Any]) -> dict[str, Any]:
    api_key = str(payload.get("apiKey", "")).strip()
    model = str(payload.get("model", "")).strip()
    api_base = str(payload.get("apiBase", "https://api.openai.com/v1")).strip().rstrip("/")
    messages = payload.get("messages")
    if not api_key or not model:
        raise AssistantError("請先填入 API Key 與模型名稱。")
    if not isinstance(messages, list):
        raise AssistantError("messages 必須是陣列。")

    url = api_base
    if not url.endswith("/chat/completions"):
        url += "/chat/completions"
    body = {
        "model": model,
        "messages": messages,
        "temperature": float(payload.get("temperature", 0.2)),
    }
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            parsed = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise AssistantError(f"模型 API 回傳錯誤：{exc.code} {detail}", 502) from exc
    except Exception as exc:
        raise AssistantError(f"模型 API 連線失敗：{exc}", 502) from exc

    content = parsed.get("choices", [{}])[0].get("message", {}).get("content", "")
    return {"ok": True, "reply": content, "raw": parsed}


def build_multipart_form(
    fields: dict[str, str],
    files: list[tuple[str, str, str, bytes]],
) -> tuple[bytes, str]:
    boundary = "----LocalAgent" + uuid.uuid4().hex
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.extend(
            [
                f"--{boundary}\r\n".encode("utf-8"),
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"),
                str(value).encode("utf-8"),
                b"\r\n",
            ]
        )
    for field_name, filename, mime_type, content in files:
        safe_filename = filename.replace('"', "")
        chunks.extend(
            [
                f"--{boundary}\r\n".encode("utf-8"),
                (
                    f'Content-Disposition: form-data; name="{field_name}"; '
                    f'filename="{safe_filename}"\r\n'
                ).encode("utf-8"),
                f"Content-Type: {mime_type}\r\n\r\n".encode("utf-8"),
                content,
                b"\r\n",
            ]
        )
    chunks.append(f"--{boundary}--\r\n")
    return b"".join(chunk if isinstance(chunk, bytes) else chunk.encode("utf-8") for chunk in chunks), boundary


def audio_extension(mime_type: str) -> str:
    if "webm" in mime_type:
        return "webm"
    if "mp4" in mime_type or "m4a" in mime_type:
        return "m4a"
    if "mpeg" in mime_type or "mp3" in mime_type:
        return "mp3"
    if "wav" in mime_type:
        return "wav"
    return "webm"


def transcribe_audio(payload: dict[str, Any]) -> dict[str, Any]:
    api_key = str(payload.get("apiKey", "")).strip()
    model = str(payload.get("model", "whisper-1") or "whisper-1").strip()
    api_base = str(payload.get("apiBase", "https://api.openai.com/v1")).strip().rstrip("/")
    mime_type = str(payload.get("mimeType", "audio/webm") or "audio/webm").split(";")[0]
    audio_base64 = str(payload.get("audioBase64", "")).strip()
    language = str(payload.get("language", "zh") or "zh").strip()

    if not api_key:
        raise AssistantError("語音轉文字需要 API Key。")
    if not audio_base64:
        raise AssistantError("沒有收到音訊資料。")
    if len(audio_base64) > 28_000_000:
        raise AssistantError("音訊太大，請縮短錄音。")

    try:
        audio_bytes = base64.b64decode(audio_base64, validate=True)
    except Exception as exc:
        raise AssistantError("音訊資料格式錯誤。") from exc

    url = api_base
    if not url.endswith("/audio/transcriptions"):
        url += "/audio/transcriptions"

    filename = f"voice.{audio_extension(mime_type)}"
    body, boundary = build_multipart_form(
        {"model": model, "language": language, "response_format": "json"},
        [("file", filename, mime_type, audio_bytes)],
    )
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            parsed = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise AssistantError(f"語音 API 回傳錯誤：{exc.code} {detail}", 502) from exc
    except Exception as exc:
        raise AssistantError(f"語音 API 連線失敗：{exc}", 502) from exc

    text = str(parsed.get("text", "")).strip()
    return {"ok": True, "text": text, "raw": parsed}


def system_state() -> dict[str, Any]:
    return {
        "ok": True,
        "app": "Computer AI Agent",
        "version": "1.0.0",
        "host": socket.gethostname(),
        "platform": platform.platform(),
        "python": sys.version.split()[0],
        "workspace": str(ROOT),
        "time": time.strftime("%Y-%m-%d %H:%M:%S"),
        "capabilities": {
            "voice": "browser-recognition, optional-audio-transcription, windows-dictation",
            "commandExecution": True,
            "webSearch": True,
            "fileSearch": True,
            "computerControl": is_windows(),
            "screenshots": is_windows(),
            "memory": True,
            "optionalModelApi": True,
        },
    }


def dispatch_action(payload: dict[str, Any]) -> dict[str, Any]:
    action = str(payload.get("action", "")).strip()
    data = payload.get("payload") if isinstance(payload.get("payload"), dict) else payload
    if not isinstance(data, dict):
        data = {}

    if action == "run_command":
        return execute_command(data)
    if action == "web_search":
        return web_search(str(data.get("query", "")))
    if action == "open_url":
        return open_url(str(data.get("url", "")))
    if action == "open_app":
        return open_app(str(data.get("target", "")))
    if action == "file_search":
        return search_files(str(data.get("query", "")), str(data.get("baseDir") or ROOT))
    if action == "screenshot":
        return screenshot()
    if action == "get_clipboard":
        return get_clipboard()
    if action == "set_clipboard":
        return set_clipboard(str(data.get("text", "")))
    if action == "remember":
        item = append_memory("note", str(data.get("text", "")).strip())
        return {"ok": True, "message": "已寫入記憶。", "item": item}
    if action in {"move", "click", "type", "hotkey"}:
        return computer_action(action, data)
    raise AssistantError(f"未知的動作：{action}", 404)


class AssistantHandler(SimpleHTTPRequestHandler):
    server_version = "ComputerAIAgent/1.0"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def log_message(self, format: str, *args: Any) -> None:
        sys.stdout.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), format % args))

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, data: Any, status: int = 200) -> None:
        encoded = json_dumps(data)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        try:
            if parsed.path == "/api/state":
                self.send_json(system_state())
                return
            if parsed.path == "/api/memory":
                self.send_json({"ok": True, "items": load_memory()})
                return
            if parsed.path == "/api/search":
                query = urllib.parse.parse_qs(parsed.query).get("q", [""])[0]
                self.send_json(web_search(query))
                return
            if parsed.path == "/":
                self.path = "/index.html"
            super().do_GET()
        except AssistantError as exc:
            self.send_json({"ok": False, "error": str(exc)}, exc.status)
        except Exception as exc:
            self.send_json({"ok": False, "error": str(exc)}, 500)

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        try:
            payload = read_json(self)
            if parsed.path == "/api/chat":
                self.send_json(local_planner(str(payload.get("message", ""))))
                return
            if parsed.path == "/api/model":
                self.send_json(call_openai_compatible(payload))
                return
            if parsed.path == "/api/transcribe":
                self.send_json(transcribe_audio(payload))
                return
            if parsed.path == "/api/action":
                self.send_json(dispatch_action(payload))
                return
            if parsed.path == "/api/memory":
                op = str(payload.get("op", "append"))
                if op == "clear":
                    self.send_json(clear_memory())
                    return
                item = append_memory(str(payload.get("kind", "note")), str(payload.get("text", "")), payload.get("meta"))
                self.send_json({"ok": True, "item": item, "items": load_memory()})
                return
            self.send_json({"ok": False, "error": "Not found"}, HTTPStatus.NOT_FOUND)
        except AssistantError as exc:
            self.send_json({"ok": False, "error": str(exc)}, exc.status)
        except subprocess.TimeoutExpired:
            self.send_json({"ok": False, "error": "動作逾時。"}, 408)
        except Exception as exc:
            self.send_json({"ok": False, "error": str(exc)}, 500)


def main() -> None:
    STATIC_DIR.mkdir(parents=True, exist_ok=True)
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    port = DEFAULT_PORT
    if len(sys.argv) > 1:
        port = int(sys.argv[1])
    server = ThreadingHTTPServer((DEFAULT_HOST, port), AssistantHandler)
    url = f"http://{DEFAULT_HOST}:{port}"
    print(f"Computer AI Agent running at {url}")
    print("Press Ctrl+C to stop.")
    try:
        if os.environ.get("FUTURE_ASSISTANT_NO_BROWSER") != "1":
            webbrowser.open(url)
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server...")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
