"""Small stdio client for the open-source Codex App Server."""
from __future__ import annotations

import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import threading


def find_codex():
    configured = os.environ.get('MINI_CODEX_BIN')
    if configured:
        if not Path(configured).is_file():
            raise FileNotFoundError('MINI_CODEX_BIN 指向的程式不存在')
        return configured
    found = shutil.which('codex.exe') or shutil.which('codex')
    if found and Path(found).suffix.lower() not in ('.cmd', '.ps1', '.bat'):
        return found
    root = Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'OpenAI/Codex/bin'
    candidates = list(root.glob('*/codex.exe'))
    if candidates:
        return str(max(candidates, key=lambda p: p.stat().st_mtime))
    raise FileNotFoundError('找不到 Codex。請安裝 Codex CLI，或設定 MINI_CODEX_BIN 為 codex.exe 的完整路徑。')


class CodexBridge:
    def __init__(self, on_event, command=None):
        self.on_event = on_event
        self.command = command
        self.process = None
        self.pending = {}
        self.lock = threading.RLock()
        self.sequence = 0
        self.closed = False

    def start(self):
        command = self.command or [find_codex(), 'app-server', '--listen', 'stdio://']
        self.process = subprocess.Popen(
            command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding='utf-8', bufsize=1,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
        )
        threading.Thread(target=self._read, daemon=True).start()
        result = self.request('initialize', {'clientInfo': {
            'name': 'mini_codex', 'title': 'Mini Codex', 'version': '0.1.0'}})
        self.send({'method': 'initialized'})
        return result

    def send(self, message):
        with self.lock:
            if self.closed or not self.process or self.process.poll() is not None:
                raise RuntimeError('Codex 連線已中斷，請重新啟動 Mini Codex。')
            self.process.stdin.write(json.dumps(message, ensure_ascii=False) + '\n')
            self.process.stdin.flush()

    def request(self, method, params=None, timeout=45):
        with self.lock:
            self.sequence += 1
            request_id = self.sequence
            result_queue = queue.Queue(maxsize=1)
            self.pending[request_id] = result_queue
        try:
            self.send({'id': request_id, 'method': method, 'params': params or {}})
            try:
                result = result_queue.get(timeout=timeout)
            except queue.Empty:
                raise TimeoutError(f'{method} 回應逾時，請重新啟動以確認連線狀態。') from None
            if 'error' in result:
                raise RuntimeError(result['error'].get('message', str(result['error'])))
            return result.get('result', {})
        finally:
            with self.lock:
                self.pending.pop(request_id, None)

    def respond(self, request_id, result):
        self.send({'id': request_id, 'result': result})

    def _read(self):
        try:
            for line in self.process.stdout:
                try:
                    message = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if 'method' in message:
                    self.on_event(message)
                elif 'id' in message:
                    with self.lock:
                        pending = self.pending.get(message['id'])
                        if pending:
                            pending.put_nowait(message)
        finally:
            with self.lock:
                for pending in self.pending.values():
                    if pending.empty():
                        pending.put_nowait({'error': {'message': 'Codex 程序已結束'}})
            if not self.closed:
                self.on_event({'method': 'mini/disconnected', 'params': {}})

    def close(self):
        self.closed = True
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
