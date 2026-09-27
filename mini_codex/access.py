"""Local ownership and least-privilege policy used by desktop Mini Codex."""
from __future__ import annotations

import json
import os
from pathlib import Path
import secrets


OWNER_ACTIONS = {"send", "stop", "new", "select", "approve", "login", "settings", "sources", "import"}
MEMBER_ACTIONS = {"send", "select", "new"}


class AccessPolicy:
    def __init__(self, data_dir: Path):
        self.path = data_dir / "access.json"
        self.data = self._load()

    def _load(self):
        if self.path.exists():
            try:
                return json.loads(self.path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                pass
        # The local Windows account has owner access at first launch. It is only
        # valid at loopback; public clients are always members until server auth exists.
        data = {"owner": os.environ.get("USERNAME", "owner"), "owner_token": secrets.token_urlsafe(24),
                "members": [], "version": 1}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return data

    def role_for(self, token: str | None) -> str:
        return "owner" if token and secrets.compare_digest(token, self.data["owner_token"]) else "member"

    def allow(self, role: str, action: str) -> bool:
        return action in (OWNER_ACTIONS if role == "owner" else MEMBER_ACTIONS)

    def public(self):
        return {"role": "owner", "owner": self.data["owner"],
                "ownerActions": sorted(OWNER_ACTIONS), "memberActions": sorted(MEMBER_ACTIONS)}
