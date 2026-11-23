#!/usr/bin/env python3
"""
Offline tests for check_skill.py's frontmatter checks: Claude Code's own keys
(such as disable-model-invocation) aren't reported as unexpected by
skill-creator's validator, and slash-only skills skip the description and
trigger-test checks. They start no Claude sessions and touch none of your real
files: the home folder is moved to a temporary folder before anything loads,
and a stand-in validator with skill-creator's allowed keys replaces the real one.
Run: python tests/test_check_skill.py
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

FAKE_HOME = tempfile.TemporaryDirectory(prefix="instruction-manager-test-")
HOME = Path(FAKE_HOME.name).resolve()
os.environ["HOME"] = os.environ["USERPROFILE"] = str(HOME)
os.environ.pop("INSTRUCTION_MANAGER_CONFIG", None)
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "skill" / "scripts"))
import check_skill  # noqa: E402

assert str(check_skill.HOME).startswith(str(HOME)), "the tests must never see the real home folder"

# Behaves like skill-creator's quick_validate.py for top-level keys, without needing PyYAML.
FAKE_VALIDATOR = '''import re, sys
from pathlib import Path
ALLOWED = {"name", "description", "license", "allowed-tools", "metadata", "compatibility"}
text = (Path(sys.argv[1]) / "SKILL.md").read_text()
fm = re.match(r"^---\\n(.*?)\\n---", text, re.S).group(1)
keys = set(re.findall(r"^([A-Za-z][\\w-]*):", fm, re.M))
bad = keys - ALLOWED
if bad:
    print("Unexpected key(s) in SKILL.md frontmatter: " + ", ".join(sorted(bad)))
    sys.exit(1)
print("Skill is valid!")
'''


def write(path, text=""):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


QV = str(write(HOME / "quick_validate.py", FAKE_VALIDATOR))


def skill(name, frontmatter, triggers=False):
    folder = HOME / "skills" / name
    write(folder / "SKILL.md", f"---\nname: {name}\n{frontmatter}\n---\n\n# {name}\n\nBody.\n")
    if triggers:
        write(folder / "evals" / "triggers.json", '[{"query": "q", "should_trigger": true}]')
    return folder


def report(folder):
    _, lines = check_skill.check_skill(folder, QV, None, True)
    return lines


def messages(lines, level):
    return [m for lv, m in lines if lv == level]


class ClaudeCodeKeys(unittest.TestCase):
    def test_slash_only_skill_has_no_errors(self):
        f = skill("repo-tool", 'description: "Syncs the repos."\ndisable-model-invocation: true\n'
                               'argument-hint: "[name]"\nmodel: sonnet\nuser-invocable: true')
        self.assertEqual(messages(report(f), "ERROR"), [])

    def test_nested_claude_code_key_is_removed_whole(self):
        f = skill("hooked", 'description: "x"\nhooks:\n  PreToolUse:\n    - matcher: Bash\n'
                            'license: MIT')
        self.assertEqual(messages(report(f), "ERROR"), [])

    def test_unknown_key_is_still_an_error(self):
        f = skill("typo", 'description: "Checks things."\ndisable-model-invokation: true')
        errors = messages(report(f), "ERROR")
        self.assertEqual(len(errors), 1)
        self.assertIn("disable-model-invokation", errors[0])

    def test_skill_without_claude_code_keys_is_validated_in_place(self):
        f = skill("plain", 'description: "Checks things."')
        self.assertIsNone(check_skill.without_claude_code_keys((f / "SKILL.md").read_text()))
        self.assertEqual(messages(report(f), "ERROR"), [])


class SlashOnly(unittest.TestCase):
    def test_no_trigger_or_description_warnings(self):
        f = skill("slash", 'description: "Short."\ndisable-model-invocation: true')
        warns = messages(report(f), "WARN")
        self.assertFalse([w for w in warns if "triggers.json" in w or "description" in w], warns)
        self.assertTrue([i for i in messages(report(f), "INFO") if "slash-only" in i])

    def test_leftover_triggers_are_flagged(self):
        f = skill("slash-old", 'description: "Short."\ndisable-model-invocation: "true"', triggers=True)
        self.assertTrue([w for w in messages(report(f), "WARN") if "never run" in w])

    def test_description_over_the_hard_limit_is_still_an_error(self):
        f = skill("slash-long", f'description: "{"x" * 1100}"\ndisable-model-invocation: true')
        self.assertTrue([e for e in messages(report(f), "ERROR") if "over the" in e])

    def test_false_keeps_the_usual_checks(self):
        f = skill("model-loaded", 'description: "Short."\ndisable-model-invocation: false')
        self.assertTrue([w for w in messages(report(f), "WARN") if "no evals/triggers.json" in w])

    def test_run_triggers_refuses_a_slash_only_skill(self):
        import run_triggers
        self.assertTrue(run_triggers.slash_only(
            skill("slash-rt", 'description: "x"\ndisable-model-invocation: true') / "SKILL.md"))
        self.assertFalse(run_triggers.slash_only(skill("normal-rt", 'description: "x"') / "SKILL.md"))


if __name__ == "__main__":
    unittest.main()
