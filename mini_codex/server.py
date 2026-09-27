from __future__ import annotations

import argparse
import atexit
import copy
import json
import mimetypes
import os
from pathlib import Path
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
import webbrowser

from bridge import CodexBridge
from sources import SourceManager

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get('MINI_CODEX_DATA', str(Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'MiniCodex')))


class Assistant:
    def __init__(self, data_dir=DATA):
        self.lock = threading.RLock()
        self.file = Path(data_dir) / 'chats.json'
        self.data_dir = Path(data_dir)
        self.sources = SourceManager(self.data_dir)
        self.chats = []
        self.current = None
        self.loaded = set()
        self.busy = False
        self.turn_id = None
        self.ready = False
        self.account = False
        self.models = []
        self.error = ''
        self.approvals = {}
        self.revision = 0
        self.bridge = CodexBridge(self.event)
        if self.file.exists():
            try:
                self.chats = json.loads(self.file.read_text(encoding='utf-8'))
                if not isinstance(self.chats, list):
                    raise ValueError('Invalid history')
                for chat in self.chats:
                    assert isinstance(chat['messages'], list) and isinstance(chat['id'], str)
                    chat['activity'] = chat.get('activity', [])
                    chat['plan'] = chat.get('plan', [])
                self.current = self.chats[0]['id'] if self.chats else None
            except (ValueError, KeyError, TypeError, AssertionError):
                backup = self.file.with_name(f'chats.invalid-{time.time_ns()}.json')
                self.file.rename(backup)
                self.chats = []
                self.error = '舊紀錄無法讀取，已保留備份。'

    def connect(self):
        try:
            self.bridge.start()
            self.refresh_account()
            models = self.bridge.request('model/list', {})
            with self.lock:
                self.models = [{'id': m['id'], 'name': m.get('displayName', m['id'])} for m in models.get('data', [])]
                self.ready = True
                self.revision += 1
        except Exception as exc:
            with self.lock:
                self.error = str(exc)
                self.revision += 1

    def refresh_account(self):
        account = self.bridge.request('account/read', {'refreshToken': False})
        with self.lock:
            self.account = bool(account.get('account')) or not account.get('requiresOpenaiAuth', True)
            self.revision += 1

    def refresh_account_background(self):
        try:
            self.refresh_account()
        except (RuntimeError, TimeoutError, OSError):
            pass

    def save(self):
        self.file.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.file.with_suffix('.tmp')
        temporary.write_text(json.dumps(self.chats, ensure_ascii=False), encoding='utf-8')
        try:
            temporary.replace(self.file)
        except OSError:
            # Some Windows profile/sync configurations reject atomic rename even
            # inside one folder. The data is still valid JSON, so retain a copy
            # and use a direct replacement only as a compatibility fallback.
            self.file.write_text(temporary.read_text(encoding='utf-8'), encoding='utf-8')
            temporary.unlink(missing_ok=True)

    def chat(self):
        return next((c for c in self.chats if c['id'] == self.current), None)

    def state(self):
        with self.lock:
            return copy.deepcopy({'ready': self.ready, 'account': self.account,
                'busy': self.busy, 'error': self.error, 'models': self.models,
                'chats': [{'id': c['id'], 'title': c['title']} for c in self.chats],
                'chat': self.chat(), 'approvals': list(self.approvals.values()),
                'revision': self.revision, 'defaultCwd': str(ROOT.parent),
                'sources': self.sources.list(),
                'access': {'role': 'owner', 'owner': os.environ.get('USERNAME', 'owner'),
                           'ownerCapabilities': ['讀取', '編輯', '核准', '更新審查', '電腦控制'],
                           'memberCapabilities': ['使用', '讀取']}})

    def import_codex_threads(self):
        listing = self.bridge.request('thread/list', {'limit': 50, 'sortDirection': 'desc'})
        imported = 0
        for summary in listing.get('data', []):
            thread_id = summary.get('id')
            if not thread_id or any(chat['id'] == thread_id for chat in self.chats):
                continue
            thread = self.bridge.request('thread/read', {'threadId': thread_id, 'includeTurns': True}).get('thread', {})
            messages = []
            for turn in thread.get('turns', []):
                for item in turn.get('items', []):
                    if item.get('type') == 'agentMessage' and item.get('text'):
                        messages.append({'id': item.get('id', secrets.token_hex(8)), 'role': 'assistant', 'text': item['text']})
                    elif item.get('type') == 'userMessage':
                        message = '\n'.join(part.get('text', '') for part in item.get('content', []) if part.get('type') == 'text').strip()
                        if message:
                            messages.append({'id': item.get('id', secrets.token_hex(8)), 'role': 'user', 'text': message})
            self.chats.append({'id': thread_id, 'title': thread.get('name') or summary.get('preview', 'Codex 對話')[:32],
                'cwd': thread.get('cwd') or str(ROOT.parent), 'mode': 'read-only', 'messages': messages,
                'activity': [], 'plan': [], 'source': 'codex-import'})
            imported += 1
        self.save()
        return {'imported': imported, 'available': len(listing.get('data', []))}

    def event(self, event):
        method, params = event['method'], event.get('params') or {}
        with self.lock:
            chat = self.chat()
            if 'id' in event:
                supported = ('item/commandExecution/requestApproval', 'item/fileChange/requestApproval')
                if method in supported:
                    self.approvals[str(event['id'])] = {'id': event['id'], 'method': method, 'details': params}
                elif method == 'item/permissions/requestApproval':
                    self.bridge.respond(event['id'], {'permissions': {}, 'scope': 'turn'})
                elif method == 'mcpServer/elicitation/request':
                    self.bridge.respond(event['id'], {'action': 'decline', 'content': None})
                elif method == 'item/tool/requestUserInput':
                    self.bridge.respond(event['id'], {'answers': {}})
                    self.error = '此任務要求額外問答；請在聊天中補充需求。'
                else:
                    self.bridge.send({'id': event['id'], 'error': {'code': -32601, 'message': 'Unsupported client request'}})
                self.revision += 1
                return
            if method == 'mini/disconnected':
                self.ready = self.busy = False
                self.approvals.clear()
                self.error = 'Codex 連線已中斷，請關閉並重新啟動助手。'
            if method in ('account/updated', 'account/login/completed'):
                threading.Thread(target=self.refresh_account_background, daemon=True).start()
            if method == 'serverRequest/resolved':
                self.approvals.pop(str(params.get('requestId')), None)
            if not chat or (params.get('threadId') and params['threadId'] != self.current):
                self.revision += 1
                return
            if method == 'turn/started':
                self.turn_id = params['turn']['id']
            elif method == 'item/agentMessage/delta':
                item_id = params['itemId']
                message = next((m for m in chat['messages'] if m['id'] == item_id), None)
                if message is None:
                    message = {'id': item_id, 'role': 'assistant', 'text': ''}
                    chat['messages'].append(message)
                message['text'] += params.get('delta', '')
            elif method in ('item/started', 'item/completed'):
                item = params['item']
                kind = item.get('type')
                if kind == 'agentMessage' and method == 'item/completed':
                    message = next((m for m in chat['messages'] if m['id'] == item['id']), None)
                    if message is None:
                        message = {'id': item['id'], 'role': 'assistant', 'text': ''}
                        chat['messages'].append(message)
                    message['text'] = item.get('text', message['text'])
                elif kind in ('commandExecution', 'fileChange', 'mcpToolCall', 'webSearch'):
                    activity = next((a for a in chat['activity'] if a['id'] == item['id']), None)
                    if activity is None:
                        activity = {'id': item['id']}
                        chat['activity'].append(activity)
                    activity.update({'type': kind, 'status': item.get('status', 'inProgress'),
                        'text': item.get('command') or item.get('query') or item.get('tool') or '修改檔案',
                        'output': item.get('aggregatedOutput', ''), 'changes': item.get('changes', [])})
            elif method == 'turn/plan/updated':
                chat['plan'] = params.get('plan', [])
            elif method == 'turn/completed':
                self.busy = False
                self.turn_id = None
                self.approvals.clear()
                turn = params.get('turn', {})
                chat['lastStatus'] = turn.get('status', 'completed')
                if turn.get('error'):
                    self.error = turn['error'].get('message', '任務失敗')
                self.save()
            elif method == 'error':
                self.error = params.get('error', {}).get('message', 'Codex 發生錯誤')
            self.revision += 1

    def action(self, action, data):
        if action == 'import':
            with self.lock:
                if self.busy:
                    raise ValueError('請先停止目前任務')
            result = self.import_codex_threads()
            with self.lock:
                self.revision += 1
            return result
        if action == 'sources':
            source_action = data.get('subAction', 'list')
            if source_action == 'refresh':
                result = self.sources.refresh()
            elif source_action == 'review':
                result = self.sources.review(str(data.get('repository', '')))
            elif source_action == 'stage':
                result = self.sources.stage(str(data.get('repository', '')), self.data_dir / 'review-candidates')
            else:
                result = self.sources.list()
            with self.lock:
                self.revision += 1
            return result
        if action == 'login':
            result = self.bridge.request('account/login/start', {'type': 'chatgpt'})
            return {'url': result.get('authUrl')}
        if action == 'approve':
            with self.lock:
                key = str(data['id'])
                approval = self.approvals.get(key)
                if not approval:
                    raise ValueError('這個核准要求已結束')
                decision = data.get('decision')
                if decision not in ('accept', 'decline'):
                    raise ValueError('無效的核准選項')
                self.bridge.respond(approval['id'], {'decision': decision})
                del self.approvals[key]
                self.revision += 1
            return {}
        if action == 'stop':
            with self.lock:
                thread_id, turn_id = self.current, self.turn_id
            if turn_id:
                self.bridge.request('turn/interrupt', {'threadId': thread_id, 'turnId': turn_id})
            else:
                raise ValueError('任務正在啟動，請稍後再停止')
            return {}
        if action in ('new', 'select'):
            with self.lock:
                if self.busy:
                    raise ValueError('請先停止目前任務')
                target = data.get('id') if action == 'select' else None
                if target and not any(c['id'] == target for c in self.chats):
                    raise ValueError('找不到對話')
                self.current = target
                self.error = ''
                self.revision += 1
            return {}
        if action != 'send':
            raise ValueError('未知操作')
        prompt = str(data.get('text', '')).strip()
        if not prompt or len(prompt) > 32000:
            raise ValueError('請輸入 1–32000 字的訊息')
        with self.lock:
            if not self.ready or not self.account:
                raise ValueError('請先連接 Codex 並登入')
            if self.busy:
                raise ValueError('目前任務仍在執行')
            chat = self.chat()
            cwd = str(Path(chat['cwd'] if chat else data.get('cwd', str(ROOT.parent))).resolve())
            if not Path(cwd).is_dir():
                raise ValueError('專案資料夾不存在')
            mode = chat['mode'] if chat else data.get('mode', 'read-only')
            if mode not in ('read-only', 'workspace-write'):
                raise ValueError('無效的工作模式')
            self.busy = True
            self.error = ''
            self.revision += 1
        try:
            if chat is None:
                options = {'cwd': cwd, 'sandbox': mode, 'approvalPolicy': 'on-request',
                    'developerInstructions': '你是 Mini Codex 的 AI 助手。使用繁體中文。清楚呈現工作進度與結果。'}
                if data.get('model'):
                    options['model'] = data['model']
                result = self.bridge.request('thread/start', options)
                with self.lock:
                    chat = {'id': result['thread']['id'], 'title': prompt[:32], 'cwd': cwd,
                        'mode': mode, 'messages': [], 'activity': [], 'plan': []}
                    self.chats.insert(0, chat)
                    self.current = chat['id']
                    self.loaded.add(chat['id'])
            elif chat['id'] not in self.loaded:
                self.bridge.request('thread/resume', {'threadId': chat['id'], 'cwd': cwd,
                    'sandbox': mode, 'approvalPolicy': 'on-request'})
                self.loaded.add(chat['id'])
            with self.lock:
                chat['messages'].append({'id': secrets.token_hex(8), 'role': 'user', 'text': prompt})
                chat['plan'] = []
                self.save()
            self.bridge.request('turn/start', {'threadId': chat['id'], 'input': [{'type': 'text', 'text': prompt}]})
            return {}
        except Exception:
            with self.lock:
                self.busy = False
                self.revision += 1
            raise


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port=0, assistant=None):
        self.assistant = assistant or Assistant()
        self.token = secrets.token_urlsafe(32)
        super().__init__(('127.0.0.1', port), Handler)
        self.origin = f'http://127.0.0.1:{self.server_port}'
        self.url = self.origin + '/#' + self.token


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, status, data, content_type='application/json; charset=utf-8'):
        body = json.dumps(data, ensure_ascii=False).encode() if isinstance(data, (dict, list)) else data
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
        self.end_headers()
        self.wfile.write(body)

    def allowed(self):
        if self.headers.get('Host') != urlparse(self.server.origin).netloc:
            self.reply(403, {'error': '不允許的來源'})
            return False
        origin = self.headers.get('Origin')
        if origin and origin != self.server.origin:
            self.reply(403, {'error': '不允許跨網站存取'})
            return False
        if not secrets.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + self.server.token):
            self.reply(401, {'error': '請使用啟動程式產生的連結開啟助手'})
            return False
        return True

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/api/state':
            if self.allowed():
                self.reply(200, self.server.assistant.state())
            return
        files = {'/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/robot.svg': 'robot.svg'}
        if path not in files:
            self.reply(404, {'error': '找不到頁面'})
            return
        file = ROOT / 'web' / files[path]
        self.reply(200, file.read_bytes(), (mimetypes.guess_type(file.name)[0] or 'text/plain') + '; charset=utf-8')

    def do_POST(self):
        if not self.allowed():
            return
        try:
            length = int(self.headers.get('Content-Length', 0))
            if not 0 < length <= 150000:
                raise ValueError('要求大小無效')
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError('要求格式無效')
            path = urlparse(self.path).path
            if not path.startswith('/api/'):
                raise ValueError('找不到操作')
            result = self.server.assistant.action(path[5:], data)
            self.reply(200, result)
        except (ValueError, KeyError, OSError, RuntimeError, TimeoutError) as exc:
            self.reply(400, {'error': str(exc)})


def start(port=0):
    # A second launcher opens the active service instead of overwriting its history.
    DATA.mkdir(parents=True, exist_ok=True)
    instance_lock = (DATA / 'instance.lock').open('a+b')
    instance_lock.seek(0)
    if os.name == 'nt':
        import msvcrt
        try:
            msvcrt.locking(instance_lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            instance_lock.close()
            try:
                existing = json.loads((DATA / 'instance.json').read_text(encoding='utf-8'))
                parsed = urlparse(existing['url'])
                if parsed.hostname == '127.0.0.1' and parsed.scheme == 'http':
                    webbrowser.open(existing['url'])
            except (OSError, ValueError, KeyError):
                pass
            raise SystemExit('Mini Codex 已在執行，請使用現有視窗。')
    atexit.register(instance_lock.close)
    server = LocalServer(port)
    server.instance_lock = instance_lock
    (DATA / 'instance.json').write_text(json.dumps({'url': server.url}), encoding='utf-8')
    threading.Thread(target=server.serve_forever, daemon=True).start()
    threading.Thread(target=server.assistant.connect, daemon=True).start()
    return server


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=0)
    parser.add_argument('--no-open', action='store_true')
    args = parser.parse_args()
    server = start(args.port)
    print('Mini Codex:', server.url, flush=True)
    if not args.no_open:
        webbrowser.open(server.url)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        server.assistant.bridge.close()
        server.shutdown()
