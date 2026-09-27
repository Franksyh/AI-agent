"""Local ownership and least-privilege policy used by desktop Mini Codex."""
from __future__ import annotations

import json
import os
from pathlib import Path
import secrets


OWNER_ACTIONS = frozenset({
    "send", "stop", "new", "select", "approve", "login", "settings",
    "sources", "import", "desktop", "files",
})
# The local server deliberately does not issue member work sessions yet.
# A future hosted pairing flow needs per-member history and an identity
# provider before it can safely offer "use" access alongside owner chats.
MEMBER_ACTIONS = frozenset()
OWNER_MODES = ("read-only", "workspace-write", "danger-full-access")
MEMBER_MODES = ("read-only",)


class AccessPolicy:
    """Keep local access decisions explicit and independent from the UI.

    A loopback launch URL is an owner session. Public/member authentication is
    deliberately not inferred from a browser request: that needs a hosted
    identity provider and separate per-user conversation storage.
    """

    def __init__(self, data_dir: Path):
        self.path = Path(data_dir) / "access.json"
        self.data = self._load()

    def _load(self):
        if self.path.exists():
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
                if isinstance(data, dict) and isinstance(data.get("owner"), str):
                    data.setdefault("owner_token", secrets.token_urlsafe(24))
                    data.setdefault("members", [])
                    data.setdefault("version", 2)
                    return data
            except (json.JSONDecodeError, OSError):
                pass

        # The local Windows account is the owner at first launch. The retained
        # token identifies the local profile only; an active loopback session
        # receives its own short-lived launch token.
        data = {
            "owner": os.environ.get("USERNAME", "owner"),
            "owner_token": secrets.token_urlsafe(24),
            "members": [],
            "version": 2,
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return data

    @staticmethod
    def _same(left: str | None, right: str | None) -> bool:
        return bool(left and right and secrets.compare_digest(left, right))

    def role_for(
        self,
        token: str | None,
        *,
        owner_session_token: str | None = None,
        member_session_token: str | None = None,
    ) -> str | None:
        """Return the role represented by a verified session token.

        ``None`` means the caller has not authenticated. A member session is
        intentionally read-only and can be used by a future hosted pairing
        flow; the local launcher only creates an owner session today.
        """
        if self._same(token, owner_session_token) or self._same(token, self.data.get("owner_token")):
            return "owner"
        if self._same(token, member_session_token):
            return "member"
        return None

    def allow(self, role: str | None, action: str) -> bool:
        return action in (OWNER_ACTIONS if role == "owner" else MEMBER_ACTIONS if role == "member" else ())

    def require(self, role: str | None, action: str):
        if not self.allow(role, action):
            raise PermissionError("此操作需要擁有者權限")

    def allowed_modes(self, role: str | None) -> tuple[str, ...]:
        return OWNER_MODES if role == "owner" else MEMBER_MODES if role == "member" else ()

    def allow_mode(self, role: str | None, mode: str) -> bool:
        return mode in self.allowed_modes(role)

    def public(self, role: str | None):
        capabilities = {
            "owner": ["讀取", "編輯", "核准", "開源更新審查", "電腦控制", "本機檔案"],
            "member": ["使用", "讀取（不含擁有者資料）"],
        }
        resolved_role = role if role in capabilities else "unauthenticated"
        return {
            "role": resolved_role,
            # Do not expose the local Windows account name to a member session.
            "owner": self.data["owner"] if resolved_role == "owner" else None,
            "capabilities": capabilities.get(resolved_role, []),
            "ownerCapabilities": capabilities["owner"],
            "memberCapabilities": capabilities["member"],
            "allowedModes": list(self.allowed_modes(role)),
            "computerControl": {
                "mode": "danger-full-access",
                "ownerOnly": True,
                "default": "read-only",
                "approval": "每次可能影響系統的操作仍由 Codex 要求核准。",
            },
            "session": "本機擁有者工作階段" if resolved_role == "owner" else "成員工作階段",
        }
