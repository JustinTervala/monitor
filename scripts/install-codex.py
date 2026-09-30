#!/usr/bin/env python3
"""Install Monitor's personal Codex plugin and chain the completion callback.

Requires Python 3.11+, a current Codex CLI, and macOS. Never edits hook trust.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib

NAME = "monitor-codex"
REPO = Path(__file__).resolve().parent.parent


def atomic_write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, prefix=".monitor-", delete=False) as out:
            temp = out.name
            out.write(content)
        os.replace(temp, path)
    finally:
        if temp and os.path.exists(temp):
            os.unlink(temp)


def replace_notify(text, command):
    """Change exactly the root notify assignment, retaining unrelated TOML and comments."""
    before = tomllib.loads(text)
    replacement = "" if command is None else "notify = " + json.dumps(command, ensure_ascii=False) + "\n"
    if "notify" not in before:
        updated = replacement + text
    else:
        match = re.search(r"(?m)^[ \t]*notify[ \t]*=", text)
        if not match:
            raise ValueError('Use the unquoted root key notify in config.toml before installing Monitor.')
        # Ensure this is a root assignment, not a key inside a table.
        prefix = text[:match.start()]
        if tomllib.loads(prefix + "notify = []\n").get("notify") != []:
            raise ValueError('Could not locate the root notify assignment safely.')
        end = match.start()
        for line in text[match.start():].splitlines(keepends=True):
            end += len(line)
            try:
                parsed = tomllib.loads(text[match.start():end])
            except tomllib.TOMLDecodeError:
                continue
            if list(parsed) == ["notify"]:
                break
        else:
            raise ValueError('Could not parse the notify assignment.')
        updated = prefix + replacement + text[end:]
    expected = dict(before)
    if command is None:
        expected.pop("notify", None)
    else:
        expected["notify"] = command
    if tomllib.loads(updated) != expected:
        raise ValueError('Refusing a configuration edit that changes other settings.')
    return updated


def install(codex, uninstall=False):
    home = Path.home()
    config = Path(os.environ.get("CODEX_HOME", str(home / ".codex"))) / "config.toml"
    bridge = home / "Library/Application Support/Monitor/codex-bridge"
    wrapper = bridge / "record.py"
    forwarding = bridge / "forward.json"
    python = shutil.which("python3") or sys.executable
    command = [python, str(wrapper), "--notify"]
    text = config.read_text() if config.exists() else ""
    current = tomllib.loads(text).get("notify")
    installed = isinstance(current, list) and len(current) == 3 and current[1:] == command[1:]
    previous = json.loads(forwarding.read_text()).get("command") if installed else current
    if previous is not None and (not isinstance(previous, list) or not all(isinstance(x, str) for x in previous)):
        raise ValueError('The existing notify setting must be an array of strings.')
    if previous and str(wrapper) in previous:
        raise ValueError('Refusing a recursive Monitor completion callback.')
    # Validate the complete edit before copying plugins or invoking the CLI.
    updated = replace_notify(text, previous if uninstall else command)
    marketplace_path = home / ".agents/plugins/marketplace.json"
    marketplace = json.loads(marketplace_path.read_text()) if marketplace_path.exists() else {
        "name": "personal", "interface": {"displayName": "Personal"}, "plugins": []}
    market_name = marketplace.get("name")
    if not isinstance(market_name, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", market_name):
        raise ValueError('Invalid personal marketplace name.')
    entries = marketplace.get("plugins")
    if not isinstance(entries, list):
        raise ValueError('The personal marketplace plugins field must be an array.')
    plugin_id = NAME + "@" + market_name
    if uninstall:
        subprocess.run([codex, "plugin", "remove", plugin_id], check=True)
        # The CLI also edits config.toml. Read it again to preserve those edits.
        text = config.read_text() if config.exists() else ""
        if installed and tomllib.loads(text).get("notify") == current:
            atomic_write(config, replace_notify(text, previous))
        marketplace["plugins"] = [entry for entry in entries if entry.get("name") != NAME]
        atomic_write(marketplace_path, json.dumps(marketplace, indent=2) + "\n")
        print('Removed Monitor Codex integration. Task data and existing notifications are preserved.')
        return
    source = REPO / "plugins" / NAME
    destination = home / "plugins" / NAME
    if destination.exists():
        manifest = json.loads((destination / ".codex-plugin/plugin.json").read_text())
        if manifest.get("name") != NAME or manifest.get("author", {}).get("name") != "Justin Tervala":
            raise ValueError('The destination belongs to a different plugin.')
    for relative in (".codex-plugin/plugin.json", "hooks/hooks.json", "hooks/record.py"):
        atomic_write(destination / relative, (source / relative).read_text())
    entry = {"name": NAME, "source": {"source": "local", "path": "./plugins/" + NAME},
             "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
             "category": "Productivity"}
    for index, old in enumerate(entries):
        if old.get("name") == NAME:
            if old.get("source") != entry["source"]:
                raise ValueError('An existing Monitor marketplace entry points elsewhere.')
            entries[index] = entry
            break
    else:
        entries.append(entry)
    atomic_write(marketplace_path, json.dumps(marketplace, indent=2) + "\n")
    subprocess.run([codex, "plugin", "add", plugin_id], check=True)
    bridge.mkdir(parents=True, exist_ok=True, mode=0o700)
    atomic_write(wrapper, (source / "hooks/record.py").read_text())
    atomic_write(forwarding, json.dumps({"command": previous}) + "\n")
    text = config.read_text() if config.exists() else ""
    if tomllib.loads(text).get("notify") != current:
        raise ValueError('notify changed during installation; leaving it untouched. Run the installer again.')
    atomic_write(config, replace_notify(text, command))
    print('Installed ' + plugin_id + '. Existing completion callback preserved.')
    print('Restart Codex, review and trust Monitor hooks in /hooks, then start or resume a task.')
    print('Hook trust is not granted by this installer.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--codex', default=shutil.which('codex'), help='Path to the current Codex CLI')
    parser.add_argument('--uninstall', action='store_true')
    args = parser.parse_args()
    if not args.codex:
        parser.error('Install the current Codex CLI or pass --codex /path/to/codex.')
    install(args.codex, args.uninstall)


if __name__ == '__main__':
    main()
