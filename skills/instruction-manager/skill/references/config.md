# Configuration

`~/.claude/instruction-manager.json` (or the file `INSTRUCTION_MANAGER_CONFIG` names) holds the user's setup. Every key is optional, and a missing file means the defaults. `check_skill.py --show-config` prints the config in effect; read that rather than the file, since the environment variable can point elsewhere.

| Key | What it does | Default |
|---|---|---|
| `skill_folders` | Glob patterns (`~`, `*` one level, `**` any depth) for the user's skills; a match needs a `SKILL.md`. Used by `--all`, the duplicate search and the edit guard | `["~/.claude/skills/*"]` |
| `project_skills` | Also treat each project's `.claude/skills/<name>/` as the user's skills | `true` |
| `global_instructions` | Files checked as global instructions (`~/.claude/CLAUDE.md` always counts; their `@import`s are followed, and the edit guard watches the imported files too) | `["~/.claude/CLAUDE.md"]` |
| `skill_prefixes` | Name prefixes (such as `web-`) that mark a backticked word in an instruction file as a skill name | `[]` |
| `new_skill_homes` | Where a new skill goes: `{"when": "what it's about", "path": "folder pattern with <name>"}` entries, tried in order | `~/.claude/skills/<name>` |
| `budgets` | Overrides for the word and character budgets in house-style.md (`skill_body_words`, `reference_words`, `description_chars`) and instruction-files.md (`global_words`, `project_words`) | those tables |

The edit guard, a hook the installer adds, never blocks an edit: when a session edits a file in a covered skill folder, a `CLAUDE.md` or a file the global instructions import without having loaded this skill, it tells the session to load it. It doesn't see edits made through shell commands.
