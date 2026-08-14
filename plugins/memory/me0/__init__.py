"""me0 memory provider for Hermes Agent.

Replaces the built-in 2,200-char MEMORY.md cap with the user's portable,
MongoDB-backed context graph. Serves a frozen-snapshot context pack (computed
once per session so Hermes's prompt-cache prefix stays stable) and captures
the session as a first-class me0 episode (episode_start / episode_log /
episode_end).

All me0 calls shell out to the `me0` CLI (`me0 op <verb> '<json>'`) — no
Python dependencies, no direct database access. Every hook is fail-open: a
memory outage never blocks the agent.

Install: copy this directory into hermes-agent's `plugins/memory/me0/`, then
    hermes config set memory.provider me0
Requires the me0 CLI on PATH (`npm i -g @8gratitude8/me0`) and a
configured store (`me0 init`). See README.md.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider

logger = logging.getLogger(__name__)

_OP_TIMEOUT_SECS = 15


def _run_op(verb: str, args: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    """Invoke a me0 verb via the CLI. Returns parsed JSON, or None on any failure."""
    try:
        proc = subprocess.run(
            ["me0", "op", verb, json.dumps(args or {})],
            capture_output=True,
            text=True,
            timeout=_OP_TIMEOUT_SECS,
        )
        if proc.returncode != 0:
            logger.warning("me0 op %s failed: %s", verb, proc.stderr.strip()[:200])
            return None
        return json.loads(proc.stdout)
    except Exception as exc:  # fail-open: never propagate memory errors
        logger.warning("me0 op %s error: %s", verb, exc)
        return None


class Me0MemoryProvider(MemoryProvider):
    """Context-graph memory provider backed by me0."""

    def __init__(self) -> None:
        self._session_id: str = ""
        self._episode_id: Optional[str] = None
        self._pack_snapshot: str = ""  # frozen for the life of the session
        self._sync_thread: Optional[threading.Thread] = None

    @property
    def name(self) -> str:
        return "me0"

    # -- Core lifecycle -----------------------------------------------------

    def is_available(self) -> bool:
        """me0 CLI on PATH and configured (env vars or config file). No network calls."""
        if shutil.which("me0") is None:
            return False
        if os.environ.get("ME0_MONGODB_URI"):
            return True
        data_dir = os.environ.get("ME0_DATA")
        root = Path(data_dir) if data_dir else Path.home() / ".me0"
        return (root / "config.json").exists()

    def initialize(self, session_id: str, **kwargs) -> None:
        self._session_id = session_id
        if kwargs.get("agent_context") in (None, "primary"):
            # never write from cron/subagent/flush contexts
            started = _run_op(
                "episode_start",
                {
                    "harness": "hermes",
                    "agent_name": kwargs.get("agent_identity") or "hermes",
                    "title": f"hermes session {session_id}",
                },
            )
            self._episode_id = started.get("episode_id") if started else None
        self._freeze_pack()

    def _freeze_pack(self) -> None:
        """Compute the context pack exactly once per session (stable prefix)."""
        pack = _run_op("context_pack", {"scope": "harness:hermes"})
        self._pack_snapshot = (pack or {}).get("content") or ""

    def system_prompt_block(self) -> str:
        """The frozen-snapshot pack. Identical bytes for the whole session."""
        if not self._pack_snapshot:
            return ""
        return f"<me0 context pack>\n{self._pack_snapshot}\n</me0 context pack>"

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        """Context-only provider: the verbs are exposed via MCP (see README)."""
        return []

    def sync_turn(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_id: str = "",
        messages: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        """Log the turn to the episode. Non-blocking (daemon thread), fail-open."""
        episode_id = self._episode_id
        if not episode_id:
            return

        def _sync() -> None:
            _run_op(
                "episode_log",
                {
                    "episode_id": episode_id,
                    "type": "prompt",
                    "payload": {"text": (user_content or "")[:2000]},
                },
            )
            _run_op(
                "episode_log",
                {
                    "episode_id": episode_id,
                    "type": "response",
                    "payload": {"text": (assistant_content or "")[:2000]},
                },
            )

        if self._sync_thread and self._sync_thread.is_alive():
            self._sync_thread.join(timeout=5.0)
        self._sync_thread = threading.Thread(target=_sync, daemon=True)
        self._sync_thread.start()

    # -- Optional hooks -----------------------------------------------------

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        if not self._episode_id:
            return
        _run_op("episode_end", {"episode_id": self._episode_id})
        self._episode_id = None

    def on_session_switch(
        self,
        new_session_id: str,
        *,
        parent_session_id: str = "",
        reset: bool = False,
        rewound: bool = False,
        **kwargs,
    ) -> None:
        self._session_id = new_session_id
        if reset:
            if self._episode_id:
                _run_op("episode_end", {"episode_id": self._episode_id})
            started = _run_op("episode_start", {"harness": "hermes", "agent_name": "hermes"})
            self._episode_id = started.get("episode_id") if started else None
            self._freeze_pack()  # genuinely new conversation → new snapshot

    def on_pre_compress(self, messages: List[Dict[str, Any]]) -> str:
        if self._episode_id:
            _run_op(
                "episode_log",
                {
                    "episode_id": self._episode_id,
                    "type": "command",
                    "tool": "hermes.compress",
                    "payload": {"messages_compressed": len(messages)},
                },
            )
        return ""

    def shutdown(self) -> None:
        if self._sync_thread and self._sync_thread.is_alive():
            self._sync_thread.join(timeout=5.0)
        if self._episode_id:
            _run_op("episode_end", {"episode_id": self._episode_id})
            self._episode_id = None

    # -- Config -------------------------------------------------------------

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return [
            {
                "key": "mongodb_uri",
                "description": "MongoDB URI for the me0 store",
                "default": "mongodb://127.0.0.1:27017",
            },
            {
                "key": "user_id",
                "description": "me0 user id",
                "default": "me",
            },
        ]

    def save_config(self, values: dict, hermes_home: str) -> None:
        """Persist via `me0 init` so the CLI and MCP server share one config."""
        try:
            subprocess.run(
                [
                    "me0",
                    "init",
                    "--uri",
                    values.get("mongodb_uri", "mongodb://127.0.0.1:27017"),
                    "--user",
                    values.get("user_id", "me"),
                ],
                capture_output=True,
                text=True,
                timeout=60,
            )
        except Exception as exc:
            logger.warning("me0 init failed: %s", exc)


def register(ctx) -> None:
    """Called by Hermes's memory plugin discovery system."""
    ctx.register_memory_provider(Me0MemoryProvider())
