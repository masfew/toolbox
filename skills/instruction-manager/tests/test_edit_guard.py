#!/usr/bin/env python3
"""
Offline tests for instruction-manager's edit guard and the import following
it shares with the check scripts. They start no Claude sessions and touch none
of your real files: the home folder itself is moved to a temporary folder
before anything loads, and the guard runs as the hook would, with that folder
as its home.
Run: python tests/test_edit_guard.py
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

# Before any of the tool's modules load, so every path they build is in here.
FAKE_HOME = tempfile.TemporaryDirectory(prefix="instruction-manager-test-")
HOME = Path(FAKE_HOME.name).resolve()
os.environ["HOME"] = os.environ["USERPROFILE"] = str(HOME)
os.environ.pop("INSTRUCTION_MANAGER_CONFIG", None)
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "skill" / "scripts"))
import im_config  # noqa: E402

assert str(im_config.CLAUDE_DIR).startswith(str(HOME)), "the tests must never see the real home folder"
CLAUDE = HOME / ".claude"
AT = im_config.AT  # an import line starts with it


def write(path, text=""):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def link_folder(link, target):
    """A folder link: a junction on Windows (no admin rights needed), a symlink elsewhere."""
    link.parent.mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)],
                       check=True, capture_output=True)
    else:
        link.symlink_to(target, target_is_directory=True)


def run_guard(file_path, transcript_lines=()):
    """The guard's warning for an edit to file_path, or "" when it stays silent."""
    transcript = HOME / "transcript.jsonl"
    transcript.write_text("".join(json.dumps(x) + "\n" for x in transcript_lines), encoding="utf-8")
    env = dict(os.environ, HOME=str(HOME), USERPROFILE=str(HOME))
    out = subprocess.run(
        [sys.executable, "-I", str(ROOT / "edit_guard.py")],
        input=json.dumps({"tool_name": "Edit", "tool_input": {"file_path": str(file_path)},
                          "transcript_path": str(transcript)}),
        capture_output=True, text=True, env=env, timeout=30)
    if not out.stdout.strip():
        return ""
    return json.loads(out.stdout)["hookSpecificOutput"]["additionalContext"]


def reset():
    """An empty ~/.claude and no cached config."""
    import shutil
    shutil.rmtree(CLAUDE, ignore_errors=True)
    shutil.rmtree(HOME / "rules", ignore_errors=True)
    CLAUDE.mkdir()
    im_config._cache = None


class Imports(unittest.TestCase):
    def setUp(self):
        reset()

    def test_home_relative_and_nested_imports(self):
        write(CLAUDE / "CLAUDE.md", f"Rules:\n{AT}~/rules/a.md\n{AT}sub/b.md\n")
        write(HOME / "rules" / "a.md", f"See {AT}c.md for more.")
        write(HOME / "rules" / "c.md", "Deepest.")
        write(CLAUDE / "sub" / "b.md", "B.")
        found = {p.name for p in im_config.imported_files()}
        self.assertEqual(found, {"a.md", "b.md", "c.md"})

    def test_imports_in_code_are_examples_not_imports(self):
        write(CLAUDE / "CLAUDE.md", f"Write `{AT}~/rules/a.md` to import.\n```\n{AT}~/rules/b.md\n```\n")
        write(HOME / "rules" / "a.md")
        write(HOME / "rules" / "b.md")
        self.assertEqual(im_config.imported_files(), [])

    def test_more_than_five_imports_in_one_file(self):
        names = [f"r{i}.md" for i in range(8)]
        write(CLAUDE / "CLAUDE.md", "".join(f"{AT}~/rules/{n}\n" for n in names))
        for n in names:
            write(HOME / "rules" / n)
        self.assertEqual(sorted(p.name for p in im_config.imported_files()), names)

    def test_depth_stops_after_four_hops(self):
        write(CLAUDE / "CLAUDE.md", f"{AT}~/rules/d1.md")
        for i in range(1, 8):
            write(HOME / "rules" / f"d{i}.md", f"{AT}d{i + 1}.md")
        found = sorted(p.name for p in im_config.imported_files())
        self.assertEqual(found, [f"d{i}.md" for i in range(1, 5)])

    def test_import_cycle_ends(self):
        write(CLAUDE / "CLAUDE.md", f"{AT}~/rules/a.md")
        write(HOME / "rules" / "a.md", f"{AT}b.md")
        write(HOME / "rules" / "b.md", f"{AT}a.md")
        self.assertEqual(sorted(p.name for p in im_config.imported_files()), ["a.md", "b.md"])

    def test_configured_global_instructions_are_followed_too(self):
        write(CLAUDE / "instruction-manager.json",
              json.dumps({"global_instructions": ["~/notes/global.md"]}))
        write(HOME / "notes" / "global.md", f"{AT}extra.md")
        write(HOME / "notes" / "extra.md")
        self.assertEqual([p.name for p in im_config.imported_files()], ["extra.md"])

    def test_missing_import_is_reported_not_followed(self):
        write(CLAUDE / "CLAUDE.md", f"{AT}~/rules/gone.md")
        self.assertEqual(im_config.imports_of(CLAUDE / "CLAUDE.md"), [("~/rules/gone.md", None)])
        self.assertEqual(im_config.imported_files(), [])


class Guard(unittest.TestCase):
    def setUp(self):
        reset()
        write(CLAUDE / "CLAUDE.md", f"{AT}~/.claude/tools/rules-tool/rules/ask.md\n")
        write(HOME / "repo" / "rules-tool" / "rules" / "ask.md", "Ask first.")
        write(HOME / "repo" / "rules-tool" / "README.md", "How to install.")
        link_folder(CLAUDE / "tools" / "rules-tool", HOME / "repo" / "rules-tool")

    def test_imported_file_warns_through_the_link(self):
        msg = run_guard(CLAUDE / "tools" / "rules-tool" / "rules" / "ask.md")
        self.assertIn("which the user's global instructions import", msg)
        self.assertIn("instruction-manager", msg)

    def test_imported_file_warns_at_its_real_path(self):
        self.assertIn("global instructions import",
                      run_guard(HOME / "repo" / "rules-tool" / "rules" / "ask.md"))

    def test_file_beside_it_that_isnt_imported_is_quiet(self):
        self.assertEqual(run_guard(HOME / "repo" / "rules-tool" / "README.md"), "")

    def test_global_claude_md_still_warns(self):
        self.assertIn("the user's global instructions", run_guard(CLAUDE / "CLAUDE.md"))

    def test_project_claude_md_still_warns(self):
        project = write(HOME / "proj" / "CLAUDE.md", "Project rules.")
        self.assertIn("the project instructions", run_guard(project))

    def test_quiet_once_the_skill_is_loaded(self):
        loaded = {"message": {"content": [{"type": "tool_use", "name": "Skill",
                                           "input": {"skill": "instruction-manager"}}]}}
        self.assertEqual(run_guard(HOME / "repo" / "rules-tool" / "rules" / "ask.md", [loaded]), "")

    def test_broken_config_still_watches_claude_md(self):
        write(CLAUDE / "instruction-manager.json", "{not json")
        self.assertEqual(run_guard(HOME / "repo" / "rules-tool" / "rules" / "ask.md"), "")
        self.assertIn("the user's global instructions", run_guard(CLAUDE / "CLAUDE.md"))


if __name__ == "__main__":
    unittest.main()
