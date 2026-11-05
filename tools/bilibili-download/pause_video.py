"""Automatically pause the selected Bilibili tab before a media download."""

import base64
import json
import os
import subprocess
from pathlib import Path
from urllib.parse import urlparse


PAUSED_MARKER = "CCM_BILIBILI_PLAYER_PAUSED"
PAUSE_CODE = (
    "if (location.hostname !== 'www.bilibili.com' && "
    "location.hostname !== 'bilibili.com') throw new Error('Not a Bilibili tab'); "
    "const players = [...document.querySelectorAll('video')]; "
    "for (const player of players) player.pause(); "
    "if (players.some(player => !player.paused)) throw new Error('Player still running'); "
    f"return '{PAUSED_MARKER}';"
)


def default_bmgctl():
    return Path(os.environ.get("APPDATA", str(Path.home() / "AppData" / "Roaming"))) / "npm" / "bmgctl.cmd"


def call_bmgctl(name, arguments, bmgctl=None, runner=subprocess.run):
    executable = Path(bmgctl) if bmgctl else default_bmgctl()
    if not executable.is_file():
        raise RuntimeError("BMGCTL is not installed on this Worker")
    payload = base64.b64encode(json.dumps(arguments, separators=(",", ":")).encode("utf-8")).decode("ascii")
    # cmd.exe invokes the trusted local .cmd shim; no signed media URLs or cookies
    # are placed in command arguments or returned to the model.
    completed = runner(["cmd.exe", "/d", "/c", str(executable), "call", name,
                        "--args-base64", payload], capture_output=True,
                       text=True, timeout=35)
    if completed.returncode:
        raise RuntimeError(f"BMGCTL {name} failed (exit {completed.returncode})")
    try:
        response = json.loads(completed.stdout)
    except (ValueError, TypeError) as exc:
        raise RuntimeError(f"Invalid BMGCTL {name} response") from exc
    result = response.get("result") or {}
    if not response.get("success") or result.get("isError"):
        raise RuntimeError(f"BMGCTL {name} returned an error")
    return result


def pause_bilibili_tab(tab_id, *, call=call_bmgctl):
    if type(tab_id) is not int or tab_id <= 0:
        raise ValueError("A positive BMGCTL browser_tab_id is required")
    windows = call("get_windows_and_tabs", {})
    try:
        listing = json.loads(next(item["text"] for item in windows["content"]
                                  if item.get("type") == "text"))
        matching = [tab for window in listing["windows"] for tab in window.get("tabs", [])
                    if tab.get("tabId") == tab_id]
    except (ValueError, KeyError, StopIteration, TypeError) as exc:
        raise RuntimeError("Cannot verify BMGCTL tab identity") from exc
    if len(matching) != 1:
        raise RuntimeError("BMGCTL browser_tab_id is missing or ambiguous")
    page = urlparse(matching[0].get("url", ""))
    if page.scheme != "https" or page.hostname not in ("www.bilibili.com", "bilibili.com"):
        raise RuntimeError("Selected browser tab is not a Bilibili page")
    result = call("chrome_javascript", {"tabId": tab_id, "code": PAUSE_CODE,
                                        "timeoutMs": 5000})
    if not any(PAUSED_MARKER in item.get("text", "") for item in result.get("content", [])
               if item.get("type") == "text"):
        raise RuntimeError("Bilibili player pause could not be verified")
    return True
