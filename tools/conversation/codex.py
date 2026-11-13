#!/usr/bin/env python3
"""Codex shared snapshot and local session readers.

Both Codex sources retain their native items; neither routes through the
ChatGPT web Share parser. Local session access is read-only.
"""

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit


UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")


def thread_uuid(value):
    """Normalize a Codex UUID or the official codex://threads/<uuid> link."""
    if not isinstance(value, str):
        raise ValueError("Codex thread reference must be a UUID or codex://threads/<uuid>")
    if UUID.fullmatch(value):
        return value.lower()
    uri = urlsplit(value)
    if (uri.scheme == "codex" and uri.netloc == "threads"
            and not uri.query and not uri.fragment and not uri.username
            and not uri.password and uri.port is None
            and re.fullmatch(r"/[0-9a-fA-F-]{36}", uri.path)
            and UUID.fullmatch(uri.path[1:])):
        return uri.path[1:].lower()
    raise ValueError("Codex thread reference must be a UUID or codex://threads/<uuid>")


def share_records(snapshot):
    """Parse the Codex public share's versioned JSON turns and native items."""
    if not isinstance(snapshot, dict) or type(snapshot.get('version')) is not int or snapshot['version'] != 1 or not isinstance(snapshot.get('turns'), list):
        raise ValueError('不支持的 Codex 分享快照，需要 version=1 和 turns 数组')
    records = []
    for turn_index, turn in enumerate(snapshot['turns']):
        if not isinstance(turn, dict) or not isinstance(turn.get('items'), list):
            raise ValueError('Codex 分享快照的每个轮次必须包含 items 数组')
        for item_index, item in enumerate(turn['items']):
            if not isinstance(item, dict) or not isinstance(item.get('type'), str):
                raise ValueError('Codex 分享快照包含无效消息项')
            kind = item['type']
            role, channel = 'tool', None
            if kind == 'userMessage':
                role = 'user'
                content = item.get('content')
                if not isinstance(content, list) or any(not isinstance(p, dict) for p in content):
                    raise ValueError('Codex 用户消息的 content 必须是对象数组')
                text = '\n'.join(p.get('text', '') for p in content if p.get('type') == 'text')
                visible = '\n'.join(
                    p.get('text', '') if p.get('type') == 'text' else
                    '[图片：' + str(p.get('url', '不可用')) + ']' if p.get('type') == 'image' else '[附件]'
                    for p in content)
            elif kind == 'agentMessage':
                role, text = 'assistant', item.get('text', '')
                visible = text
                channel = 'final' if item.get('phase') == 'final_answer' else item.get('phase')
            elif kind == 'reasoning':
                role, channel = 'assistant', 'analysis'
                text = item.get('summary', '')
                visible = text
            elif kind == 'fileChange':
                text = '\n\n'.join(str(change.get('path', '文件修改')) + '\n' + str(change.get('diff', ''))
                                    for change in item.get('changes', []))
                visible = text or '[文件修改]'
            elif kind in ('imageView', 'imageGeneration'):
                text, visible = '', '[图片：' + str(item.get('url', item.get('result', '不可用'))) + ']'
            else:
                text, visible = '', '[未识别 Codex 消息项：' + kind + ']'
            if not isinstance(text, str) or not isinstance(visible, str):
                raise ValueError('Codex 分享快照中的消息文本必须是字符串')
            records.append({
                'id': f'turn-{turn_index}-item-{item_index}', 'role': role, 'channel': channel,
                'create_time': None, 'text': text, 'visible_text': visible,
                'type': kind, 'turn_index': turn_index, 'item_index': item_index,
                'duration_ms': turn.get('durationMs'), 'content': item,
            })
    return records


def find_local(thread_id, home):
    thread_id = thread_uuid(thread_id)
    matches = []
    for base in (home / 'sessions', home / 'archived_sessions'):
        if not base.is_dir():
            continue
        for path in base.rglob('*.jsonl'):
            if path.name.lower().endswith(thread_id + '.jsonl'):
                resolved = path.resolve()
                if not resolved.is_relative_to(base.resolve()):
                    raise ValueError('Codex session path escapes its home')
                matches.append(resolved)
    if len(matches) != 1:
        raise ValueError('Codex thread not found' if not matches else 'Duplicate Codex thread UUID')
    return matches[0]


def local_text(payload):
    kind = payload.get('type')
    if kind == 'message':
        result = []
        for part in payload.get('content') or []:
            if isinstance(part, dict):
                if isinstance(part.get('text'), str):
                    result.append(part['text'])
                elif part.get('type') in ('input_image', 'image'):
                    result.append('[image]')
        return '\n'.join(result)
    if kind == 'custom_tool_call':
        return str(payload.get('name') or '') + ' ' + str(payload.get('input') or '')
    if kind in ('custom_tool_call_output', 'function_call_output'):
        return str(payload.get('output') or '')
    if kind == 'reasoning':
        return '\n'.join(str(p.get('text') or '') for p in payload.get('summary') or [] if isinstance(p, dict))
    return ''


def local_history(thread_id, home):
    thread_id = thread_uuid(thread_id)
    path = find_local(thread_id, home)
    stat = path.stat()
    records, turn, turns, metadata = [], None, [], {}
    with path.open('rb') as stream:
        fingerprint = hashlib.sha256(stream.read(min(stat.st_size, 65536))).hexdigest()
        stream.seek(0)
        for num, line in enumerate(stream, 1):
            if not line.endswith(b'\n'):
                break
            row = json.loads(line)
            payload = row.get('payload') or {}
            if row.get('type') == 'session_meta':
                metadata = {k: payload.get(k) for k in ('id', 'timestamp', 'cwd', 'cli_version', 'source', 'model_provider')}
            if row.get('type') == 'event_msg' and payload.get('type') == 'task_started':
                turn = str(payload.get('turn_id') or f'turn-{len(turns)}')
                turns.append(turn)
            kind = row.get('type')
            text = local_text(payload) if kind == 'response_item' else ''
            role = payload.get('role') if kind == 'response_item' and payload.get('type') == 'message' else 'tool'
            records.append({
                'id': str(payload.get('id') or f'line-{num}'),
                'role': role or 'tool', 'type': payload.get('type') or kind, 'source_type': kind,
                'channel': payload.get('phase'), 'turn_id': turn,
                'create_time': row.get('timestamp'), 'line': num,
                'text': text, 'visible_text': text, 'content': payload, 'raw': row,
            })
    return {
        'source_type': 'codex-local', 'title': 'Codex ' + thread_id,
        'records': records, 'meta': metadata, 'turn_ids': turns,
        'revision': fingerprint + ':' + str(stat.st_dev) + ':' + str(stat.st_ino),
        'thread_id': thread_id, 'source_path': str(path), 'file_bytes': stat.st_size,
        'last_modified_at': datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
    }
