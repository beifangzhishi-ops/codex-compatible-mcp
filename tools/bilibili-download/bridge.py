"""One-shot localhost handoff of Bilibili signed DASH URLs from the BMGCTL browser.

The browser sends secrets directly to an ignored Worker-local file, not through
the BMGCTL tool response (which intentionally redacts signed URLs).
"""

import json
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


OUTPUT = Path(__file__).resolve().parents[2] / ".cache" / "bilibili-download" / "dash_urls.json"
ORIGIN = "https://www.bilibili.com"


class Handler(BaseHTTPRequestHandler):
    def send_cors(self):
        self.send_header("Access-Control-Allow-Origin", ORIGIN)
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Vary", "Origin")

    def respond(self, status):
        self.send_response(status)
        self.send_cors()
        self.end_headers()

    def do_OPTIONS(self):
        if self.path != "/dash" or self.headers.get("Origin") != ORIGIN:
            return self.respond(403)
        self.respond(204)

    def do_POST(self):
        if self.path != "/dash" or self.headers.get("Origin") != ORIGIN:
            return self.respond(403)
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= 65536:
            return self.respond(413)
        try:
            value = json.loads(self.rfile.read(length))
            if not isinstance(value, dict):
                raise ValueError("JSON object required")
            if not isinstance(value.get("video_url"), str) or not value["video_url"].startswith("https://"):
                raise ValueError("Missing video URL")
            if not isinstance(value.get("audio_url"), str) or not value["audio_url"].startswith("https://"):
                raise ValueError("Missing audio URL")
            if not 1 <= int(value["expected_height"]) <= 10000:
                raise ValueError("Invalid height")
            OUTPUT.parent.mkdir(parents=True, exist_ok=True)
            OUTPUT.write_text(json.dumps({
                "video_url": value["video_url"],
                "audio_url": value["audio_url"],
                "expected_height": int(value["expected_height"]),
            }), encoding="utf-8")
        except (ValueError, KeyError, TypeError):
            return self.respond(400)
        self.server.completed = True
        self.respond(204)

    def log_message(self, *_):
        pass


if __name__ == "__main__":
    OUTPUT.unlink(missing_ok=True)
    with HTTPServer(("127.0.0.1", 8765), Handler) as server:
        server.timeout = 2
        server.completed = False
        stop_at = time.monotonic() + 180
        print("BRIDGE_READY 127.0.0.1:8765", flush=True)
        while not server.completed and time.monotonic() < stop_at:
            server.handle_request()
        print("BRIDGE_RECEIVED" if server.completed else "BRIDGE_TIMED_OUT", flush=True)
