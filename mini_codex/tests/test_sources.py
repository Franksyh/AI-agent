from pathlib import Path
import json
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sources import SourceManager


class SourceManagerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.data = Path(self.directory.name)
        self.manager = SourceManager(self.data)

    def test_cache_cannot_change_trusted_repository_identity(self):
        self.manager.path.write_text(json.dumps([
            {
                'repository': 'openai/codex',
                'name': 'untrusted name',
                'purpose': 'untrusted purpose',
                'url': 'https://example.invalid',
                'status': 'review_required',
            },
            {'repository': 'someone/else', 'name': 'not allowed'},
        ]), encoding='utf-8')

        loaded = SourceManager(self.data)
        codex = next(item for item in loaded.candidates if item.repository == 'openai/codex')
        self.assertEqual(codex.name, 'OpenAI Codex')
        self.assertEqual(codex.purpose, 'Codex App Server and CLI')
        self.assertEqual(len(loaded.candidates), 6)

    def test_stage_fetches_exact_reviewed_sha(self):
        candidate = self.manager.candidates[0]
        candidate.status = 'owner_review'
        candidate.latest_commit = 'a' * 40
        staging = self.data / 'review-candidates'
        head = subprocess.CompletedProcess([], 0, stdout=('a' * 40) + '\n')
        ordinary = subprocess.CompletedProcess([], 0, stdout='')

        with patch('sources.subprocess.run', side_effect=[ordinary, ordinary, ordinary, ordinary, head]) as run:
            result = self.manager.stage(candidate.repository, staging)

        fetch = next(call.args[0] for call in run.call_args_list if 'fetch' in call.args[0])
        self.assertEqual(fetch[-1], 'a' * 40)
        self.assertEqual(result['commit'], 'a' * 40)

    def test_stage_converts_git_failure_to_safe_request_error(self):
        candidate = self.manager.candidates[0]
        candidate.status = 'owner_review'
        candidate.latest_commit = 'b' * 40
        with patch('sources.subprocess.run', side_effect=subprocess.TimeoutExpired(['git'], 1)):
            with self.assertRaisesRegex(ValueError, '無法下載'):
                self.manager.stage(candidate.repository, self.data / 'review-candidates')

    def test_staged_path_only_returns_existing_isolated_candidate(self):
        candidate = self.manager.candidates[0]
        candidate.status = 'staged_for_owner'
        candidate.latest_commit = 'c' * 40
        staging = self.data / 'review-candidates'
        expected = staging / candidate.repository.replace('/', '__')
        expected.mkdir(parents=True)

        returned, target = self.manager.staged_path(candidate.repository, staging)
        self.assertIs(returned, candidate)
        self.assertEqual(target, expected.resolve())


if __name__ == '__main__':
    unittest.main()
