"""Local metadata bridge. Hooks never make decisions or return model context."""

import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

EVENTS = {
    "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse",
    "PreCompact", "PostCompact", "Stop", "Interrupt", "SessionEnd",
}
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{5,127}\Z")


def record(payload, notification=False):
    if not isinstance(payload, dict) or payload.get("agent_id"):
        return
    event = "TurnComplete" if notification else payload.get("hook_event_name")
    if notification and payload.get("type") != "agent-turn-complete":
        return
    if not notification and event not in EVENTS:
        return
    session = payload.get("thread-id" if notification else "session_id")
    turn = payload.get("turn-id" if notification else "turn_id")
    if not isinstance(session, str) or not ID.fullmatch(session):
        return
    if turn is not None and (not isinstance(turn, str) or not ID.fullmatch(turn)):
        return
    if event not in {"SessionStart", "SessionEnd"} and not turn:
        return
    root = Path(os.environ.get("MONITOR_CODEX_HOOKS_DIR", str(
        Path.home() / "Library/Application Support/Monitor/codex-hooks")))
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = root.lstat()
    if root.is_symlink() or info.st_uid != os.getuid() or info.st_mode & 0o077:
        return
    lock_path = root / (session + ".lock")
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as lock:
        # Hooks are bounded and must never stall an agent on an observer lock.
        for attempt in range(50):
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if attempt == 49:
                    return
                time.sleep(0.01)
        path = root / (session + ".json")
        state = {"version": 1, "sessionId": session}
        try:
            source = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(source) as previous:
                raw = json.loads(previous.read(16385))
            if raw.get("version") == 1 and raw.get("sessionId") == session:
                # Never carry arbitrary fields from disk into the next record.
                for key in ("activity", "completion"):
                    old = raw.get(key)
                    if isinstance(old, dict):
                        state[key] = {k: old[k] for k in ("event", "turnId", "at") if k in old}
        except (OSError, ValueError, AttributeError):
            pass
        observation = {"event": event, "turnId": turn, "at": time.time_ns() / 1_000_000}
        if notification:
            # A late notification from an older turn cannot replace the current turn.
            activity = state.get("activity", {})
            if activity.get("turnId") and activity["turnId"] != turn:
                return
            state["completion"] = observation
        elif event not in {"SessionStart", "SessionEnd"}:
            state["activity"] = observation
            state.pop("completion", None)
        elif event == "SessionStart":
            # Compaction happens inside a turn; it must not erase its identity.
            if payload.get("source") != "compact":
                state["activity"] = observation
                state.pop("completion", None)
        else:
            observation["turnId"] = state.get("activity", {}).get("turnId")
            state["activity"] = observation
        temp = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", dir=root, prefix=".", delete=False) as out:
                temp = out.name
                json.dump(state, out, separators=(",", ":"))
            os.replace(temp, path)
        finally:
            if temp and os.path.exists(temp):
                os.unlink(temp)


def forward_notification(raw):
    """Preserve the pre-existing notify callback without logging its payload."""
    try:
        config = json.loads(Path(__file__).with_name("forward.json").read_text())
        command = config.get("command")
        if isinstance(command, list) and command and all(isinstance(x, str) for x in command):
            subprocess.run(command + [raw], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=10, check=False)
    except Exception:
        pass


def main():
    notification = len(sys.argv) > 1 and sys.argv[1] == "--notify"
    raw = sys.argv[2] if notification and len(sys.argv) == 3 else None
    try:
        record(json.loads(raw if notification else sys.stdin.read()), notification)
    except Exception:
        # Recording is advisory, including on invalid inputs and filesystem failures.
        pass
    finally:
        if notification:
            if raw is not None:
                forward_notification(raw)
        else:
            # Stop expects JSON. Empty output or prose can be rejected by the harness.
            print("{}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
