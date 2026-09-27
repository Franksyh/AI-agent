from __future__ import annotations

import argparse
import atexit
import copy
import json
import mimetypes
import os
from pathlib import Path
import secrets
import shutil
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from urllib.request import Request, urlopen
import webbrowser

from access import AccessPolicy
from bridge import CodexBridge
from sources import SourceManager

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get('MINI_CODEX_DATA', str(Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'MiniCodex')))


class Assistant:
    def __init__(self, data_dir=DATA):
        self.lock = threading.RLock()
        self.file = Path(data_dir) / 'chats.json'
        self.data_dir = Path(data_dir)
        self.access = AccessPolicy(self.data_dir)
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

    def providers(self):
        """Report local integration availability without disclosing secrets."""
        codex_status = 'connected' if self.ready and self.account else 'available' if self.ready else 'starting'
        return [
            {'id': 'codex', 'name': 'ChatGPT Codex', 'status': codex_status,
             'detail': '透過本機 Codex App Server 執行。'},
            {'id': 'github', 'name': 'GitHub', 'status': 'available' if shutil.which('git') else 'not_detected',
             'detail': '可用 Git 與已登入的 GitHub 工具管理專案。'},
            {'id': 'gemini', 'name': 'Gemini', 'status': 'available' if shutil.which('gemini') else 'setup_required',
             'detail': '安裝並登入 Gemini CLI 後可在本機工作流程中使用。'},
            {'id': 'perplexity', 'name': 'Perplexity', 'status': 'setup_required',
             'detail': '需要你自行設定 API 金鑰；Mini 不會讀取或顯示金鑰。'},
            {'id': 'siri', 'name': 'Siri / Apple Intelligence', 'status': 'windows_limited' if os.name == 'nt' else 'setup_required',
             'detail': 'Windows 無法直接控制 Siri；Apple 裝置可另外連接相容的本機工具。'},
        ]

    def state(self, role='owner'):
        with self.lock:
            is_owner = role == 'owner'
            state = {
                'ready': self.ready,
                'account': self.account,
                'busy': self.busy if is_owner else False,
                'error': self.error if is_owner else '',
                'models': self.models if is_owner else [],
                # A local member token is deliberately not issued by the
                # launcher. Hosted identities need isolated conversation
                # storage before they can safely view any history.
                'chats': [{'id': c['id'], 'title': c['title']} for c in self.chats] if is_owner else [],
                'chat': self.chat() if is_owner else None,
                'approvals': list(self.approvals.values()) if is_owner else [],
                'revision': self.revision,
                'defaultCwd': str(ROOT.parent) if is_owner else '',
                'sources': self.sources.list() if is_owner else [],
                'providers': self.providers(),
                'access': self.access.public(role),
            }
            return copy.deepcopy(state)

    def import_codex_threads(self):
        listing = self.bridge.request('thread/list', {'limit': 50, 'sortDirection': 'desc'})
        summaries = listing.get('data', []) if isinstance(listing, dict) else []
        if not isinstance(summaries, list):
            raise ValueError('Codex 傳回的對話清單格式無效')
        with self.lock:
            known_ids = {chat.get('id') for chat in self.chats if isinstance(chat, dict)}
        additions = []
        skipped = already_present = 0
        for summary in summaries:
            if not isinstance(summary, dict):
                skipped += 1
                continue
            thread_id = summary.get('id')
            if not isinstance(thread_id, str) or not thread_id:
                skipped += 1
                continue
            if thread_id in known_ids:
                already_present += 1
                continue
            try:
                response = self.bridge.request('thread/read', {'threadId': thread_id, 'includeTurns': True})
                thread = response.get('thread', {}) if isinstance(response, dict) else {}
                if not isinstance(thread, dict):
                    raise ValueError('對話內容格式無效')
                messages = []
                for turn in thread.get('turns', []):
                    if not isinstance(turn, dict):
                        continue
                    for item in turn.get('items', []):
                        if not isinstance(item, dict):
                            continue
                        if item.get('type') == 'agentMessage' and isinstance(item.get('text'), str) and item['text']:
                            messages.append({'id': item.get('id', secrets.token_hex(8)), 'role': 'assistant', 'text': item['text']})
                        elif item.get('type') == 'userMessage':
                            content = item.get('content', [])
                            if not isinstance(content, list):
                                continue
                            message = '\n'.join(
                                part.get('text', '') for part in content
                                if isinstance(part, dict) and part.get('type') == 'text' and isinstance(part.get('text'), str)
                            ).strip()
                            if message:
                                messages.append({'id': item.get('id', secrets.token_hex(8)), 'role': 'user', 'text': message})
                title = thread.get('name')
                if not isinstance(title, str) or not title.strip():
                    preview = summary.get('preview', 'Codex 對話')
                    title = str(preview)[:32] or 'Codex 對話'
                cwd = thread.get('cwd')
                additions.append({'id': thread_id, 'title': title, 'cwd': cwd if isinstance(cwd, str) else str(ROOT.parent),
                    'mode': 'read-only', 'messages': messages, 'activity': [], 'plan': [], 'source': 'codex-import'})
            except (RuntimeError, TimeoutError, OSError, ValueError, KeyError, TypeError):
                # One unreadable historical thread must not leave earlier
                # imports only in memory. Successful records are committed
                # together below.
                skipped += 1
        with self.lock:
            current_ids = {chat.get('id') for chat in self.chats if isinstance(chat, dict)}
            committed = [chat for chat in additions if chat['id'] not in current_ids]
            self.chats.extend(committed)
            if self.current is None and committed:
                self.current = committed[0]['id']
            self.save()
            self.revision += 1
        return {
            'imported': len(committed), 'available': len(summaries),
            'alreadyPresent': already_present, 'skipped': skipped,
        }

    def start_source_ai_review(self, repository: str) -> dict:
        """Create an isolated, read-only Codex review of a staged candidate."""
        candidate, target = self.sources.staged_path(repository, self.data_dir / 'review-candidates')
        with self.lock:
            if not self.ready or not self.account:
                raise ValueError('請先連接 Codex 並登入，才能分析已下載的候選程式碼')
            if self.busy:
                raise ValueError('目前任務仍在執行')
            self.busy = True
            self.error = ''
            self.revision += 1
        prompt = (
            f'請審查已隔離下載的開源候選程式：{candidate.name}（{repository}）。\n'
            f'固定審查 commit：{candidate.latest_commit}\n\n'
            '請以繁體中文輸出：(1) 程式碼品質與安全證據，(2) 授權、相依套件與供應鏈風險，'
            '(3) 維護性與測試訊號，(4) 0–100 分，(5)「可供擁有者進一步檢視／需要人工檢視／不建議」其中一項建議。'
            '這是建議，不得自動採用、安裝或修改任何程式。'
        )
        instructions = (
            '你是 Mini Codex 的受控開源程式碼審查員。只可審查目前工作資料夾內、已固定 commit 的第三方原始碼。'
            '你可使用不改變檔案且不連網的文字檢視工具閱讀程式與中繼資料。'
            '不得執行候選專案、建置、安裝、測試、寫入、下載、存取憑證或對系統做任何變更。'
            '使用繁體中文，清楚區分觀察到的證據和推測，也不要推薦自動採用。'
        )
        try:
            result = self.bridge.request('thread/start', {
                'cwd': str(target), 'sandbox': 'read-only', 'approvalPolicy': 'on-request',
                'developerInstructions': instructions,
            })
            thread = result.get('thread', {}) if isinstance(result, dict) else {}
            thread_id = thread.get('id') if isinstance(thread, dict) else None
            if not isinstance(thread_id, str) or not thread_id:
                raise RuntimeError('Codex 沒有建立來源審查對話')
            chat = {
                'id': thread_id, 'title': f'來源審查 · {candidate.name}', 'cwd': str(target), 'mode': 'read-only',
                'messages': [{'id': secrets.token_hex(8), 'role': 'user', 'text': prompt}],
                'activity': [], 'plan': [], 'source': 'source-ai-review',
                'sourceReview': {'repository': repository, 'commit': candidate.latest_commit},
            }
            with self.lock:
                self.chats.insert(0, chat)
                self.current = thread_id
                self.loaded.add(thread_id)
                self.save()
                self.revision += 1
            self.bridge.request('turn/start', {'threadId': thread_id, 'input': [{'type': 'text', 'text': prompt}]})
            return {
                'repository': repository, 'commit': candidate.latest_commit, 'status': 'started',
                'message': '已用唯讀 Codex 對話開始分析隔離的候選程式碼。',
            }
        except Exception:
            with self.lock:
                self.busy = False
                self.revision += 1
            raise

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

    def action(self, action, data, role='owner'):
        self.access.require(role, action)
        if action == 'import':
            with self.lock:
                if self.busy:
                    raise ValueError('請先停止目前任務')
                self.busy = True
                self.error = ''
                self.revision += 1
            try:
                return self.import_codex_threads()
            finally:
                with self.lock:
                    self.busy = False
                    self.revision += 1
        if action == 'sources':
            source_action = data.get('subAction', 'list')
            if source_action == 'refresh':
                result = self.sources.refresh()
            elif source_action == 'review':
                result = self.sources.review(str(data.get('repository', '')))
            elif source_action == 'stage':
                result = self.sources.stage(str(data.get('repository', '')), self.data_dir / 'review-candidates')
            elif source_action == 'ai_review':
                return self.start_source_ai_review(str(data.get('repository', '')))
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
            if not self.access.allow_mode(role, mode):
                if mode == 'danger-full-access':
                    raise PermissionError('完整電腦存取只限擁有者，且不會自動啟用')
                raise ValueError('這個工作階段不允許該工作模式')
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
        # The launch URL is an owner-only, loopback capability. It is generated
        # for this process and never stored in the repository or sent to a
        # hosted page. A future paired member session can use member_token, but
        # the desktop launcher intentionally creates only the owner URL.
        self.token = secrets.token_urlsafe(32)
        self.member_token = secrets.token_urlsafe(32)
        self._desktop_lock = threading.Lock()
        self._desktop_request = None
        # A browser may ask the desktop companion to show or hide itself, but
        # it never receives a filesystem path.  File selection is performed
        # inside Tk on this computer after the owner explicitly opens the
        # native picker.
        self._desktop_connected = False
        self._file_request = None
        self._file_pending = False
        self._file_result = None
        super().__init__(('127.0.0.1', port), Handler)
        self.origin = f'http://127.0.0.1:{self.server_port}'
        self.url = self.origin + '/#' + self.token

    def role_for(self, token):
        return self.assistant.access.role_for(
            token,
            owner_session_token=self.token,
            member_session_token=self.member_token,
        )

    def _touch_revision(self):
        with self.assistant.lock:
            self.assistant.revision += 1

    def attach_desktop(self):
        """Mark that the local Tk companion is able to receive requests."""
        with self._desktop_lock:
            self._desktop_connected = True
        self._touch_revision()

    def detach_desktop(self):
        with self._desktop_lock:
            self._desktop_connected = False
            self._desktop_request = None
            self._file_request = None
            if self._file_pending:
                self._file_pending = False
                self._file_result = {
                    'status': 'unavailable',
                    'message': '桌面 Mini 已關閉，未開啟任何檔案。',
                }
        self._touch_revision()

    def desktop_available(self):
        with self._desktop_lock:
            return self._desktop_connected

    def desktop_state(self, role):
        """Return only owner-safe, path-free desktop companion status."""
        with self._desktop_lock:
            available = self._desktop_connected
            pending = self._file_pending
            result = copy.deepcopy(self._file_result)
        if role != 'owner':
            return {'available': False, 'fileAccess': {'available': False}}
        return {
            'available': available,
            'fileAccess': {
                'available': available,
                'pending': pending,
                'last': result,
                'message': ('桌面 Mini 尚未啟動；網頁版不能讀取或開啟這台電腦的檔案。'
                            if not available else '只會透過系統檔案選擇器處理你選取的檔案。'),
            },
        }

    def request_desktop(self, action, role):
        self.assistant.access.require(role, 'desktop')
        if action not in ('show', 'hide'):
            raise ValueError('未知的桌面 Mini 操作')
        with self._desktop_lock:
            if not self._desktop_connected:
                raise ValueError('桌面 Mini 尚未啟動，無法執行這項操作')
            self._desktop_request = action
        self._touch_revision()
        return {'requested': action}

    def take_desktop_request(self):
        with self._desktop_lock:
            action, self._desktop_request = self._desktop_request, None
            return action

    def request_file(self, action, include_preview, role):
        """Queue a native picker request without accepting a browser path."""
        self.assistant.access.require(role, 'files')
        if action != 'choose_and_open':
            raise ValueError('未知的本機檔案操作')
        with self._desktop_lock:
            if not self._desktop_connected:
                raise ValueError('桌面 Mini 尚未啟動；網頁版不能開啟這台電腦的檔案')
            if self._file_pending:
                raise ValueError('檔案選擇器已開啟，請先完成或取消目前操作')
            # Only this fixed action and a boolean cross the browser boundary.
            # A pathname supplied by a request body is deliberately ignored.
            self._file_request = {
                'action': 'choose_and_open',
                'includePreview': include_preview is True,
            }
            self._file_pending = True
            self._file_result = {
                'status': 'waiting_for_selection',
                'message': '正在等待你在這台電腦的系統檔案選擇器中選取檔案。',
            }
        self._touch_revision()
        return {'requested': 'choose_and_open', 'pending': True}

    def take_file_request(self):
        with self._desktop_lock:
            request, self._file_request = self._file_request, None
            return copy.deepcopy(request)

    def record_file_result(self, result):
        """Store a small, display-safe result from the native desktop picker."""
        if not isinstance(result, dict):
            result = {'status': 'failed', 'message': '無法處理選取的檔案。'}
        safe = {}
        for key in ('status', 'message', 'name', 'mime', 'preview'):
            value = result.get(key)
            if isinstance(value, str):
                safe[key] = value.replace('\x00', '')[:1400]
        size = result.get('size')
        if isinstance(size, int) and 0 <= size <= 1 << 60:
            safe['size'] = size
        safe.setdefault('status', 'failed')
        safe.setdefault('message', '無法處理選取的檔案。')
        with self._desktop_lock:
            self._file_pending = False
            self._file_result = safe
        self._touch_revision()


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
            return None
        origin = self.headers.get('Origin')
        if origin and origin != self.server.origin:
            self.reply(403, {'error': '不允許跨網站存取'})
            return None
        authorization = self.headers.get('Authorization', '')
        prefix = 'Bearer '
        token = authorization[len(prefix):] if authorization.startswith(prefix) else None
        role = self.server.role_for(token)
        if role is None:
            self.reply(401, {'error': '請使用啟動程式產生的連結開啟助手'})
            return None
        return role

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/api/state':
            role = self.allowed()
            if role:
                state = self.server.assistant.state(role)
                state['desktop'] = self.server.desktop_state(role)
                self.reply(200, state)
            return
        files = {'/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/robot.svg': 'robot.svg'}
        if path not in files:
            self.reply(404, {'error': '找不到頁面'})
            return
        file = ROOT / 'web' / files[path]
        self.reply(200, file.read_bytes(), (mimetypes.guess_type(file.name)[0] or 'text/plain') + '; charset=utf-8')

    def do_POST(self):
        role = self.allowed()
        if role is None:
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
            if path == '/api/desktop':
                result = self.server.request_desktop(str(data.get('action', '')), role)
            elif path == '/api/files':
                result = self.server.request_file(
                    str(data.get('action', '')),
                    data.get('includePreview') is True,
                    role,
                )
            else:
                result = self.server.assistant.action(path[5:], data, role)
            self.reply(200, result)
        except PermissionError as exc:
            self.reply(403, {'error': str(exc)})
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
                if parsed.hostname == '127.0.0.1' and parsed.scheme == 'http' and parsed.port and parsed.fragment:
                    # The hidden robot is restored by its existing loopback
                    # process. This avoids creating a second desktop window.
                    request = Request(
                        f'http://{parsed.netloc}/api/desktop',
                        data=b'{"action":"show"}',
                        headers={
                            'Authorization': 'Bearer ' + parsed.fragment,
                            'Content-Type': 'application/json',
                        },
                        method='POST',
                    )
                    try:
                        with urlopen(request, timeout=2):
                            pass
                    except OSError:
                        # A stale instance file still opens the saved browser
                        # URL, matching the previous launcher behaviour.
                        pass
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
