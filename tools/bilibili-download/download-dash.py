"""Download a BMGCTL-selected Bilibili DASH pair without exposing signed URLs.

The ignored one-shot handoff file is produced by bridge.py. It is consumed and
deleted on every invocation, including when the download fails.
"""

import argparse
import json
import shutil
import subprocess
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4


def run(*args, timeout=900):
    proc = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        # Do not include command arguments: they contain signed media URLs.
        raise RuntimeError(f"{Path(args[0]).name} exited with code {proc.returncode}: "
                           + proc.stderr.strip()[:600])
    return proc.stdout


def main():
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser()
    parser.add_argument("--handoff-file", default=str(root / ".cache" / "bilibili-download" / "dash_urls.json"))
    parser.add_argument("--output", required=True)
    parser.add_argument("--timeout", type=int, default=900)
    args = parser.parse_args()
    handoff = Path(args.handoff_file).resolve()
    if handoff != (root / ".cache" / "bilibili-download" / "dash_urls.json").resolve():
        raise ValueError("Handoff path must be the fixed ignored Bilibili bridge file")
    try:
        data = json.loads(handoff.read_text(encoding="utf-8"))
    finally:
        handoff.unlink(missing_ok=True)
    video_url = data["video_url"]
    audio_url = data["audio_url"]
    expected_height = int(data["expected_height"])
    if not 1 <= expected_height <= 10000:
        raise ValueError("Invalid expected height")
    for url in (video_url, audio_url):
        info = urlparse(url)
        if info.scheme != "https" or not info.hostname:
            raise ValueError("Media URLs must be HTTPS")

    curl = shutil.which("curl.exe")
    ffmpeg = shutil.which("ffmpeg.exe")
    ffprobe = shutil.which("ffprobe.exe")
    if not all((curl, ffmpeg, ffprobe)):
        raise RuntimeError("curl.exe, ffmpeg.exe, and ffprobe.exe are required")

    output = Path(args.output).resolve()
    if output.exists():
        raise FileExistsError("Destination already exists; refusing to overwrite")
    output.parent.mkdir(parents=True, exist_ok=True)
    referer = "https://www.bilibili.com/"
    user_agent = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36")

    # Python's TemporaryDirectory(mode=0700) can create an inaccessible ACL
    # under a Windows CCM restricted token. Use files in the existing writable
    # ignored directory, not a newly restricted subdirectory.
    stamp = uuid4().hex
    video = output.parent / f".ccm-bili-{stamp}-video.m4s"
    audio = output.parent / f".ccm-bili-{stamp}-audio.m4s"
    merged = output.parent / f".ccm-bili-{stamp}-merged.mp4"
    try:
        for url, destination in ((video_url, video), (audio_url, audio)):
            run(curl, "--silent", "--show-error", "--fail", "--location",
                "--retry", "3", "--retry-delay", "1", "--connect-timeout", "15",
                "--max-time", str(args.timeout), "--user-agent", user_agent,
                "--referer", referer, "--output", str(destination), url,
                timeout=args.timeout + 40)
        run(ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(video), "-i", str(audio), "-map", "0:v:0", "-map", "1:a:0",
            "-c", "copy", str(merged), timeout=120)
        info = json.loads(run(ffprobe, "-v", "error", "-show_entries",
                              "stream=codec_type,codec_name,width,height", "-show_entries",
                              "format=duration,size", "-of", "json", str(merged), timeout=30))
        stream = next((x for x in info.get("streams", []) if x.get("codec_type") == "video"), None)
        if stream is None or stream.get("height", 0) < expected_height:
            raise RuntimeError("Downloaded video failed the requested resolution check")
        if not any(x.get("codec_type") == "audio" for x in info.get("streams", [])):
            raise RuntimeError("Downloaded video has no audio track")
        merged.replace(output)
    finally:
        for path in (video, audio, merged):
            path.unlink(missing_ok=True)
    print(json.dumps({"ok": True, "output_path": str(output),
                      "byte_length": output.stat().st_size,
                      "expected_height": expected_height,
                      "actual_height": stream["height"],
                      "probe": info}, ensure_ascii=False))


if __name__ == "__main__":
    main()
