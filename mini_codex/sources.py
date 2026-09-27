"""Trusted open-source discovery and review candidates for Mini Codex.

Candidates are never executed or installed automatically. A local owner must
inspect the review and explicitly apply an update after its checks pass.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import UTC, datetime
import json
from pathlib import Path
import subprocess
from urllib.error import URLError
from urllib.request import Request, urlopen


TRUSTED_SOURCES = (
    ("OpenAI Codex", "openai/codex", "Apache-2.0", "Codex App Server and CLI"),
    ("OpenAI gpt-oss", "openai/gpt-oss", "Apache-2.0", "Open-weight model resources"),
    ("Google Gemini CLI", "google-gemini/gemini-cli", "Apache-2.0", "CLI agent reference"),
    ("Perplexity Bumblebee", "perplexityai/bumblebee", "Apache-2.0", "Open-source agent reference"),
    ("Apple Intelligence CLI", "onmyway133/apple-intelligence-cli", "MIT", "Apple-focused CLI reference"),
    ("Siri Ultra", "fatwang2/siri-ultra", "MIT", "Voice assistant reference"),
)


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def github_json(path: str) -> dict:
    request = Request(
        f"https://api.github.com{path}",
        headers={"Accept": "application/vnd.github+json", "User-Agent": "Mini-Codex-Source-Review"},
    )
    with urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


@dataclass
class Candidate:
    name: str
    repository: str
    license: str
    purpose: str
    default_branch: str = "main"
    latest_commit: str | None = None
    latest_message: str | None = None
    url: str | None = None
    checked_at: str | None = None
    status: str = "not_checked"
    review: dict | None = None


class SourceManager:
    def __init__(self, data_dir: Path):
        self.path = data_dir / "source-candidates.json"
        self.candidates = self._load()

    def _load(self) -> list[Candidate]:
        if self.path.exists():
            try:
                return [Candidate(**item) for item in json.loads(self.path.read_text(encoding="utf-8"))]
            except (json.JSONDecodeError, OSError, TypeError):
                pass
        return [Candidate(*item) for item in TRUSTED_SOURCES]

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps([asdict(c) for c in self.candidates], ensure_ascii=False, indent=2), encoding="utf-8")
        try:
            temporary.replace(self.path)
        except OSError:
            self.path.write_text(temporary.read_text(encoding="utf-8"), encoding="utf-8")
            temporary.unlink(missing_ok=True)

    def list(self) -> list[dict]:
        return [asdict(candidate) for candidate in self.candidates]

    def refresh(self) -> list[dict]:
        for candidate in self.candidates:
            try:
                metadata = github_json(f"/repos/{candidate.repository}")
                branch = metadata.get("default_branch") or "main"
                commit = github_json(f"/repos/{candidate.repository}/commits/{branch}")
                candidate.default_branch = branch
                candidate.latest_commit = commit.get("sha")
                candidate.latest_message = (commit.get("commit", {}).get("message") or "").split("\n", 1)[0]
                candidate.license = (metadata.get("license") or {}).get("spdx_id") or candidate.license
                candidate.url = metadata.get("html_url")
                candidate.checked_at = utc_now()
                candidate.status = "review_required"
            except (URLError, TimeoutError, OSError, ValueError) as error:
                candidate.checked_at = utc_now()
                candidate.status = "unavailable"
                candidate.review = {"decision": "hold", "reason": f"無法取得來源：{error}"}
        self.save()
        return self.list()

    def review(self, repository: str) -> dict:
        candidate = self._find(repository)
        if candidate.status == "not_checked":
            self.refresh()
        # Deterministic gate. AI review is added by Assistant with Codex in a
        # read-only thread; this gate prevents ambiguous licensing from passing.
        allowed_licenses = {"Apache-2.0", "MIT", "BSD-3-Clause", "ISC"}
        license_ok = candidate.license in allowed_licenses
        commit_ok = bool(candidate.latest_commit and len(candidate.latest_commit) >= 7)
        decision = "recommend_owner_review" if license_ok and commit_ok else "hold"
        candidate.review = {
            "decision": decision,
            "checks": {
                "trusted_source": True,
                "license": candidate.license,
                "license_allowed": license_ok,
                "commit_resolved": commit_ok,
                "automatic_install": False,
            },
            "reason": "候選程式只會下載到隔離的審查資料夾；需由擁有者核准才能套用。",
            "reviewed_at": utc_now(),
        }
        candidate.status = "owner_review" if decision != "hold" else "hold"
        self.save()
        return asdict(candidate)

    def stage(self, repository: str, staging_root: Path) -> dict:
        candidate = self._find(repository)
        if candidate.status != "owner_review":
            raise ValueError("請先完成來源檢查與審查")
        target = staging_root / repository.replace("/", "__")
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            raise ValueError("這個候選版本已在審查資料夾，請先檢視後再決定")
        subprocess.run(
            ["git", "clone", "--depth", "1", "--branch", candidate.default_branch,
             f"https://github.com/{repository}.git", str(target)],
            check=True, timeout=120, capture_output=True, text=True,
        )
        candidate.status = "staged_for_owner"
        self.save()
        return {"repository": repository, "path": str(target), "commit": candidate.latest_commit,
                "message": "已下載到隔離審查資料夾，尚未安裝或執行。"}

    def _find(self, repository: str) -> Candidate:
        item = next((c for c in self.candidates if c.repository == repository), None)
        if not item:
            raise ValueError("不是受信任的來源")
        return item
