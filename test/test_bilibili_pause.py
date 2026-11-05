"""Offline unit tests for automatic Bilibili pre-download pause."""

import base64
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import sys
import unittest
from uuid import uuid4


SOURCE = Path(__file__).resolve().parents[1] / "tools" / "bilibili-download" / "pause_video.py"
spec = importlib.util.spec_from_file_location("pause_video", SOURCE)
pause = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pause)
sys.modules["pause_video"] = pause
download_spec = importlib.util.spec_from_file_location(
    "download_dash", SOURCE.with_name("download-dash.py"))
download = importlib.util.module_from_spec(download_spec)
download_spec.loader.exec_module(download)


def tabs(*pages):
    return {"content": [{"type": "text", "text": json.dumps({
        "windows": [{"tabs": [{"tabId": tab_id, "url": url} for tab_id, url in pages]}]
    })}]}


class PauseTests(unittest.TestCase):
    def test_pauses_only_verified_selected_bilibili_tab(self):
        calls = []

        def mock_call(name, args):
            calls.append((name, args))
            return tabs((17, "https://www.bilibili.com/video/BV123"),
                        (18, "https://example.com")) if name == "get_windows_and_tabs" else {
                            "content": [{"type": "text", "text": pause.PAUSED_MARKER}]}

        self.assertTrue(pause.pause_bilibili_tab(17, call=mock_call))
        self.assertEqual([x[0] for x in calls], ["get_windows_and_tabs", "chrome_javascript"])
        self.assertEqual(calls[1][1]["tabId"], 17)
        self.assertIn("player.pause()", calls[1][1]["code"])

    def test_refuses_unrelated_or_missing_tabs(self):
        for tab_id in (18, 19):
            calls = []

            def mock_call(name, args):
                calls.append(name)
                return tabs((17, "https://www.bilibili.com/video/BV123"),
                            (18, "https://example.com"))

            with self.assertRaises(RuntimeError):
                pause.pause_bilibili_tab(tab_id, call=mock_call)
            self.assertEqual(calls, ["get_windows_and_tabs"])

    def test_fails_closed_without_verifiable_pause(self):
        def mock_call(name, args):
            return tabs((17, "https://www.bilibili.com/")) if name == "get_windows_and_tabs" else {
                "content": [{"type": "text", "text": "did not pause"}]}

        with self.assertRaisesRegex(RuntimeError, "could not be verified"):
            pause.pause_bilibili_tab(17, call=mock_call)

    def test_call_encodes_only_browser_parameters(self):
        seen = []

        def runner(cmd, **kwargs):
            seen.append(cmd)
            return SimpleNamespace(returncode=0, stdout=json.dumps({
                "success": True, "result": {"content": [{"type": "text", "text": "OK"}]}}))

        result = pause.call_bmgctl("chrome_javascript", {"tabId": 17, "code": "return 'OK'"},
                                  bmgctl=SOURCE, runner=runner)
        self.assertEqual(result["content"][0]["text"], "OK")
        self.assertEqual(seen[0][:3], ["cmd.exe", "/d", "/c"])
        self.assertEqual(json.loads(base64.b64decode(seen[0][-1])),
                         {"tabId": 17, "code": "return 'OK'"})

    def test_failed_pause_consumes_secret_handoff_before_transfer(self):
        # Windows CCM restricted tokens cannot access a new private
        # TemporaryDirectory ACL. Use an ignored file in an existing folder.
        handoff = SOURCE.parents[2] / ".cache" / f".test-bili-{uuid4().hex}.json"
        try:
            handoff.write_text(json.dumps({"video_url": "signed", "audio_url": "signed"}),
                               encoding="utf-8")

            def failed_pause(tab_id):
                self.assertEqual(tab_id, 17)
                raise RuntimeError("BMGCTL unavailable")

            with self.assertRaisesRegex(RuntimeError, "BMGCTL unavailable"):
                download.consume_handoff_and_pause(handoff, 17, pause=failed_pause)
            self.assertFalse(handoff.exists())
        finally:
            handoff.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
