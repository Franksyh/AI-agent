import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import Assistant, LocalServer


class FakeBridge:
    def __init__(self):
        self.calls = []

    def request(self, method, params):
        self.calls.append((method, params))
        if method == 'thread/start':
            return {'thread': {'id': 'thread-1'}}
        return {}

    def respond(self, request_id, result):
        self.calls.append((request_id, result))


class ImportBridge(FakeBridge):
    def request(self, method, params):
        self.calls.append((method, params))
        if method == 'thread/list':
            return {'data': [{'id': 'kept', 'preview': '可匯入'}, {'id': 'broken', 'preview': '讀取失敗'}]}
        if method == 'thread/read' and params['threadId'] == 'kept':
            return {'thread': {
                'id': 'kept', 'name': '保留的對話', 'cwd': '',
                'turns': [{'items': [{'id': 'u1', 'type': 'userMessage', 'content': [{'type': 'text', 'text': '你好'}]}]}],
            }}
        if method == 'thread/read':
            raise RuntimeError('simulated history read failure')
        return super().request(method, params)


class AssistantTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.a = Assistant(self.directory.name)
        self.a.bridge = FakeBridge()
        self.a.ready = self.a.account = True

    def send(self):
        self.a.action('send', {'text': '說明專案', 'cwd': self.directory.name})

    def test_stream_completion_and_resume(self):
        self.send()
        self.a.event({'method': 'item/agentMessage/delta', 'params': {'threadId': 'thread-1', 'itemId': 'm1', 'delta': '繁體'}})
        self.a.event({'method': 'item/agentMessage/delta', 'params': {'threadId': 'thread-1', 'itemId': 'm1', 'delta': '中文'}})
        self.a.event({'method': 'item/completed', 'params': {'threadId': 'thread-1', 'item': {'id': 'm1', 'type': 'agentMessage', 'text': '繁體中文'}}})
        self.a.event({'method': 'turn/completed', 'params': {'threadId': 'thread-1', 'turn': {'status': 'completed'}}})
        self.assertFalse(self.a.busy)
        restored = Assistant(self.directory.name)
        restored.bridge = FakeBridge()
        restored.ready = restored.account = True
        self.assertEqual(restored.chat()['messages'][-1]['text'], '繁體中文')
        restored.action('send', {'text': '繼續'})
        self.assertEqual(restored.bridge.calls[0][0], 'thread/resume')

    def test_busy_and_directory_validation(self):
        with self.assertRaises(ValueError):
            self.a.action('send', {'text': 'test', 'cwd': str(Path(self.directory.name) / 'missing')})
        self.send()
        with self.assertRaises(ValueError):
            self.a.action('new', {})
        with self.assertRaises(ValueError):
            self.a.action('send', {'text': 'another'})

    def test_approval_is_explicit_and_one_time(self):
        self.send()
        self.a.event({'id': 42, 'method': 'item/commandExecution/requestApproval', 'params': {'command': 'example'}})
        self.assertEqual(len(self.a.state()['approvals']), 1)
        self.a.action('approve', {'id': 42, 'decision': 'decline'})
        self.assertEqual(self.a.bridge.calls[-1], (42, {'decision': 'decline'}))
        with self.assertRaises(ValueError):
            self.a.action('approve', {'id': 42, 'decision': 'accept'})

    def test_stop_sends_interrupt_and_waits_for_completion(self):
        self.send()
        self.a.event({'method': 'turn/started', 'params': {'threadId': 'thread-1', 'turn': {'id': 't1'}}})
        self.a.action('stop', {})
        self.assertEqual(self.a.bridge.calls[-1], ('turn/interrupt', {'threadId': 'thread-1', 'turnId': 't1'}))
        self.assertTrue(self.a.busy)

    def test_invalid_history_preserved(self):
        self.a.file.parent.mkdir(exist_ok=True)
        self.a.file.write_text('{bad', encoding='utf-8')
        restored = Assistant(self.directory.name)
        self.assertEqual(restored.chats, [])
        self.assertEqual(len(list(Path(self.directory.name).glob('chats.invalid-*.json'))), 1)

    def test_history_import_commits_successes_after_individual_read_failure(self):
        self.a.bridge = ImportBridge()
        result = self.a.action('import', {})
        self.assertEqual(result, {'imported': 1, 'available': 2, 'alreadyPresent': 0, 'skipped': 1})
        self.assertEqual([chat['id'] for chat in self.a.chats], ['kept'])
        saved = json.loads(self.a.file.read_text(encoding='utf-8'))
        self.assertEqual([chat['id'] for chat in saved], ['kept'])

    def test_staged_source_uses_a_read_only_codex_review(self):
        candidate = self.a.sources.candidates[0]
        candidate.status = 'staged_for_owner'
        candidate.latest_commit = 'd' * 40
        target = Path(self.directory.name) / 'review-candidates' / candidate.repository.replace('/', '__')
        target.mkdir(parents=True)

        result = self.a.action('sources', {'subAction': 'ai_review', 'repository': candidate.repository})

        self.assertEqual(result['status'], 'started')
        start = next(params for method, params in self.a.bridge.calls if method == 'thread/start')
        self.assertEqual(start['cwd'], str(target.resolve()))
        self.assertEqual(start['sandbox'], 'read-only')
        self.assertIn('不得執行候選專案', start['developerInstructions'])
        self.assertEqual(self.a.chat()['source'], 'source-ai-review')
        self.assertTrue(self.a.busy)

    def test_full_computer_mode_is_owner_only_and_opt_in(self):
        with self.assertRaises(PermissionError):
            self.a.action('send', {
                'text': '不要執行，只測試權限',
                'cwd': self.directory.name,
                'mode': 'danger-full-access',
            }, role='member')
        self.a.action('send', {
            'text': '不要執行，只測試權限',
            'cwd': self.directory.name,
            'mode': 'danger-full-access',
        })
        start = next(params for method, params in self.a.bridge.calls if method == 'thread/start')
        self.assertEqual(start['sandbox'], 'danger-full-access')
        self.assertEqual(self.a.state()['access']['computerControl']['default'], 'read-only')

    def test_desktop_endpoint_requires_owner_and_queues_show(self):
        server = LocalServer(0, self.a)
        server.attach_desktop()
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            body = b'{"action":"show"}'
            member = Request(server.origin + '/api/desktop', data=body, method='POST', headers={
                'Authorization': 'Bearer ' + server.member_token,
                'Content-Type': 'application/json',
            })
            with self.assertRaises(HTTPError) as err:
                urlopen(member)
            self.assertEqual(err.exception.code, 403)
            err.exception.close()
            owner = Request(server.origin + '/api/desktop', data=body, method='POST', headers={
                'Authorization': 'Bearer ' + server.token,
                'Content-Type': 'application/json',
            })
            with urlopen(owner) as response:
                self.assertEqual(json.load(response), {'requested': 'show'})
            self.assertEqual(server.take_desktop_request(), 'show')
        finally:
            server.shutdown()
            server.server_close()

    def test_file_picker_is_owner_only_and_never_accepts_a_browser_path(self):
        server = LocalServer(0, self.a)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            owner_headers = {
                'Authorization': 'Bearer ' + server.token,
                'Content-Type': 'application/json',
            }
            body = b'{"action":"choose_and_open","includePreview":true,"path":"C:\\\\secret.txt"}'
            # A web-only local server reports the missing desktop companion and
            # cannot open files.
            with self.assertRaises(HTTPError) as err:
                urlopen(Request(server.origin + '/api/files', data=body, method='POST', headers=owner_headers))
            self.assertEqual(err.exception.code, 400)
            err.exception.close()
            with urlopen(Request(server.origin + '/api/state', headers={
                'Authorization': 'Bearer ' + server.token,
            })) as response:
                self.assertFalse(json.load(response)['desktop']['available'])

            server.attach_desktop()
            with urlopen(Request(server.origin + '/api/files', data=body, method='POST', headers=owner_headers)) as response:
                self.assertEqual(json.load(response), {'requested': 'choose_and_open', 'pending': True})
            # The native Tk companion receives only a fixed action and preview
            # flag.  The browser-supplied pathname never reaches it.
            self.assertEqual(server.take_file_request(), {
                'action': 'choose_and_open',
                'includePreview': True,
            })
            server.record_file_result({
                'status': 'opened', 'message': '已開啟「notes.txt」。',
                'name': 'notes.txt', 'size': 12, 'mime': 'text/plain',
                'preview': 'hello', 'path': r'C:\\secret.txt',
            })
            with urlopen(Request(server.origin + '/api/state', headers={
                'Authorization': 'Bearer ' + server.token,
            })) as response:
                last = json.load(response)['desktop']['fileAccess']['last']
            self.assertEqual(last['name'], 'notes.txt')
            self.assertNotIn('path', last)

            member = Request(server.origin + '/api/files', data=body, method='POST', headers={
                'Authorization': 'Bearer ' + server.member_token,
                'Content-Type': 'application/json',
            })
            with self.assertRaises(HTTPError) as err:
                urlopen(member)
            self.assertEqual(err.exception.code, 403)
            err.exception.close()
        finally:
            server.shutdown()
            server.server_close()

    def test_http_auth_origin_and_static_allowlist(self):
        server = LocalServer(0, self.a)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            headers = {'Authorization': 'Bearer ' + server.token}
            for path, extra, status in [('/api/state', {}, 401), ('/api/state', {**headers, 'Origin': 'https://evil.example'}, 403), ('/../server.py', {}, 404)]:
                with self.assertRaises(HTTPError) as err:
                    urlopen(Request(server.origin + path, headers=extra))
                self.assertEqual(err.exception.code, status)
                err.exception.close()
            with urlopen(Request(server.origin + '/api/state', headers=headers)) as response:
                self.assertTrue(json.load(response)['ready'])
            with urlopen(server.origin + '/') as response:
                self.assertIn('Mini Codex', response.read().decode())
        finally:
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    unittest.main()
