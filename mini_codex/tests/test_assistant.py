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
