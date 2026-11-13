import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import conversation as c


class ConversationTests(unittest.TestCase):
    def test_public_share_tool_records_report_redaction_not_original_output(self):
        def node(role, text, name=None):
            return {'parent': None, 'children': [], 'message': {
                'author': {'role': role, 'name': name},
                'content': {'content_type': 'text', 'parts': [text]}}}
        nodes = {
            'u': node('user', 'Check the result'),
            'c': node('assistant', '', None),
            'tool': node('tool', 'The output of this plugin was redacted.', 'functions.exec'),
            'final': node('assistant', 'Task finished'),
        }
        with (patch.object(c.share, 'fetch', return_value='<html>fixture</html>'),
              patch.object(c.share, 'extract_payload', return_value=['mapping', {}]),
              patch.object(c.share, 'unpack', return_value=nodes),
              patch.object(c.share, 'conversation_meta', return_value={
                  'current_node': 'final', 'title': 'Redacted public share'})):
            imported = c.execute({'action': 'import',
                                  'share_url': 'https://chatgpt.com/share/redacted-test',
                                  'environment_id': '6v', 'branch': 'all'})
        self.assertEqual(imported['public_tool_record_count'], 1)
        self.assertEqual(imported['redacted_tool_result_count'], 1)
        ref = imported['conversation_id']
        read = c.execute({'action': 'thread/read', 'conversation_id': ref,
                          'environment_id': '6v'})
        self.assertEqual(read['redacted_tool_result_count'], 1)
        items = c.execute({'action': 'thread/items/list', 'conversation_id': ref,
                           'environment_id': '6v', 'mode': 'full'})
        self.assertEqual(items['redacted_tool_result_count'], 1)
        exported = c.execute({'action': 'export', 'conversation_id': ref,
                              'environment_id': '6v', 'mode': 'full', 'format': 'json'})
        data = json.loads(Path(exported['output_path']).read_text(encoding='utf-8'))
        self.assertEqual(data['metadata']['redacted_tool_result_count'], 1)
        self.assertEqual(next(r['text'] for r in data['messages'] if r['role'] == 'tool'),
                         'The output of this plugin was redacted.')

    def test_rendered_work_share_offline_read_list_and_export_are_scoped(self):
        html = '''<html><head><title>Work test - ChatGPT</title></head><body>
        <li data-message-role="user" id="user-1"><p>Read my file</p></li>
        <li data-message-role="assistant" id="assistant-1"><p>Completed &amp; checked</p></li>
        <li data-message-role="assistant" data-conversation-recovery="">Retry</li>
        <script>const sensitive = "should not persist";</script></body></html>'''
        with patch.object(c.share, "fetch", return_value=html):
            imported = c.execute({"action": "import", "share_url": "https://chatgpt.com/share/work-test",
                                  "environment_id": "6v", "branch": "all"})
        ref = imported["conversation_id"]
        self.assertEqual(imported["source_type"], "chatgpt-rendered")
        self.assertEqual(imported["total_items"], 2)
        self.assertEqual(imported["source_completeness"], "rendered-messages-only")
        with patch.object(c.share, "fetch", side_effect=RuntimeError("Offline read refetched")):
            info = c.execute({"action": "thread/read", "conversation_id": ref, "environment_id": "6v"})
            self.assertEqual(info["turn_count"], 1)
            self.assertFalse(info["upstream_tool_calls_available"])
            self.assertFalse(info["alternative_branches_available"])
            items = c.execute({"action": "thread/items/list", "conversation_id": ref,
                               "environment_id": "6v", "mode": "full"})
            self.assertEqual(items["total"], 2)
            self.assertEqual(items["source_completeness"], "rendered-messages-only")
            turns = c.execute({"action": "thread/turns/list", "conversation_id": ref,
                               "environment_id": "6v"})
            self.assertEqual(turns["items"][0]["item_count"], 2)
            exported = c.execute({"action": "export", "conversation_id": ref,
                                  "environment_id": "6v", "mode": "full", "format": "json"})
            data = json.loads(Path(exported["output_path"]).read_text(encoding="utf-8"))
            self.assertEqual(len(data["messages"]), 2)
            self.assertEqual(data["source_data"]["format"], "rendered-messages")
            self.assertNotIn("should not persist", json.dumps(data))
            markdown = c.execute({"action": "export", "conversation_id": ref,
                                  "environment_id": "6v", "format": "md"})
            md = Path(markdown["output_path"]).read_text(encoding="utf-8")
            self.assertIn("rendered ChatGPT Work/Share messages only", md)
            self.assertIn("Completed & checked", md)
    def setUp(self):
        # Stable ignored fixture root avoids restricted Windows temp-directory ACLs.
        self.root = Path(__file__).resolve().parents[2] / ".cache" / "conversation-tests"
        self.root.mkdir(parents=True, exist_ok=True)
        original = (c.ROOT, c.STORE, c.EXPORTS)
        self.addCleanup(lambda: setattr(c, "ROOT", original[0]))
        self.addCleanup(lambda: setattr(c, "STORE", original[1]))
        self.addCleanup(lambda: setattr(c, "EXPORTS", original[2]))
        c.ROOT = self.root
        c.STORE = self.root / ".state" / "conversations"
        c.EXPORTS = self.root / ".cache" / "conversation"

    def codex_url(self):
        return "https://chatgpt.com/s/cx_" + "a" * 32

    def snapshot(self, extra=None):
        items = [
            {"type": "userMessage", "content": [{"type": "text", "text": "Hello"}]},
            {"type": "agentMessage", "text": "Working", "phase": "commentary"},
            {"type": "reasoning", "summary": "Visible summary"},
            {"type": "agentMessage", "text": "Done", "phase": "final_answer"},
        ]
        if extra is not None:
            items.append(extra)
        return {"version": 1, "title": "Test Codex share", "turns": [{"items": items}]}

    def test_import_pagination_offline_read_export_and_refresh(self):
        with patch.object(c.share, "fetch", return_value=json.dumps(self.snapshot())):
            imported = c.execute({"action": "import", "share_url": self.codex_url(),
                                  "environment_id": "6v"})
        ref = imported["conversation_id"]
        self.assertEqual(imported["total_items"], 4)
        self.assertEqual(c.execute({"action": "thread/read", "conversation_id": ref,
                                    "environment_id": "6v"})["turn_count"], 1)
        first = c.execute({"action": "thread/items/list", "conversation_id": ref,
                           "environment_id": "6v", "limit": 2, "mode": "full"})
        self.assertEqual(first["returned"], 2)
        self.assertIsNotNone(first["next_cursor"])
        second = c.execute({"action": "thread/items/list", "conversation_id": ref,
                            "environment_id": "6v", "limit": 2, "mode": "full",
                            "cursor": first["next_cursor"]})
        self.assertEqual(first["items"][0]["id"], "turn-0-item-0")
        self.assertEqual(second["items"][0]["id"], "turn-0-item-2")
        self.assertIsNone(second["next_cursor"])
        visible = c.execute({"action": "thread/items/list", "conversation_id": ref,
                             "environment_id": "6v"})
        self.assertEqual(visible["total"], 3)
        output = c.execute({"action": "export", "conversation_id": ref, "environment_id": "6v",
                            "format": "json", "mode": "full"})
        saved = json.loads(Path(output["output_path"]).read_text(encoding="utf-8"))
        self.assertEqual(saved["source_data"]["snapshot"], self.snapshot())
        with patch.object(c.share, "fetch", side_effect=RuntimeError("Should not refetch")):
            self.assertEqual(c.execute({"action": "thread/read", "conversation_id": ref,
                                        "environment_id": "6v"})["item_count"], 4)
        with patch.object(c.share, "fetch", side_effect=RuntimeError("Network failed")):
            with self.assertRaisesRegex(RuntimeError, "Network failed"):
                c.execute({"action": "import", "share_url": self.codex_url(), "environment_id": "6v"})
        self.assertEqual(c.execute({"action": "thread/read", "conversation_id": ref,
                                    "environment_id": "6v"})["revision"], imported["revision"])
        with patch.object(c.share, "fetch",
                          return_value=json.dumps(self.snapshot({"type": "fileChange", "changes": []}))):
            refreshed = c.execute({"action": "import", "share_url": self.codex_url(),
                                   "environment_id": "6v"})
        self.assertEqual(refreshed["conversation_id"], ref)
        self.assertNotEqual(refreshed["revision"], imported["revision"])
        with self.assertRaisesRegex(ValueError, "Stale"):
            c.execute({"action": "thread/items/list", "conversation_id": ref,
                       "environment_id": "6v", "cursor": first["next_cursor"],
                       "mode": "full"})

    def test_chatgpt_branches_preserved_but_turns_use_active_branch(self):
        def node(role, parent, children, text):
            return {"parent": parent, "children": children, "message": {
                "author": {"role": role}, "content": {"parts": [text]}}}
        nodes = {
            "u": node("user", None, ["a", "b"], "Question"),
            "a": node("assistant", "u", [], "Old answer"),
            "b": node("assistant", "u", [], "New answer"),
        }
        with (patch.object(c.share, "fetch", return_value="<html>fixture</html>"),
              patch.object(c.share, "extract_payload", return_value=["raw-data"]),
              patch.object(c.share, "unpack", return_value=nodes),
              patch.object(c.share, "conversation_meta",
                           return_value={"current_node": "b", "title": "Question"})):
            value = c.execute({"action": "import",
                               "share_url": "https://chatgpt.com/share/example?ogimg=plain",
                               "environment_id": "noha", "branch": "all"})
        ref = value["conversation_id"]
        self.assertEqual(value["total_items"], 3)
        turns = c.execute({"action": "thread/turns/list", "conversation_id": ref,
                           "environment_id": "noha"})
        self.assertEqual([message["text"] for turn in turns["items"]
                          for message in turn["messages"]], ["Question", "New answer"])
        all_items = c.execute({"action": "thread/items/list", "conversation_id": ref,
                               "environment_id": "noha", "mode": "full"})
        self.assertEqual(all_items["total"], 3)
        exported = c.execute({"action": "export", "conversation_id": ref, "environment_id": "noha",
                              "mode": "full", "format": "json"})
        doc = json.loads(Path(exported["output_path"]).read_text(encoding="utf-8"))
        self.assertEqual({r["id"] for r in doc["messages"]}, {"u", "a", "b"})
        with self.assertRaisesRegex(ValueError, "another environment"):
            c.execute({"action": "thread/read", "conversation_id": ref, "environment_id": "6v"})

    def test_local_codex_uuid_read_is_complete_and_never_mutates_source(self):
        thread_id = "01a1ad26-84a2-7b91-87bc-32b31a875889"
        home = self.root / "codex-home"
        folder = home / "sessions" / "2026" / "11" / "06"
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / ("rollout-2026-11-06T03-19-05-" + thread_id + ".jsonl")
        (self.root / "ccm.config.json").write_text(json.dumps({"codex": {"home": str(home)}}))
        rows = [
            {"type": "session_meta", "payload": {"id": thread_id, "cli_version": "test"}},
            {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "turn-a"}},
            {"type": "response_item", "payload": {"type": "message", "role": "user",
                                                    "content": [{"type": "input_text", "text": "Hi"}]}},
            {"type": "response_item", "payload": {"type": "custom_tool_call",
                                                    "name": "exec", "input": "{}"}},
            {"type": "response_item", "payload": {"type": "custom_tool_call_output",
                                                    "output": "Result"}},
            {"type": "event_msg", "payload": {"type": "task_complete", "turn_id": "turn-a"}},
        ]
        data = "".join(json.dumps(row) + "\n" for row in rows) + '{"incomplete":'
        path.write_text(data, encoding="utf-8")
        request = {"thread_id": thread_id, "environment_id": "6v"}
        value = c.execute({"action": "thread/read", **request})
        self.assertEqual(value["item_count"], 6)
        self.assertEqual(value["turn_count"], 1)
        self.assertEqual(value["conversation_id"], "codex:6v:" + thread_id)
        deep_link = "codex://threads/" + thread_id
        for reference in ({"thread_id": deep_link}, {"conversation_id": deep_link}):
            with self.subTest(reference=reference):
                linked = c.execute({"action": "thread/read",
                                    "environment_id": "6v", **reference})
                self.assertEqual(linked["conversation_id"], value["conversation_id"])
                self.assertEqual(linked["revision"], value["revision"])
                linked_items = c.execute({"action": "thread/items/list",
                                          "environment_id": "6v", **reference})
                self.assertEqual([item["text"] for item in linked_items["items"]], ["Hi"])
        self.assertEqual(c.execute({"action": "thread/read", "environment_id": "6v",
                                    "thread_id": deep_link.upper().replace("CODEX://THREADS/", "codex://threads/")})["item_count"], 6)
        text_items = c.execute({"action": "thread/items/list", **request})
        self.assertEqual([i["text"] for i in text_items["items"]], ["Hi"])
        full = c.execute({"action": "thread/items/list", "mode": "full", **request})
        self.assertEqual(full["total"], 6)
        full_export = c.execute({"action": "export", "mode": "full", "format": "json", **request})
        exported = json.loads(Path(full_export["output_path"]).read_text(encoding="utf-8"))
        self.assertEqual(exported["messages"][0]["raw"], rows[0])
        self.assertEqual(path.read_text(encoding="utf-8"), data)
        with self.assertRaises(ValueError):
            c.execute({"action": "thread/read", "environment_id": "6v",
                       "thread_id": "../" + thread_id})
        for bad_reference in (
            "codex://threads/new",
            "codex://threads/" + thread_id + "/",
            "codex://threads/" + thread_id + "?path=other",
            "codex://threads/" + thread_id + "#fragment",
            "codex://settings/" + thread_id,
            "codex://other/" + thread_id,
            "codex://threads/" + thread_id + "/../../other",
            "https://example.com/" + thread_id,
        ):
            with self.subTest(bad_reference=bad_reference), self.assertRaises(ValueError):
                c.execute({"action": "thread/read", "environment_id": "6v",
                           "thread_id": bad_reference})
        with self.assertRaisesRegex(ValueError, "not found"):
            c.execute({"action": "thread/read", "environment_id": "6v",
                       "thread_id": "00000000-0000-4000-8000-000000000001"})


if __name__ == "__main__":
    unittest.main()
