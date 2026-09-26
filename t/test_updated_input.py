"""Pins the semantics of PreToolUse hookSpecificOutput.updatedInput (k7).

Recorded 2026-09-26 with Claude Code 2.1.283 in one isolated
`claude --plugin-dir` session (see t/fixtures/README.md). For each probe:

  <probe>.pre.json       PreToolUse payload the hook received
  <probe>.hook-out.json  what the temporary recorder hook printed
  <probe>.post.json      PostToolUse payload of the same tool_use_id

The model sent `description` and `timeout`; `updatedInput` left them out.
PostToolUse shows the tool_input that actually ran: exactly `updatedInput`,
the omitted fields gone — updatedInput REPLACES tool_input, it is no merge.
"""

import json
import os
import unittest

DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "fixtures", "updated-input")


def load(name):
    with open(os.path.join(DIR, name), encoding="utf-8") as f:
        return json.load(f)


class UpdatedInputReplaces(unittest.TestCase):
    def probe(self, name):
        pre = load(name + ".pre.json")
        out = load(name + ".hook-out.json")["hookSpecificOutput"]
        post = load(name + ".post.json")
        self.assertEqual(pre["tool_use_id"], post["tool_use_id"])
        self.assertEqual(post["hook_event_name"], "PostToolUse")
        return pre, out, post

    def assert_replaced(self, pre, out, post):
        # The model passed fields that updatedInput deliberately omits …
        for key in ("description", "timeout"):
            self.assertIn(key, pre["tool_input"])
            self.assertNotIn(key, out["updatedInput"])
        # … and what ran is updatedInput verbatim: the omitted fields are lost.
        self.assertEqual(post["tool_input"], out["updatedInput"])
        # The rewritten command really executed.
        marker = out["updatedInput"]["command"].split()[-1]
        self.assertEqual(post["tool_response"]["stdout"], marker)

    def test_without_permission_decision(self):
        pre, out, post = self.probe("probe-a")
        self.assertNotIn("permissionDecision", out)
        self.assertEqual(pre["tool_input"]["command"], "echo LOADGUARD_PROBE_A")
        self.assertEqual(post["tool_input"]["command"], "echo LOADGUARD_PROBE_B")
        self.assert_replaced(pre, out, post)

    def test_with_permission_decision_allow(self):
        pre, out, post = self.probe("probe-c")
        self.assertEqual(out["permissionDecision"], "allow")
        self.assertEqual(post["tool_input"]["command"], "echo LOADGUARD_PROBE_D")
        self.assert_replaced(pre, out, post)


if __name__ == "__main__":
    unittest.main()
