#!/usr/bin/env python3
"""Worker-local read-only Codex history and persistent public share snapshots."""
import base64
import hashlib
import json
import os
import re
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse, urlunparse

import share

ROOT = Path(__file__).resolve().parents[2]
STORE = ROOT / ".state" / "conversations"
EXPORTS = ROOT / ".cache" / "conversation"
UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")
SHARE_ID = re.compile(r"^share:([A-Za-z0-9_.-]{1,128}):([a-f0-9]{64})$")
LOCAL_ID = re.compile(r"^codex:([A-Za-z0-9_.-]{1,128}):([0-9a-fA-F-]{36})$")
ACTIONS = ("import", "thread/read", "thread/turns/list", "thread/items/list", "export")


def check(value, message):
    if not value:
        raise ValueError(message)


def configuration():
    p = ROOT / "ccm.config.json"
    return json.loads(p.read_text(encoding="utf-8-sig")) if p.exists() else {}


def codex_home():
    home = (configuration().get("codex") or {}).get("home") or os.environ.get("CODEX_HOME") or str(Path.home() / ".codex")
    check(isinstance(home, str) and Path(home).is_absolute(), "codex.home must be absolute")
    return Path(home).resolve()


def canonical_url(url):
    kind = share.share_source(url)
    u = urlparse(url)
    return kind, urlunparse(("https", "chatgpt.com", u.path.rstrip("/"), "", "", ""))


def store_path(digest):
    check(re.fullmatch(r"[0-9a-f]{64}", digest), "Invalid conversation ID")
    return STORE / (digest + ".json")


def save_atomic(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=".pending-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(obj, stream, ensure_ascii=False, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def import_share(args, env):
    branch = args.get("branch", "active")
    check(branch in ("active", "all"), "Invalid branch")
    kind, url = canonical_url(args["share_url"])
    payload = share.fetch(url)
    if kind == "codex":
        original = json.loads(payload)
        records = share.codex_records(original)
        active = [r["id"] for r in records]
        title = original.get("title") or "Codex shared conversation"
        raw = {"snapshot": original}
    else:
        original = share.extract_payload(payload)
        nodes = share.unpack(original)
        meta = share.conversation_meta(original)
        records = [share.message_record(key, value) for key, value in nodes.items()]
        records = [r for r in records if r]
        active = share.active_branch(nodes, meta.get("current_node"))
        title = meta.get("title") or meta.get("og_title") or share.title_from_html(payload)
        raw = {"indexed_payload": original, "metadata": meta}
    digest = hashlib.sha256((env + "\n" + branch + "\n" + url).encode()).hexdigest()
    doc = {"schema_version": 1, "source_type": kind, "source_url": url,
           "environment_id": env, "branch": branch, "title": title,
           "revision": str(uuid.uuid4()), "imported_at": datetime.now(timezone.utc).isoformat(),
           "records": records, "active_ids": active, "raw": raw}
    save_atomic(store_path(digest), doc)
    present_ids = {record["id"] for record in records}
    return {"conversation_id": f"share:{env}:{digest}", "source_type": kind,
            "revision": doc["revision"], "title": title, "total_items": len(records),
            "active_items": sum(item in present_ids for item in active),
            "imported_at": doc["imported_at"]}


def find_local(thread_id):
    check(isinstance(thread_id, str) and UUID.fullmatch(thread_id), "thread_id must be a valid UUID")
    matches = []
    for base in (codex_home() / "sessions", codex_home() / "archived_sessions"):
        if not base.is_dir():
            continue
        for path in base.rglob("*.jsonl"):
            if path.name.lower().endswith(thread_id.lower() + ".jsonl"):
                resolved = path.resolve()
                check(resolved.is_relative_to(base.resolve()), "Codex session path escapes its home")
                matches.append(resolved)
    check(len(matches) == 1, "Codex thread not found" if not matches else "Duplicate Codex thread UUID")
    return matches[0]


def local_text(payload):
    kind = payload.get("type")
    if kind == "message":
        result = []
        for part in payload.get("content") or []:
            if isinstance(part, dict):
                if isinstance(part.get("text"), str):
                    result.append(part["text"])
                elif part.get("type") in ("input_image", "image"):
                    result.append("[image]")
        return "\n".join(result)
    if kind == "custom_tool_call":
        return str(payload.get("name") or "") + " " + str(payload.get("input") or "")
    if kind in ("custom_tool_call_output", "function_call_output"):
        return str(payload.get("output") or "")
    if kind == "reasoning":
        return "\n".join(str(p.get("text") or "") for p in payload.get("summary") or [] if isinstance(p, dict))
    return ""


def local_history(thread_id):
    path = find_local(thread_id)
    stat = path.stat()
    records, turn, turns, metadata = [], None, [], {}
    with path.open("rb") as stream:
        fingerprint = hashlib.sha256(stream.read(min(stat.st_size, 65536))).hexdigest()
        stream.seek(0)
        for num, line in enumerate(stream, 1):
            if not line.endswith(b"\n"):
                break
            row = json.loads(line)
            payload = row.get("payload") or {}
            if row.get("type") == "session_meta":
                metadata = {k: payload.get(k) for k in ("id", "timestamp", "cwd", "cli_version", "source", "model_provider")}
            if row.get("type") == "event_msg" and payload.get("type") == "task_started":
                turn = str(payload.get("turn_id") or f"turn-{len(turns)}")
                turns.append(turn)
            kind = row.get("type")
            text = local_text(payload) if kind == "response_item" else ""
            role = payload.get("role") if kind == "response_item" and payload.get("type") == "message" else "tool"
            records.append({"id": str(payload.get("id") or f"line-{num}"),
                            "role": role or "tool",
                            "type": payload.get("type") or kind, "source_type": kind,
                            "channel": payload.get("phase"),
                            "turn_id": turn, "create_time": row.get("timestamp"),
                            "line": num, "text": text, "visible_text": text, "content": payload,
                            "raw": row})
    return {"source_type": "codex-local", "title": "Codex " + thread_id,
            "records": records, "meta": metadata, "turn_ids": turns,
            "revision": fingerprint + ":" + str(stat.st_dev) + ":" + str(stat.st_ino),
            "thread_id": thread_id, "source_path": str(path), "file_bytes": stat.st_size,
            "last_modified_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()}


def load(args, env):
    ref = args.get("conversation_id") or args.get("thread_id")
    check(isinstance(ref, str), "conversation_id or thread_id is required")
    if UUID.fullmatch(ref):
        ref = f"codex:{env}:{ref.lower()}"
    match = SHARE_ID.fullmatch(ref)
    if match:
        check(match[1] == env, "Shared conversation belongs to another environment")
        path = store_path(match[2])
        check(path.is_file(), "Shared conversation has not been imported on this Worker")
        doc = json.loads(path.read_text(encoding="utf-8"))
        check(doc.get("schema_version") == 1 and doc.get("environment_id") == env, "Invalid conversation snapshot")
    else:
        match = LOCAL_ID.fullmatch(ref)
        check(match is not None, "Invalid conversation ID")
        check(match[1] == env, "Codex conversation belongs to another environment")
        doc = local_history(match[2])
    doc["conversation_id"] = ref
    doc["environment_id"] = env
    return doc


def records_of(doc):
    if doc["source_type"] != "chatgpt":
        return doc["records"]
    mapping = {record["id"]: record for record in doc["records"]}
    return [mapping[key] for key in doc["active_ids"] if key in mapping]


def turns_of(doc):
    groups, current = [], None
    for rec in records_of(doc):
        if (current is None and rec.get("turn_id") is None and
                rec.get("role") not in ("user", "assistant")):
            continue
        tid = rec.get("turn_id")
        if tid is None and rec.get("turn_index") is not None:
            tid = f"turn-{rec['turn_index']}"
        if tid is None and rec.get("role") == "user":
            tid = f"turn-{len(groups)}"
        if tid is None:
            tid = current["id"] if current else "turn-0"
        if current is None or tid != current["id"]:
            current = {"id": tid, "items": [], "first_message_at": rec.get("create_time")}
            groups.append(current)
        current["items"].append(rec)
    return groups


def text_item(rec, mode="text", size=2800):
    result = {key: rec[key] for key in ("id", "role", "type", "channel", "turn_id", "create_time", "parent", "children") if rec.get(key) is not None}
    body = str(rec.get("visible_text") or rec.get("text") or "")
    result["text"] = body[:size]
    if len(body) > size:
        result["truncated"] = True
        result["full_content_in_export"] = True
    if mode == "full":
        raw = json.dumps(rec, ensure_ascii=False, default=str)
        result["record"] = rec if len(raw) <= size else raw[:size]
        if len(raw) > size:
            result["record_truncated"] = True
            result["full_content_in_export"] = True
    return result


def cursor_read(value, revision, action, direction):
    if not value:
        return 0
    try:
        cursor = json.loads(base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)))
    except (ValueError, UnicodeError) as e:
        raise ValueError("Invalid pagination cursor") from e
    check(cursor.get("rev") == revision and cursor.get("action") == action and
          cursor.get("direction") == direction and type(cursor.get("pos")) is int and cursor["pos"] >= 0,
          "Stale or invalid pagination cursor")
    return cursor["pos"]


def cursor_next(revision, action, direction, pos):
    value = {"rev": revision, "action": action, "direction": direction, "pos": pos}
    return base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode()).decode().rstrip("=")


def page(doc, args, action):
    limit = args.get("limit", 20)
    check(type(limit) is int and 1 <= limit <= 50, "limit must be 1..50")
    direction = args.get("sort_direction", "asc")
    mode = args.get("mode", "text")
    check(direction in ("asc", "desc") and mode in ("text", "full"), "Invalid pagination options")
    if action == "thread/turns/list":
        items = [{"id": group["id"], "item_count": len(group["items"]),
                  "first_message_at": group["first_message_at"],
                  "messages": [text_item(rec, size=800) for rec in group["items"] if rec.get("role") in ("user", "assistant") and rec.get("text")][:3],
                  "messages_truncated": sum(1 for rec in group["items"] if rec.get("role") in ("user", "assistant") and rec.get("text")) > 3}
                 for group in turns_of(doc)]
    else:
        records = doc["records"] if mode == "full" and doc.get("branch") == "all" else records_of(doc)
        if args.get("turn_id"):
            group = next((g for g in turns_of(doc) if g["id"] == args["turn_id"]), None)
            check(group is not None, "Unknown turn_id")
            records = group["items"]
        if mode == "text":
            records = [r for r in records if r.get("role") in ("user", "assistant") and r.get("type") != "reasoning" and (r.get("visible_text") or r.get("text"))]
        items = [text_item(r, mode) for r in records]
    if direction == "desc":
        items.reverse()
    page_kind = action + ":" + mode + ":" + str(args.get("turn_id") or "")
    offset = cursor_read(args.get("cursor"), doc["revision"], page_kind, direction)
    subset = items[offset:offset + limit]
    nxt = offset + len(subset)
    return {"conversation_id": doc["conversation_id"], "revision": doc["revision"],
            "items": subset, "total": len(items), "returned": len(subset),
            "next_cursor": cursor_next(doc["revision"], page_kind, direction, nxt) if nxt < len(items) else None}


def metadata(doc):
    return {"conversation_id": doc["conversation_id"], "source_type": doc["source_type"],
            "environment_id": doc["environment_id"], "title": doc["title"],
            "revision": doc["revision"], "turn_count": len(turns_of(doc)),
            "item_count": len(doc["records"]), "source_url": doc.get("source_url"),
            "imported_at": doc.get("imported_at"), "thread_metadata": doc.get("meta"),
            "branch": doc.get("branch"), "file_bytes": doc.get("file_bytes"),
            "last_modified_at": doc.get("last_modified_at"),
            "source_completeness": "local-log" if doc["source_type"] == "codex-local" else "public-share-snapshot"}


def export(doc, args):
    mode = args.get("mode", "text")
    fmt = args.get("format", "md")
    check(mode in ("text", "full") and fmt in ("md", "json"), "Unsupported export mode or format")
    name = args.get("output_path") or (hashlib.sha256(doc["conversation_id"].encode()).hexdigest()[:24] + "." + mode + "." + fmt)
    target = Path(name)
    check(not target.is_absolute() and ".." not in target.parts and target.suffix == "." + fmt,
          "output_path must be a relative cache filename with matching extension")
    out = (EXPORTS / target).resolve()
    check(out.is_relative_to(EXPORTS.resolve()), "Invalid export path")
    out.parent.mkdir(parents=True, exist_ok=True)
    records = (doc["records"] if mode == "full" and doc.get("branch") == "all"
               else records_of(doc))
    if mode == "text":
        records = [r for r in records if r.get("role") in ("user", "assistant") and r.get("type") != "reasoning"]
    if fmt == "json":
        data = {"metadata": metadata(doc), "messages": records}
        if mode == "full" and doc["source_type"] != "codex-local":
            data["source_data"] = doc["raw"]
        content = json.dumps(data, ensure_ascii=False, indent=2)
    else:
        lines = ["# " + doc["title"], ""]
        for rec in records:
            lines.extend(["## " + (rec.get("role") or "item"), "", rec.get("visible_text") or rec.get("text") or "", ""])
            if mode == "full":
                lines.extend(["~~~json", json.dumps(rec, ensure_ascii=False, indent=2), "~~~", ""])
        content = "\n".join(lines)
    out.write_text(content, encoding="utf-8")
    return {"output_path": str(out), "output_bytes": out.stat().st_size, "format": fmt, "mode": mode}


def execute(args):
    check(isinstance(args, dict) and args.get("action") in ACTIONS, "Invalid conversation action")
    env = args.get("environment_id")
    check(isinstance(env, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", env), "Invalid environment_id")
    if args["action"] == "import":
        return import_share(args, env)
    doc = load(args, env)
    if args["action"] == "thread/read":
        return metadata(doc)
    if args["action"] in ("thread/turns/list", "thread/items/list"):
        return page(doc, args, args["action"])
    return export(doc, args)


if __name__ == "__main__":
    try:
        print(json.dumps({"status": "ok", **execute(json.load(sys.stdin))}, ensure_ascii=False, separators=(",", ":")))
    except Exception as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False))
        sys.exit(1)
