"""Minimal CLI entry point for the installed faster_whisper library.

stdout: one UTF-8 JSON transcript; stderr: unmodified Python errors/tracebacks.
"""
import argparse
import json
import sys


def main():
    parser = argparse.ArgumentParser(description="Transcribe an existing local audio file with Faster Whisper")
    parser.add_argument("audio_path", help="Local audio/video file on the selected Worker")
    parser.add_argument("--model", default="large-v3-turbo")
    parser.add_argument("--language", default=None, help="Language code, e.g. zh, ja, en; autodetect by default")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--compute-type", default="default")
    parser.add_argument("--beam-size", type=int, default=5)
    args = parser.parse_args()

    from faster_whisper import WhisperModel

    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    segments, info = model.transcribe(
        args.audio_path, language=args.language, beam_size=args.beam_size
    )
    output = {
        "language": info.language,
        "language_probability": info.language_probability,
        "duration": info.duration,
        "segments": [
            {"start": s.start, "end": s.end, "text": s.text}
            for s in segments
        ],
    }
    json.dump(output, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
