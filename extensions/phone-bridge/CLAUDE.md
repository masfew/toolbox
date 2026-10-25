# phone-bridge: rules for Claude sessions

Read `README.md` in this folder first. The tool has three parts that share `core/`: the notifications (`notify/`), the phone launcher (`launcher/`) and the listener and presence watcher (`core/`). The rules below cover all of them.

After any change, run `python tests/test_phone_bridge.py` from this folder (offline).

## Secrets

`~/.claude/phone-bridge.json` holds the Telegram bot token and the chat ID. Never print, log, paste or commit any of them, and don't read the file's values into the transcript. To check what's set, test for the keys without showing the values. Never put the token in a URL you print: the Bot API URL holds it. The launcher never prints or logs the token either.

## Test pushes to the user's phone

Live pushes go to the user's own Telegram bot. Every real push from every session lands in that chat.

- Never send a test push until the user says they're ready.
- When they say go, tell them in chat that the test is starting, then wait 20 seconds before the first push (build the delay into the send script), so they can lock the phone and put it down.
- Number test pushes in the title ("Test 1", "Round 2 Test 3"), so they can't be confused with real pushes from other sessions, and report the exact send times afterwards.
- What was sent is in the `push` lines of `~/.claude/phone-bridge/phone-bridge.log`: time, session ID prefix, `ok message_id=…` or the failure, then the kind and seconds, such as `2026-10-18 23:17:08  round7te  push  -> ok message_id=13 (question push, 0.56s)` (lines before 20 Oct 2026 also name the backend, as in `telegram question push`). Telegram has no server-side list of a bot's sent messages, so the log is the record.
- A plain launcher run from a test would push "started" and "done" to the phone; that's only for a live test the user has said they're ready for (the rules above).

## Testing through the real hook from a Claude session

- Remove `CLAUDE_CODE_HOST_SESSION_ID` from the environment of the test run. Otherwise the hook reads this session's desktop-app record, sees it runs a different session ID, and ignores the run as "claude run by another session".
- Use a made-up session ID, with a flag file `~/.claude/phone-bridge/flags/<id>` containing `all`, so the hook treats pushes as on.
- To make the push link to a session, give the fake transcript a line `{"bridgeSessionId":"cse_<suffix>"}` written with no spaces (`json.dumps(..., separators=(",", ":"))`); the hook's pattern doesn't match `": "`.
- Delete the flag files (and any `.question-pushed` / `.report-turn` files) afterwards.

## Keeping automated runs quiet

- Don't count on `run_by_another_claude` to silence a test that a session runs through the Bash tool: the Windows parent chain stops at Git Bash (`env.exe` or `bash.exe` has no live parent), so it finds no outer claude. With `CLAUDE_CODE_HOST_SESSION_ID` stripped too, one such test turned pushes on as "away" and sent about 30 pushes. Since then a `CLAUDE_CODE_ENTRYPOINT` starting with `sdk` (the Agent SDK sets `sdk-ts`, `claude -p` gives `sdk-cli`) blocks the away rule (`driven_by_program`). Keep that check ahead of the away branch.

## The Telegram listener

- `core/listener.py` is the only program that may read the bot's incoming messages (`getUpdates`). Telegram allows one reader per bot; a second gets HTTP 409 and the two swallow each other's messages. The launcher and any other tool that takes commands through the bot add an entry under `telegram_commands` in `~/.claude/phone-bridge.json` and run as a subprocess of the listener; never give them their own poll loop. `install.py` only polls while no chat is saved, when the listener doesn't.
- This is one tool now, so the parts import from each other and from `core/bridge.py`: the listener imports the notify modules for its built-in commands, the hook and the launcher import `core.bridge`, and `core/bridge.py` imports from none of them. The listener never imports `notify_hook` (the hook is a separate process per event). Another tool (a separate folder) never imports from here: it adds a `telegram_commands` entry and runs as its own program.
- A `telegram_commands` program whose first item is a relative `.py` path (such as `launcher/launch.py`) runs with the listener's own Python from the tool folder (`resolve_run` in `core/bridge.py`), so the config never names where the tool is. Keep the installer's entry and `resolve_run` in step.
- The hook and the launcher share one file format, the markers in `~/.claude/phone-bridge/markers/` (`prompt`, `expires`, `test`). Change both sides together; the one suite, `tests/test_phone_bridge.py`, covers both.
- Before running anything that polls the bot yourself, stop the listener (find its `pid` in `~/.claude/phone-bridge/listener.json`) and restart it afterwards. A hook event restarts it within 150 seconds of its last heartbeat anyway.
- The listener and `notify/sessions.py` run in a long-lived process, so a code change takes effect only after the listener restarts: stop its process, and the next hook event starts the new code.
- Never leave a message with a ForceReply (or any non-inline reply keyboard) in the chat once it stops taking answers: delete it, as `end_question` does. Telegram's iPhone app keeps the chat's newest such message as its keyboard message until it's deleted or a newer one replaces it (Telegram-iOS `PeerChatTopTaggedMessageIdsTable`), and the user saw the reply to it reopen on every chat open (found 2026-10-21). `editMessageReplyMarkup` can't remove a ForceReply.
- A ForceReply question never opens the keyboard on Telegram's iPhone app: it only attaches the reply (Telegram-iOS `UpdateChatPresentationInterfaceState.swift`, `requestsSetupReply`). A `switch_inline_query_current_chat` button does (`ChatControllerOpenPeer.swift`, `fillComposer` sets the input mode to text), but the text it inserts always starts with `@<bot-username> ` (checked 2026-10-21). That's why the choice buttons use it; the bot has inline mode off, so typing after the name sends no inline queries.
- Test external commands only with a throwaway echo handler in a test config; never add a real entry for a tool that isn't built.
- Offline tests move HOME and USERPROFILE to a temporary folder before importing anything (the fake-home trick in `tests/test_phone_bridge.py`), so they can never touch the real files, and patch the paths on the modules they use: `bridge.CONFIG_FILE`, `bridge.LOG_FILE`, `bridge.SNOOZE_FILE`, `hook.MARKER_DIR` and `hook.FLAG_DIR` (also `sessions.FLAG_DIR`), `sessions.TRANSCRIPT_DIR`, `APPDATA`/`LOCALAPPDATA`, `notify_hook.run_by_another_claude` and `notify_hook.seconds_since_real_input`. Otherwise the away check turns pushes on whenever the user isn't at the keyboard. A live `/on` test follows the test-push rules above.

## /archive

- Never archive one of the user's sessions to test it, even one that looks finished: archiving stops its process and may clean up its worktree. Test on a throwaway session from `python launcher/launch.py --test "<prompt>"` (pushes off), let its turn end, then `python notify/archive.py --archive <local_id>`. Test the Telegram handlers with `listener.call` stubbed, so nothing reaches the phone.
- Don't judge "finished" from the app's `isRunning` (list_sessions) or the record's turn fields: `isRunning` read false for a session whose background task hadn't reported back (2026-10-21). The transcript checks in `notify/archive.py` decide, and stay stricter than `/notify_me`'s (no 2-hour or 24-hour cutoffs; servers count).
- Don't try to archive by editing the app's record files or `archived-sessions.idx`: the app reads them only at start, and its `claude://` links only start or continue sessions. The sidebar route (`notify/archive_steps.ps1`, probed on Claude desktop 3.1623) works with the window minimized.

## Siri sends as the user, never as the bot

The Siri Shortcut sends through the Telegram app's Shortcuts "Send Message" action, to an iPhone contact whose mobile is the bot's numeric ID and whose URL labelled Telegram is the bot's link by ID, as `siri_contact` in `install.py` builds it (Telegram-iOS issue 2152; the username link and chat IDs don't work). The message comes from the user's account, so the listener needs no change. Don't switch it to a Shortcut calling the Bot API's `sendMessage`: a bot never receives its own messages through `getUpdates`, so the listener would never see them, and putting the token in a Shortcut breaks the secret rules above.

## The app's controls (Claude desktop 3.1623, probed 2026-10-20)

- The new-session screen has separate **Environment** ("Environment: This computer", options This computer, named environments such as Work, Cloud, Remote Control), **Folder** ("Folder: <path>", options No folder and recent folders) and **Permissions** ("Permissions: Auto") buttons, all with ExpandCollapse and no Invoke. Before Oct 2026 Environment held the folders too.
- The options aren't in the accessibility tree until a menu opens. Look them up by name after expanding.
- With No folder chosen, the Folder button reads "Folder: Choose folder…".
- **Saved environments (probed 2026-10-21)** are the app's presets, read from `ccd-session-presets.json` (a Store app: the real file is under `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\`; reading the `%APPDATA%` path failed from a Claude session's Bash). The Environment menu shows only the most recently used one, as a RadioButton named "Work , edit environment, right arrow" (Invoke works); the rest are under a MenuItem "More 11" (the count varies), which ignores ExpandCollapse.Expand and opens only with the Right arrow while it has the focus. Choosing one shows no trust prompt, the button reads "Environment: Work", and the Folder button goes away (the preset brings its folder).
- The menu also lists RadioButtons "Claude" and "Code" (the app's mode tabs), and the sidebar has ListItems and Buttons named after presets; match picker options by control type and name, as `FindOption` does.
- Any key the steps script sends must go through `PhoneLauncherWin.OwnExtendedKey` (or carry `OWN_INPUT` some other way): `SendKeys` input counts as someone using the PC in `launch.py`'s input watch, so a key before "ready" would turn every launch into a retry.
- A `folder=` parameter on the `claude://code/new` link shows "Trust this workspace" every time; never use it.
- `launcher/launch_steps.ps1` must stay ASCII: Windows PowerShell 5.1 reads a file without a byte-order mark in the ANSI code page, so a literal "…" breaks a match. Use `\W*` or similar.

## Testing the launcher against the live app

- The link replaces whatever is in the new-session box. Before any live launch, check that box for an unsent draft (read the "Prompt" Edit's value through UI Automation) and save a copy first; afterwards put it back by opening `claude://code/new?q=<draft>` and resetting the pickers, without pressing Enter.
- Use `launch.py --test "<prompt>"`: its marker turns the new session's pushes off, so nothing reaches the user's phone.
- If someone may be at the PC (real input in `~/.claude/phone-bridge/presence.json` in the last minute), add `--quiet 120`, so a test launch doesn't take the Claude window from them mid-typing.
- Simulate "another program's input" with 0-pixel mouse moves (SendInput with no OWN_INPUT marker), never key presses: keys go to whatever window is in front, which may be the user's.
- Claude Code's auto mode may refuse to run a live launch from a session, because it drives the Claude app's window. Switch the session to Accept edits or Manual for those steps if it does.
- Test launches leave "Phone launcher test …" sessions in the sidebar. List them for the user and ask before archiving.

## The local app request folder

- The README's request folder protocol is the contract with whatever app answers (`core/local_app.py`, optional `local_app` in the config). `core/local_app.py` imports only `core/bridge.py`. Add an action only with its row in the README's table, and keep the app's own naming out of this tool: the folder path and display name live in the user's `~/.claude/phone-bridge.json`, never in the repo.
- Fall back to the desktop app only on `NO_APP` (no folder, or the request was still there when the timeout ran out, and is deleted). A request the app took and then left unanswered raises `AppError` and is reported, never retried through the desktop app: the app may be running it, so a fallback could start the same session twice.
- The app route writes no launcher marker and does not turn pushes on itself: `start` carries `"notify": true` and the app writes the flag after the hook has decided on the first prompt. A marker would only expire unmatched, and a test marker would turn the session's pushes off. The launcher sends the 🚀 push through `notify_hook.push_for` (the launcher imports `notify_hook`; the listener still never does).
- A local app session in an `/archive` or `/notify_me` button has `app:` before its key (`conversationId`, else `id`) in the button's data; Telegram allows 64 bytes, so a longer one is left off the list. `archive_session` in `core/listener.py` is the one place that routes an archive to the right app.
- Tests use `FakeApp` (a thread watching a temporary folder). Never send a request to the user's real app from a test or a session's check: `start` starts a real session, `archive` archives one and `notify` writes flag files. `launch.py --test` on this route starts a real session too (with `notify` false and no push), so it's for a live test the user asked for, like the launcher tests below.

## The installer

- `install.py` is built on toolbox's `.github/template/install.py`. Its shared functions must stay identical to the template's; only the functions marked `# differs from the template:` (today `main()`) may differ. Put new behaviour in the marked functions or in the bot and feature section, not in the shared ones; if a shared function has to change, change the template first.
- It installs to the stable path `~/.claude/tools/phone-bridge` and records what it added in `~/.claude/tools/phone-bridge.install.json`. The first install asks for the bot token with hidden typing, so a Claude session can't do it; the user runs it in their own terminal.
- The launcher is optional, and never installed without the notifications. Its on-disk marker is the `start` entry in `telegram_commands`; with no terminal to ask in, the installer keeps the last choice from that entry.
