#!/usr/bin/env python3
"""
PreToolUse hook (Edit, Write, MultiEdit and NotebookEdit) that warns a session
when it edits one of your skill files or instruction files without having
loaded the instruction-manager skill first.

A skill file is any file inside a skill folder the config covers
(~/.claude/instruction-manager.json, read by skill/scripts/im_config.py):
every folder its skill_folders patterns match that holds a SKILL.md, compared
by real path so edits through links count too, and, when project_skills is on,
each project's .claude/skills/<name>/. With no config file that's
~/.claude/skills/* and project skills. Plugin skills aren't watched.

An instruction file is any CLAUDE.md or CLAUDE.local.md: your global
instructions (the config's global_instructions, and ~/.claude/CLAUDE.md) and
every project's. READMEs aren't watched: most README edits are ordinary
documentation, and a warning on each would be noise.

The edit always goes through. When the session's transcript has no Skill call
that loaded instruction-manager (or an /instruction-manager command), the hook
adds a message to the session telling it to load instruction-manager before
any further edit to that file. Otherwise it prints nothing. A broken config
never stops an edit either: the hook then watches only CLAUDE.md files.

Edits made through Bash or PowerShell (sed, heredocs) aren't seen.
install.py adds it to ~/.claude/settings.json.
"""
import json
import os
import sys
from pathlib import Path

sys.dont_write_bytecode = True  # runs on every edit: leave no __pycache__ in the skill folder
sys.path.insert(0, str(Path(__file__).resolve().parent / "skill" / "scripts"))
try:
    import im_config
except ImportError:  # the skill folder is missing: fall back to CLAUDE.md files only
    im_config = None

SKILL_NAME = "instruction-manager"
INSTRUCTION_FILES = {"claude.md", "claude.local.md"}
CLAUDE_DIR = Path.home() / ".claude"


def real(path):
    return Path(os.path.normcase(os.path.realpath(path)))


def skill_of(file_path):
    """The skill's name if file_path is inside one of your skill folders, else None."""
    if im_config is None:
        return None
    try:
        cfg = im_config.load()
        p = real(file_path)
    except (im_config.ConfigError, OSError, ValueError):
        return None
    if cfg["project_skills"]:
        parts = p.parts
        for i in range(len(parts) - 3):
            if (parts[i] == ".claude" and parts[i + 1] == "skills"
                    and Path(*parts[:i + 1]) != real(CLAUDE_DIR)):
                return parts[i + 2]
    for folder in im_config.skill_folders(cwd=p.parent if p.parent.is_dir() else None):
        try:
            p.relative_to(real(folder))
        except ValueError:
            continue
        return im_config.skill_name_of(folder)
    return None


def global_files():
    if im_config is not None:
        try:
            return im_config.global_files()
        except im_config.ConfigError:
            pass
    return [real(CLAUDE_DIR / "CLAUDE.md")]


def target_of(file_path):
    """How the warning names what's being edited, or None when the file isn't watched."""
    skill = skill_of(file_path)
    if skill:
        return f"the user's '{skill}' skill"
    if Path(file_path).name.lower() in INSTRUCTION_FILES:
        try:
            p = real(file_path)
        except (OSError, ValueError):
            return None
        if p in global_files():
            return "the user's global instructions"
        return f"the project instructions in {file_path}"
    return None


def loaded_instruction_manager(transcript_path):
    try:
        with open(transcript_path, encoding="utf-8", errors="replace") as f:
            for line in f:
                if SKILL_NAME not in line:
                    continue
                if f"<command-name>/{SKILL_NAME}</command-name>" in line:
                    return True
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                content = (entry.get("message") or {}).get("content")
                if not isinstance(content, list):
                    continue
                for block in content:
                    if (isinstance(block, dict) and block.get("type") == "tool_use"
                            and block.get("name") == "Skill"
                            and str((block.get("input") or {}).get("skill", "")).split(":")[-1]
                            == SKILL_NAME):
                        return True
    except OSError:
        return True  # no transcript to check: stay silent rather than nag
    return False


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return
    tool_input = data.get("tool_input") or {}
    file_path = tool_input.get("file_path") or tool_input.get("notebook_path")
    if not file_path:
        return
    target = target_of(file_path)
    if not target or loaded_instruction_manager(data.get("transcript_path") or ""):
        return
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "additionalContext": (
            f"This edit changes {target}, and this session hasn't loaded the {SKILL_NAME} "
            f"skill. Load it before creating, changing or auditing any of the user's skills "
            f"or instruction files, even for a one-line edit. Load it now with the Skill "
            f"tool, before any further edit to this file, and check this edit against its "
            f"workflow."),
    }}))


if __name__ == "__main__":
    main()
