# Toolbox

Instructions for Claude Code sessions working in this repo. The root README says what each tool is; each tool's README says how to install, use and remove it.

## Installing a Tool

When someone asks you to install a tool from this repo ("clone the toolbox and install get-to-the-point"):

1. **Find the tool** by its row in the root README's Tools tables. The row links to its folder, `<kind>/<tool>/`. If the name they gave matches no row, list the closest names and ask which one they meant.
2. **Read the tool's README in full** before running anything, above all Requirements, Install with Claude Code and Install.
3. **Do every step under "Claude does"** in its Install with Claude Code section yourself, in order, from the folder it names. Check each step's output before the next: installers end with "Setup complete", or with "FAILED:" and what to do.
4. **Walk the person through every step under "You do"**, one at a time. Say exactly what to do and where, then wait for them to say it's done before giving the next. Don't hand them the whole list at once.
5. **Finish** by saying what was installed, what you checked, and what's left for them, such as starting a new session.

If a step fails, read its message and do what it says, then rerun: every installer here is safe to rerun. If the README doesn't cover what happened, say so rather than guess.

## What You Never Do

- **Handle secrets.** Never ask for, read, type, paste or store a token, password, API key or other secret, even when the person offers it. A tool that needs one asks for it in its installer's hidden prompt, and the person runs that step in their own terminal (it's under "You do").
- **Install software outside the clone without asking.** Before installing a program or toolchain (Python, Rust, Node, any winget, Homebrew or apt package), say what it is, why the tool needs it and the exact command, and wait for a yes. A step that needs an administrator or `sudo` password goes to the person. On Windows, a check can install software too: when `Get-Command python` (PowerShell) points into `WindowsApps`, `python` may be the Python install manager, whose first run downloads and installs Python by itself. So look that up before running `python` at all, even `python --version`. If it points there, tell the person that running `python` may download and install Python first, and wait for a yes (or use a Python already found some other way).
- **Install by hand.** Don't edit `~/.claude/settings.json`, `~/.claude/CLAUDE.md`, Startup folders or other files outside the clone to install or remove a tool, and don't copy a tool's files into place yourself. The installer makes those changes, backs files up first and records them, so `python install.py --remove` can undo them.
- **Work around the Claude desktop app's AppData folders.** On Windows, a program started from a Claude desktop app session can have its AppData writes redirected into the app's own package folder. Installers that write there detect this and rerun themselves outside it, so run them as the README says and never move or copy their files into AppData yourself.

## Updating and Removing

Each tool's README has an Updating and an Uninstall section: follow those the same way, with the same rules. Removing is always `python install.py --remove` from the tool's folder, or from `~/.claude/tools/<tool>` if that folder is gone.

## Changing a Tool

A new tool starts from `.github/template/`, as the comment at the top of its `README.md` says. Each tool's `install.py` keeps the functions it shares with `.github/template/install.py` in step with it, as the top of that file explains, and `.github/scripts/pre_push_check.py` checks this before every commit and push.
