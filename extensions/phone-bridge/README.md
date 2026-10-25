# phone-bridge

Version 1.0.0. See the [changes](#changes) at the end.

## What It Does

phone-bridge pushes a message to your phone, through your own free Telegram bot, when a Claude Code session finishes, asks you a question or waits on a permission prompt. From the bot's chat you can also turn pushes on for sessions that are already working, silence them for a while, archive finished Claude desktop app sessions, and (optionally) start a new desktop app session on your PC from a message.

It is for anyone who runs long Claude Code sessions and wants to walk away from the PC. It needs no Remote Control and nothing beyond Python 3.

## Requirements

- Windows 11 (tested). macOS and Linux are untested and unsupported: away detection, process checks, the Startup shortcuts and the phone launcher are Windows only.
- Python 3.9 or newer. Standard library only: nothing else to install.
- Claude Code, in the desktop app, the terminal, or both. The desktop app adds session titles and links to the pushes, a stand-alone summary in the "done" push, and `/archive`.
- A phone with the Telegram app, signed in, and a Telegram bot of your own (the install walks you through making one with @BotFather; it's free).
- For the phone launcher only: the Claude desktop app for Windows, signed in and running on the PC.

| Feature | What it does | Needs |
|---|---|---|
| Notifications (always installed) | Pushes to your phone for questions, permission prompts and finished turns. The bot's `/notify_me`, `/snooze` and `/archive` commands. | Everything above. `/archive` and session titles need the Claude desktop app. |
| Phone launcher (optional) | `/new_session` starts a new Claude desktop app session on the PC from a message to the bot. The session is a normal desktop session: it shows in the desktop sidebar, and on the phone through Remote Control. | The notifications, Windows, and the Claude desktop app. Not available on other systems. |

> **The launcher and `/archive` depend on the Claude desktop app's internals.** They drive the app's screens through Windows UI Automation (finding controls by their names), and read the app's undocumented session files. An app update can rename a control or change a file and break them, and can change the session titles and links shown in pushes. Pushes themselves keep working without them: the hooks fall back to the project folder's name as the title. If the launcher or `/archive` stops working after an app update, [Troubleshooting](#troubleshooting) says where to look.

## Quick Start

Make a bot first: in Telegram, open a chat with @BotFather, send `/newbot`, give it a display name (such as "My Claude Bot") and a username ending in `bot` (such as `my_claude_bot`), and keep the token it replies with.

Then, in your own PowerShell window (the installer asks for the token with hidden typing, so run it yourself):

```powershell
git clone https://github.com/masfew/toolbox.git
cd toolbox\extensions\phone-bridge
python install.py
```

Paste the token, answer whether to install the phone launcher, and send your bot any message from your phone when it asks. It ends with **Setup complete**. Then fully quit and reopen Claude Code, as [Install](#install) says.

## Install with Claude Code

Say to Claude Code: *"Clone https://github.com/masfew/toolbox and install phone-bridge."* With a clone already there, open Claude Code in it and say *"Install phone-bridge."* Claude follows the repo's install rules: it does the steps under Claude does, and reads out the steps under You do one at a time, waiting for each.

**Claude does:**

1. Checks this is Windows, and that Python 3.9 or newer is installed. It asks before installing Python if it's missing, with the command from [Install](#install) step 1. When `Get-Command python` (PowerShell) points into `WindowsApps`, `python` may be the Python install manager, whose first run downloads and installs Python by itself, so it asks you before running `python` at all. If you want the phone launcher, it also asks you whether the Claude desktop app is installed and signed in.
2. Asks whether you want the notifications alone, or the notifications with the phone launcher, and uses the answer as the installer's `--features` value (`notify` or `notify,launcher`). If you're not sure, it suggests both on Windows with the desktop app: a session started from your phone needs the pushes to tell you when it finishes.
3. Tells you what the install changes: it adds four hooks to `~/.claude/settings.json` (after backing it up), adds two Startup shortcuts that run the Telegram listener and the presence watcher at every sign-in, starts them now, and puts the tool at `~/.claude/tools/phone-bridge`. It waits for your yes.
4. Only if `~/.claude/phone-bridge.json` already holds both `telegram_token` and `telegram_chat_id` (a reinstall or update), it checks that without printing their values (for example with a one-line Python command that prints only True or False), then runs `python install.py --features <your choice> --test` from `extensions/phone-bridge`, and checks the output ends with **Setup complete**. Otherwise it doesn't run the installer: a first install asks for the token, which Claude must never see. It gives you the two lines for You do step 3 instead: `cd "<the full path of extensions\phone-bridge in the clone>"` and `python install.py --features <your choice> --test`. (Run by Claude on a first install, the installer stops at once with "Run this in a terminal" and changes nothing.)
5. After you've run it, asks you to confirm the installer ended with **Setup complete** and that "phone-bridge is set up" arrived in the bot's chat, then checks, without printing any value, that `~/.claude/phone-bridge.json` now holds `telegram_token` and `telegram_chat_id`.

**You do:**

1. In Telegram on your phone, open a chat with @BotFather (the one with the blue tick), send `/newbot`, give the bot a display name (it titles every banner, for example "My Claude Bot") and a username ending in `bot` (for example `my_claude_bot`). BotFather replies with a link to the bot and its token. Keep the token to yourself.
2. On your phone, allow Telegram's notifications in the phone's own settings (on an iPhone: banners on, and Immediate delivery rather than a scheduled summary).
3. For the first install, open a PowerShell window yourself (from the Start menu, not inside Claude Code), paste the `cd` line Claude gave you, then the install command, which has the `--features` choice and `--test` in it, for example `python install.py --features notify,launcher --test`. Paste the token when it asks (typing stays hidden). The installer must print **Setup complete**.
4. When the installer says "Send your bot any message from your phone", open your bot's chat and send it any message, such as "Hi" (tapping Start alone may not reach it). You can send it before running the installer too. The installer waits up to 3 minutes. When it finishes, "phone-bridge is set up" arrives in the chat.
5. Fully quit and reopen Claude Code, every window, so the hooks load. Sessions that were already open keep the hooks they started with.
6. Optional, with the phone launcher: set up the Siri Shortcut with the contact details the installer printed at the end, as [Siri](#siri) says.

## Install

1. **Python 3.9 or newer.** Check with `python --version`. If it's missing, run `winget install Python.Python.3.13`, then open a new terminal.
2. **A Telegram bot.** On your phone, install Telegram and sign in. Open a chat with @BotFather, send `/newbot`, and give the bot a display name (it titles every banner) and a username ending in `bot`. BotFather replies with a link to the bot and its token. Telegram doesn't need to be open on the PC.
3. Clone the repo and open the tool's folder (PowerShell):

   ```powershell
   git clone https://github.com/masfew/toolbox.git
   cd toolbox\extensions\phone-bridge
   ```

4. Open the bot's chat and **send it any message**, such as "Hi". Tapping Start alone may not reach the bot.
5. Run the installer in your own terminal, since it asks for the token with hidden typing and a first install can't run from inside Claude Code (PowerShell):

   ```powershell
   python install.py
   ```

   It asks whether to also install the phone launcher (default yes; Windows and the Claude desktop app only). Or answer ahead of time (PowerShell):

   ```powershell
   python install.py --features notify            # notifications alone
   python install.py --features notify,launcher   # notifications and the phone launcher
   ```

   `--features launcher` alone is refused, because the launcher needs the notifications. Rerun the installer with the other answer to add the launcher later or take it out. With no terminal to ask in, the installer keeps what the last install chose (the launcher installed counts as yes; a first install on Windows is yes). On a system other than Windows it installs the notifications only.

   Paste the token when it asks. The installer then:
   - checks the token with Telegram and prints the bot's name;
   - finds your chat from your message (if it hasn't arrived yet, it waits up to 3 minutes for one) and saves the token and chat ID in `~/.claude/phone-bridge.json`;
   - with the launcher: checks no webhook is set on the bot (the listener reads messages with `getUpdates`, which a webhook stops), adds the launcher's default settings under `"launcher"` in the config (keeping your values), and adds the `start` entry to `telegram_commands` (the "Start a new session" first line and `/new_session`, with its menu description and its question for when it comes alone). Without the launcher it takes that entry out;
   - puts the tool at the fixed place `~/.claude/tools/phone-bridge`. In a git clone that's a link to the folder (a directory junction on Windows, which needs no admin rights), so a `git pull` updates the tool straight away. From an unzipped release it's a copy, and the unzipped folder can be deleted afterwards. `--copy` or `--link` overrides the choice;
   - backs up `~/.claude/settings.json` and merges in the four hooks (keeping any others): UserPromptSubmit, PreToolUse (matcher `AskUserQuestion`), Notification (matcher `permission_prompt|elicitation_dialog`) and Stop, each running `python "<~/.claude/tools/phone-bridge>/notify/notify_hook.py"`;
   - on Windows, adds two Startup shortcuts, `phone-bridge presence.lnk` for the presence watcher and `phone-bridge listener.lnk` for the Telegram listener that answers the bot's commands, so both run from sign-in with no window, and starts them now. On a rerun it stops the running ones first. The listener puts the bot's commands in its command menu when it starts and whenever the list changes;
   - when the Claude desktop app runs the install, reruns itself outside the app's package, so the Startup shortcuts land in your real Startup folder. It says so when it does;
   - writes an install record, `~/.claude/tools/phone-bridge.install.json`, so a rerun or `--remove` knows what it added.

   Add `--test` to get one "phone-bridge is set up" message in the chat. Rerunning is safe: it reuses the saved token and chat, keeps your launcher settings and any other `telegram_commands` entries, and replaces its own entries.
6. The last lines list what's left for you to do: fully quit and reopen Claude Code (every window) so the hooks load (sessions that were already open keep the hooks they started with), and, with the launcher, the Siri contact's mobile number and address (see [Siri](#siri)).

Treat the bot token like a password: anyone who has it can send messages as your bot and read what you send it (not your other chats). If it leaks, send `/revoke` to @BotFather, delete `telegram_token` from `~/.claude/phone-bridge.json`, and rerun `python install.py` in your own terminal with the new token. The hook reads the config on every push, so a new token or chat applies from the next push with no restart.

## Configuration

Settings are in `~/.claude/phone-bridge.json`, which the installer creates and fills in. It holds your bot token, so it's never in the repo; keep it to yourself. [`config.example.json`](config.example.json) shows every setting with its default; the installer treats its `REPLACE_WITH_...` placeholders as not set and asks for the token. The hook rereads it on every event and the listener on every loop, and each launch rereads the launcher's settings, so a change applies without a restart.

| Setting | What it does | Default | Example |
|---|---|---|---|
| `telegram_token` | Your bot's token. Written by the installer from its hidden prompt | None | Set by the installer |
| `telegram_chat_id` | Your chat with the bot. The installer finds it from your first message to the bot, and the listener ignores every other chat | None | Set by the installer |
| `waiting_pushes` | `true` brings the ⏳ push back (Claude ended its turn only to wait on background work). With many sessions running at once these flooded the chat, so they're off | `false` | `true` |
| `telegram_commands` | Commands that programs add to the listener (see Commands from Other Programs under [How It Works](#how-it-works)). The installer manages the `start` entry and keeps any others | The launcher's `start` entry, or `[]` without the launcher | Leave as is |
| `launcher` | The phone launcher's settings, below | See below | See below |

The launcher's settings, under `"launcher"`. The installer adds all of them with their defaults and keeps any value you changed:

| Setting | What it does | Default | Example |
|---|---|---|---|
| `quiet_seconds` | Seconds without keyboard or mouse input before a launch starts | `10` | `20` |
| `busy_reply_after` | Seconds of waiting before the "PC busy, still waiting" reply | `300` | `120` |
| `give_up_after` | Seconds of waiting before giving up. Keep it under the command's `timeout` (1800) in the `start` entry | `1500` | `900` |
| `permission_mode` | The new session's permission mode, as the app's Permissions picker names it: `Auto`, `Manual`, `Accept edits` or `Plan`. Bypass permissions is never used | `Auto` | `Plan` |
| `max_age_seconds` | Commands older than this get "Not started, too old" | `120` | `300` |
| `max_link_chars` | The longest `claude://` link tried (the prompt URL-encoded). Windows refused a 42,308-character one | `30000` | `20000` |
| `step_timeout` | Seconds for the message box to get the prompt, and for the session to appear after Enter | `20` | `30` |
| `attempts` | Launches interrupted by input on the PC are retried, this many times in all | `5` | `3` |
| `nicknames` | Short names for saved environments, for "Start a new session in hl". Ignoring case | `{}` | `{"hl": "Home Lab"}` |

For example, to make new sessions start in Plan mode and add a nickname:

```json
{
  "launcher": {
    "permission_mode": "Plan",
    "nicknames": {"hl": "Home Lab"}
  }
}
```

`NOTIFY_ME_ALL` (see Turning Pushes On from Your Phone) is a constant in `core/listener.py`, not a setting.

## Usage

### Notifications

End a prompt with one of these phrases (a follow-up message sent while Claude is working also counts), or send it while you're away from the PC, such as from your phone through Remote Control. The phrase has to be the very end of the message (only punctuation or attached images may follow), so "notify me" used in passing, as in "these notify me changes", doesn't count:

| You end your message with… | ❓ question / ⚠️ permission | ⏳ waiting | ✅ done |
|---|---|---|---|
| "notify me" (or "send me a notification") | yes | yes | yes |
| "notify me when you're done" (or finished, complete, at the end) | yes | no | yes |
| anything else, sent while you're away from the PC (Windows) | yes | yes | yes |
| anything else, typed at the PC | no | no | no |

- **❓ question:** Claude asks you something with its question dialog.
- **⚠️ needs permission:** a permission prompt is waiting. The desktop app also raises a permission prompt for Claude's question dialog; that one is skipped as a duplicate of the ❓ push, but only when the ❓ push actually went out.
- **⏳ waiting:** Claude ended its turn only to wait on background work (a background command, subagent or workflow) that hasn't reported back yet, including work started before your "notify me". **Off by default**: with many sessions running at once these flooded the chat, so no ⏳ push goes out and the table's ⏳ column doesn't apply. Set `"waiting_pushes": true` in `~/.claude/phone-bridge.json` to bring them back; the hook reads the config on every event, so it applies at once.
- **✅ done:** Claude finished.
- **🚀 started:** the phone launcher started this session from a /new_session or "Start a new session" message to the bot (see [Starting Sessions from Your Phone](#starting-sessions-from-your-phone)). The push is titled with the new session's title (or "New session" if the app hasn't titled it within 20 seconds) and carries the start of the prompt, and pushes are on for that session from then on.

**Sessions Claude starts** (in the desktop app, when Claude splits work off into a new session or hands it off) take on the starting session's pushes for the brief they start with, so they push the same way. The starting session then stays quiet for that work: the turn that started the session, and the turns where it reports back on what that session did, send no ⏳ or ✅ push (its own ❓ and ⚠️ pushes still come through). A subagent's result isn't such a report: it's the session's own work, so the turn it starts pushes as usual. A `claude` that a session runs itself, such as a test run or a script, never pushes. Nor does being away turn pushes on for a `claude` that a program drives through the Agent SDK or `claude -p`, such as an automated test: its prompts come from the program, not from you. Ending a prompt with "notify me" there still works.

Each push carries only what that kind needs, short enough to read on the lock screen:

| Push | Shows |
|---|---|
| ✅ done | The turn's summary from the desktop app's next-step box (its `wrap_up` recap, written to stand alone with the outcome first), then "Your call: <question>" when the box asks one. A turn without a next-step box, such as a plain answer or a terminal session, shows the opening of Claude's reply instead: whole paragraphs that fit in 300 characters, or the first paragraph's whole sentences that do, as plain text (code blocks, link targets, bold and inline code marks removed). A lead-in ending in ":" whose list didn't fit loses that sentence. |
| ❓ question | The first question, its option labels on one line ("Compact (Recommended) · Wide · Split", up to 120 characters), and "+1 more question" when the dialog has more. |
| ⚠️ permission | "Needs permission for <tool>: <what the call does>": the call's own description (Bash, PowerShell, subagents), the file it touches (Edit, Write, Read), the site it fetches, or the start of its command, up to 100 characters. The hook finds the call in the transcript as the latest call of that tool still waiting for its result. A prompt that names no tool (an MCP server's form) shows its own message. |
| ⏳ waiting | The reply's opening, shortened the same way as a ✅ push without a summary, plus, when that's under 200 characters, the task list's current step, the steps already done, and any labeled background work still running. |

Pushes are titled with the session's title in the desktop app, such as "Login page: fix the redirect"; the emoji in front says which kind it is, so the title adds no "· done" (🚀 pushes keep "· started"). A session outside the app is titled with its folder name instead (a git worktree is titled with its main repository's name, and a session with no project folder is "No folder"). Notifications stay on until you send a message that doesn't end with the phrase from the PC, so a mid-task check-in typed at the PC without "notify me" switches them off.

**What a push looks like.** Each push is a message from your bot. Its first line is the kind's emoji and the push title in bold, such as "✅ **Login page: fix the redirect**", with the push's message below it and the session's link written out on the last line. The lock-screen banner is titled with the bot's name (for example "My Claude Bot") and shows the text plain (bold only shows in the chat), about four lines of it: a long session title wraps onto two, leaving about two lines of the message. Tapping the banner opens the chat in Telegram, and tapping the link opens the Claude app straight into that session when the session is connected to Remote Control (a `claude.ai/code/session_…` link), and the Code tab otherwise (which opens a new Code chat). The link is written out rather than put behind a button because Telegram opens a visible link in one tap but asks "Open this link?" first for a button or a labelled link. Every push makes a sound; iOS may play one sound for several that arrive together.

**Away from the PC** means no real keyboard or mouse input in the 15 seconds before the message arrives. Typing it or clicking Send at the PC is always more recent than that. Input that programs simulate (automated tests, macro tools, dictation tools pasting text) doesn't count, because Windows marks it as injected. A message from your phone sent while you're also using the PC counts as typed at the PC; add "notify me" to it.

### Turning Pushes On from Your Phone

Send `/notify_me` to your bot (it's in the bot's command menu) to turn pushes on for sessions that are already working, without sending them a message.

By default (`NOTIFY_ME_ALL = True` in `core/listener.py`) it turns pushes on, all of them as below, for every session that has something running and pushes off, and for their working sub-sessions, then replies "Done. All notifications are on (turned on for 3 sessions)." or, when there was nothing to turn on, "Done. All notifications were already on." Set `NOTIFY_ME_ALL = False` and restart the listener to go back to picking sessions one at a time, as the rest of this section describes.

In that mode the bot replies with one button for each session that has something running and pushes off, labelled with the session's title and what's running, such as "Login page: fix the redirect · working, 2 background tasks":

- **working:** Claude is in the middle of a turn, including a long command that writes nothing.
- **background tasks:** the turn ended to wait on background work (a background command, subagent or workflow) that hasn't reported back.
- **sub-session working:** a session this one started (split off or handed off) is working. It's listed under the session that started it rather than on its own, even when that session is idle.

Tapping a button turns pushes on (all of them: ❓, ⚠️, ⏳ and ✅) for that session and its working sub-sessions, as if your prompt had ended with "notify me", and adds a line to the bot's message saying so. Its next push goes out as usual, such as the ✅ when the turn ends. If the session finished between the list and the tap, the bot says so and leaves pushes off. As with any other way of turning pushes on, the next message you type at the PC without "notify me" turns them off again. With nothing to list, the bot replies "No active sessions with pushes off." Any other message to the bot gets a short list of the commands it knows.

### Snoozing Pushes

Send `/snooze` to your bot (it's in the command menu too) to make pushes silent for a while. The bot replies "Make pushes silent for how long?" with four buttons: 1 hour, 4 hours, 12 hours and 24 hours. Tapping one starts the snooze, and the bot's message gets a line such as "😴 Snoozed until 22:15" (with the weekday when it ends on another day) and loses its buttons.

While a snooze runs, every push still arrives in the chat as usual, but silently: no sound and no banner, so you can scroll back later to see what happened. That covers every kind (❓, ⚠️, ⏳, ✅ and 🚀) and every session, including prompts that end with "notify me". It doesn't change which sessions push; it only changes how a push arrives. When the time runs out, pushes make a sound again, with no message to say so.

Sending `/snooze` during a snooze says when it ends ("Snoozed until 22:15. Change it, or end it:"), with the same four buttons and an **End snooze** button. A new duration counts from the tap, replacing the old end time. End snooze makes pushes sound again at once.

### Archiving Finished Sessions

Send `/archive` to your bot (it's in the command menu) to archive desktop app sessions you're done with. This needs the Claude desktop app running on the PC with its sidebar showing. The bot replies with a numbered list of the sessions that are completely finished and not archived, newest first, each with its full title and when it finished, such as "1. Login page: fix the redirect (8:25 PM)": a 12-hour time for today, "yesterday" for the day before, and ">1 day" for anything older. Below it is one button per session, in the same order, labelled with its title. Telegram shows a button's text on one line and cuts a long title off with "…", which is why the list above carries the full titles. "Finished" is when the session's transcript last changed. Tapping one archives it in the app (as Archive in the sidebar's menu does), adds a line such as "🗄 Login page: fix the redirect: archived" to the bot's message, and takes that button off.

With two or more sessions listed, an **Archive All** button sits at the bottom. One tap archives every session still listed, one after another (each takes a few seconds in the app's window). While it works, the buttons come off and the message counts up ("🗄 Archiving all 12: 3 done"). At the end it says "🗄 Archived 10 of 12", with a line for each session that wasn't archived and why, and puts back the buttons of any that were busy or failed so you can try them again.

A session is listed only when nothing about it is still going, so you can't archive work by accident:

- its turn has ended. A session waiting on a question or a permission prompt is never listed, however long it waits;
- the app's sidebar doesn't show it under "Needs input". A turn can end in plain text that waits on you ("holding until you say go") with no question pending; the app's end-of-turn summary still marks it as needing input, and so does a recent error;
- no background command, subagent or workflow it started is still to report back, servers and watchers included (archiving stops them);
- no message or task result is queued for it, and the app holds no input for it;
- nothing in its transcript has changed for 10 seconds (writes still on their way);
- no session it started (split off or handed off) is still going;
- it isn't pinned, and no other session that isn't archived has the same title (the bot can only find the sidebar row by its title; rename one in the app to list both).

Two cases count as finished. A turn whose transcript stopped before the app last started was cut off by quitting the app. Background work started before then was killed by the quit and can't report back.

A tap checks all of this again first. If the session started working since the list, the bot adds "⏳ <title>: not archived, <why>" and keeps the button. The archive itself happens in the app's window on the PC, so the app has to be running with its sidebar showing; otherwise the bot says it couldn't (for example "couldn't find it in the app's sidebar"). If the app asks to confirm (such as for a worktree with changes), the bot cancels the dialog and says so; archive that one at the PC. With nothing to list, the bot replies "No finished sessions to archive." `python notify/archive.py --list` in this folder prints what `/archive` would list, and why each other session isn't on it.

Once a session is archived, the bot deletes its pushes (🚀, ❓, ⚠️, ⏳ and ✅) from the chat, so the chat keeps only sessions still in the sidebar. After an `/archive` tap or Archive All that happens at once; for a session archived at the PC, within 3 minutes. Telegram lets a bot delete a message only for 48 hours after sending it, so pushes older than that stay; delete those yourself if you want them gone. The bot's replies to commands (such as `/archive` lists) stay too, and so do pushes from a session deleted in the app rather than archived.

### Starting Sessions from Your Phone

This needs the phone launcher (an install choice). Open the chat with your bot, tap the **Menu** button and tap **/new_session**. The bot asks "Where should the new session run?" with a button for **No folder** and one for each environment saved in the desktop app (its Environment picker's presets, such as "Work" and "Home Lab"), most recently used first. Tap one, and your message box fills with the bot's username and your choice, such as `@<bot-username> Work: `, with the keyboard already open: type or dictate your prompt after it and send. The bot then marks your choice under its question and takes the buttons off. (Telegram always starts the text a button puts in your box with the bot's username; the listener takes it off again.)

Or send it all in one message (pressing and holding /new_session in the menu should put it in the message box without sending it):

```text
/new_session <your prompt, on one or more lines>
```

or:

```text
Start a new session
<your prompt, on one or more lines>
```

or, to start in a saved environment:

```text
Start a new session in Work
<your prompt, on one or more lines>
```

- After /new_session, everything else in the message is the prompt, line breaks kept, and the session starts in No folder. With "Start a new session" or "New session" (any case, with or without a full stop) on the first line, everything under it is. "Start a new session" or "New session" alone gets the environment buttons, like /new_session.
- "in <name>" on the first line names a saved environment, ignoring case, or one of your nicknames for one (see [Configuration](#configuration)). Alone, it asks for the prompt.
- A name that isn't saved gets "No environment called Wrk. Did you mean Work?" with **Yes** and **No** buttons when one is close: Yes starts it there, No starts nothing. The question keeps your command for 10 minutes, and the buttons go once you tap one. A name with nothing close gets "No environment called Garden exists. These do: …".
- The environment buttons keep working after the question: a message sent from one any time later starts the session (subject to the 2-minute limit below, counted from when you send it). Keep the colon after the environment's name: everything after the first colon is the prompt, colons and line breaks kept. Sending it with nothing after the colon gets "What should the new session do?".
- After the bot's "What should the new session do?" question (from "Start a new session in Work" alone, a button's text sent with no prompt, or when the environments can't be read), the next message you send is the prompt, as long as it comes within 10 minutes. Sending a command instead, or replying to a different message, drops the question.
- The bot deletes its "What should the new session do?" question once your next message arrives or the 10 minutes pass, so the reply to it doesn't reopen every time you open the chat. Your prompt then quotes it as "Deleted message".
- A new **No folder** session ("This computer", no project folder), or a session in the environment you chose (with that environment's own folder and settings), starts in **Auto** permission mode (or the `permission_mode` setting) with the prompt already sent, usually within about 10 seconds.
- When it starts, the bot sends "🚀 <session title> · started" with the start of the prompt, and pushes are on for that session (questions, permissions, waiting, done), as for any message sent while you're away.
- Any other message gets the bot's one-line list of the commands it knows.

The bot replies to your command when it can't start:

| Reply | Why |
|---|---|
| Where should the new session run? | You sent /new_session alone. Tap a button. |
| What should the new session do? | You named an environment with no prompt, or sent a button's text with nothing after the colon. Your next message is the prompt. |
| No environment called Wrk. Did you mean Work? | Yes starts the command in Work, No starts nothing. |
| No environment called Garden exists. These do: … | Nothing saved in the app is close to that name. |
| Couldn't start: couldn't read the app's environments | The app's presets file is missing or unreadable. |
| Add your prompt on the line under Start a new session. | The message had no prompt under the first line. |
| Not started, too old: sent at 14:03 | The command waited more than 2 minutes before the PC saw it (the PC was off, asleep or offline). Telegram keeps unread messages for 24 hours. |
| PC busy, still waiting | Something has been using the keyboard or mouse for 5 minutes (you, or another session's automation). It keeps waiting, and gives up after 25 minutes. |
| Couldn't start: Claude isn't running on the PC | The desktop app isn't open. |
| Couldn't start: <step> | A step in the app failed, such as "couldn't choose No folder". Nothing was sent. |
| Couldn't start: the prompt is too long for the app's link | Only a message full of emoji can hit this: the link carries any Telegram message of plain or accented text (tested to 8,000 characters). |
| Couldn't run start (…) | The launcher itself crashed or hung (from the listener). |

**Don't leave an unsent draft in the new-session box while you're away.** The launch fills that box with your prompt, replacing what was there.

#### Siri

"Hey Siri, new Claude session" asks what the session should do and sends `/new_session <what you said>` to the bot from your own Telegram account, through the Telegram app, without opening it. The listener sees it exactly as if you'd typed it, so nothing on the PC changes. The session starts in No folder. This is optional, needs an iPhone, and needs the phone launcher.

Telegram's Shortcuts action can only send to a contact, and a bot isn't one, so the bot first gets a contact on the iPhone (the workaround from [Telegram-iOS issue 2152](https://github.com/TelegramMessenger/Telegram-iOS/issues/2152)):

1. **The bot's ID and address.** The last lines the installer prints with the launcher give the exact **mobile number** (the bot's numeric ID) and the **Telegram address** for the contact. Rerun `python install.py` to see them again. Copy them exactly. (The ID is also the digits before the colon in the bot's token, but the token itself never goes into the contact.)
2. **The contact.** In Contacts, add a contact with a short, distinct name, such as "My Claude Bot". Set its **mobile** to the bot's ID. Add a **URL** with the label set to **Telegram** (add it as a custom label) and the address the installer printed. The bot's username link (`t.me/<username>`) doesn't work.
3. **The Shortcut.** In Shortcuts, make a new Shortcut named **New Claude Session**:
   - **Ask for Input**, type Text, prompt "What should the new session do?". Siri reads the question and takes your answer by voice.
   - **Send Message**, with Telegram as the app: the message is `/new_session ` (with the space) followed by the **Provided Input** variable, and the recipient is the bot's contact. Expand the action and turn **Show When Run** off, so it sends without showing the message first.
4. **Telegram's permissions.** In Settings → Apps → Telegram, set **Contacts** to **Full Access** (Limited Access isn't enough: Telegram's Siri side only looks contacts up with full access) and turn on **Siri → Use with Ask Siri**. For a locked phone, also turn on Settings → Siri → **Allow Siri When Locked**.
5. Say "Hey Siri, new Claude session", then your prompt. The started push arrives as usual.

| What you see | Fix |
|---|---|
| "Could Not Run Send Message. An unknown error occurred." | Telegram doesn't have Full Access to contacts (step 4). |
| "Invalid Recipients" | Telegram can't match the contact to the bot. The URL must be on a URL row labelled exactly `Telegram`, reading exactly the address the installer printed. Then remove the contact from the Shortcut's Send Message action and pick it again, and open Telegram once so it sees the change. |
| Telegram opens the chat instead of sending | Show When Run is still on. |
| The bot replies with its list of commands | There's no space between `/new_session` and Provided Input. |

## How It Works

The code is in three parts that share one core: `core/` (the shared pieces, the Telegram listener and the presence watcher), `notify/` (the hook and what it reads: session tracking, archiving, cleanup) and `launcher/` (the phone launcher). `core/bridge.py` holds the paths, the config, the Telegram sending, the log, the snooze and presence state, and how background programs are started; the listener, the hook and the launcher import from it, and it imports from none of them. The listener imports the notify modules for its built-in commands but never `notify_hook.py`.

Everything the install adds points at `~/.claude/tools/phone-bridge`, never at the folder you installed from: the hook commands in `settings.json` and the Startup shortcuts. Only `~/.claude/tools/phone-bridge` itself points at that folder (or holds a copy of it). The install also keeps a record of what it added, in `~/.claude/tools/phone-bridge.install.json`. A rerun reads it first and takes out anything the earlier install added that the new one doesn't, and `--remove` reads it to undo everything.

### Files on the Machine

| Path | What it is |
|---|---|
| `~/.claude/phone-bridge.json` | Not in the repo. The settings above, including your bot token and chat ID. |
| `~/.claude/tools/phone-bridge` | A link to the tool's folder (a junction on Windows; a copy outside a git clone), so nothing depends on where the clone is. |
| `~/.claude/tools/phone-bridge.install.json` | The install record: what the installer added, for a rerun and `--remove`. |
| `~/.claude/settings.json` | The four hook entries that run `notify/notify_hook.py` through `~/.claude/tools/phone-bridge`. |
| `Startup\phone-bridge presence.lnk` | Starts the presence watcher at sign-in (in `%APPDATA%\Microsoft\Windows\Start Menu\Programs`). Delete it to stop that. |
| `Startup\phone-bridge listener.lnk` | Starts the Telegram listener at sign-in (in the same Startup folder). Delete it to stop that. |
| `~/.claude/phone-bridge/phone-bridge.log` | The last 300 lines of three kinds. One per prompt: seconds since your last real input and whether pushes went on. One per push: the result, kind and how long the send took, such as `push  -> ok message_id=13 (question push, 0.56s)` or `failed: HTTP 401 Unauthorized`. One per listener event: `telegram  -> /notify_me: 2 listed`, `telegram  -> archive tap: archived`, `telegram  -> archived session's pushes: 3 deleted` (under the session's record ID), `telegram  -> pushes on (all): telegram` (under the session's ID) for a tap, `telegram  -> start: exit 0` for a launcher command, or a failed Bot API call. It never holds the message text or the token. |
| `~/.claude/phone-bridge/flags/<session-id>` | Present while notifications are on for a session; holds `all` or `final`. |
| `~/.claude/phone-bridge/flags/<session-id>.active` | Written for every session (pushes on or off) when a turn starts, and removed when it ends with no background work left running, so `/notify_me` can find working sessions. JSON: start time, transcript path, desktop record ID, folder and title. One left behind by an interrupted turn is removed the next time `/notify_me` checks it. |
| `~/.claude/phone-bridge/flags/<session-id>.question-pushed` | Present briefly after a ❓ push succeeds, so the question dialog's duplicate permission push can be skipped. |
| `~/.claude/phone-bridge/flags/<session-id>.report-turn` | Present while the session's current turn was started by another session's report, so it sends no ⏳ or ✅ push. |
| `~/.claude/phone-bridge/flags/<session-id>.started` | Present for a few seconds after a phone launcher session's first prompt: its prompt and desktop record ID, for the background 🚀 push. |
| `~/.claude/phone-bridge/presence.json` | Written by the presence watcher every 5 seconds, and within a second of new input after an idle spell: when you last touched the real keyboard or mouse. |
| `~/.claude/phone-bridge/listener.json` | Written by the listener at least every 50 seconds: its heartbeat, process ID and `offset`, the next Telegram update to read, so a restart doesn't replay old commands or taps. |
| `~/.claude/phone-bridge/snooze.json` | Present after a `/snooze` tap: `{"until": <epoch seconds>}`. Until then every push is sent with Telegram's `disable_notification`. End snooze deletes it; an expired one is ignored and replaced by the next snooze. |
| `~/.claude/phone-bridge/messages/<key>.jsonl` | One line per push sent for a session, `{"id": <message_id>, "sent": <epoch seconds>}`, keyed by its desktop record ID (`local_…`), or its Claude Code session ID outside the app. Deleted once the session's pushes are cleared after archiving, or once every push in it is over 48 hours old. `python notify/cleanup.py --list` shows them. |
| `~/.claude/phone-bridge/markers/` | Markers the phone launcher writes just before it presses Enter, waiting for the hook; removed when matched, on failure, or once expired. |
| `~/.claude/phone-bridge/launcher.log` | The launcher's last 300 lines: each command's outcome, each launch step, the quiet-PC wait, the screen state and each reply. Never the prompt's text or the token. Test runs are marked `test`. |
| `~/.claude/phone-bridge/launcher-pending.json` | Commands waiting on a "Did you mean …?" tap (with their prompt), each removed when tapped, or ignored once 10 minutes old. |
| `~/.claude/phone-bridge/launcher-cache/` | `launcher/launch_steps.ps1`'s window helpers, compiled from C# on the first launch and reused after that (compiling on every launch failed now and then). Safe to delete; the next launch rebuilds it. |
| `%APPDATA%\Claude\claude-code-sessions\…\local_<id>.json` | Read only: the desktop app's record of each session (its title, the Claude Code session it runs, the session that started it). The Store version of the app keeps it under `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude`. |
| The app's `ccd-session-presets.json` | Read only: the saved environments' names. The app is a Store app, so the real file is under `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\`. |

Everything under `~/.claude/phone-bridge/` is state the tool rewrites; `~/.claude/phone-bridge.json` is the only file of yours.

### The Pieces

- **Sending:** every push goes through `push()` in the hook, which reads `~/.claude/phone-bridge.json` each time and makes one `sendMessage` call to the Bot API: HTML formatting with everything escaped, the session link on the last line, link previews off, 2 seconds to connect to each of Telegram's addresses before trying the next (about 1 in 4 attempts hangs on the first one), and 10 seconds for the reply. If Telegram can't read the formatting it resends once as plain text, and if it asks to slow down for 3 seconds or less it waits and retries once. The message is cut to 500 characters as a last guard (each kind's own format stays well under it), the result is logged, and a failure never stops Claude Code. While `~/.claude/phone-bridge/snooze.json` holds an end time still to come, the call adds `disable_notification` (no sound, no banner) and the log line says `silent: snoozed`, as in `push  -> ok message_id=14 (done push, silent: snoozed, 0.52s)`.
- **Session record:** the desktop app passes each session's record ID to Claude Code in `CLAUDE_CODE_HOST_SESSION_ID`, and every hook reads that record for the push title and the session link. Anything a session runs inherits the variable, so a `claude` started by a session (a test or script) finds a record that runs a different session ID; the hook ignores it completely and logs "ignored: claude run by another session". A script can strip that variable, so on Windows the hook also walks its process's ancestors and ignores any `claude` that has another Claude Code `claude.exe` above it (the desktop app's own `Claude.exe` doesn't count). That includes any other app a session launched that runs its own `claude`, so start such an app yourself for sessions you want pushes from. One gap: Git Bash can leave holes in the process tree (for example a command piped through `timeout`), and a run started that way that also strips the variable can still push.
- **UserPromptSubmit** checks whether each prompt ends with the phrase and writes or deletes the session's flag file. Without the phrase, a session another session started (the record's `spawnedFrom`) takes on that session's flag for its first prompt, and any later prompt in any session turns it on if you're away from the PC (unless a program drives the `claude`, see below). The brief itself never runs the away check: the starting session writes it, often a minute or more after your last input, so a brief from a session with pushes off leaves them off. That first prompt (the brief, which opens with "Background (from the session that started this one):") can arrive before the app has written `spawnedFrom` into the new record, so for a brief the hook rereads the record for up to 10 seconds; the log line then ends with "(session record ready after 1.5s)", or "(session record not ready after 10.0s)" if it never arrived. A record caught while the app rewrites it reads as broken JSON and is read again. Prompts the app generates itself (background-task results, subagent hand-backs, messages from other sessions) are ignored, so they can't switch notifications off mid-task. A report from another session (`<side-sessions-event>`, or a message from another session) marks the turn as a report turn; a subagent hand-back arrives in the same "Another Claude session sent a message" wrapper but is marked `[Subagent hand-back]`, so it doesn't, and it or a background-task result clears an earlier report-turn mark.
- **Programs that drive `claude`:** a `claude` whose `CLAUDE_CODE_ENTRYPOINT` starts with `sdk` (the Agent SDK sets `sdk-ts`, `claude -p` gives `sdk-cli`) is driven by a program, so its prompts never count as "away" (`driven_by_program`, checked ahead of the away rule). Ending a prompt with "notify me" still turns pushes on.
- **PreToolUse** (`AskUserQuestion`) and **Notification** (`permission_prompt`, `elicitation_dialog`) push when the flag is on. A Notification saying "permission to use AskUserQuestion" is skipped only if the latest question's push succeeded; if it failed, that permission push is the alert.
- **Stop** sends nothing for a report turn, or for a turn where `start_session` or `hand_off_to_session` actually started a session (a proposal card doesn't count). It also sends nothing when a prompt is still queued: a background task's or subagent's result, or a message you sent, that arrived before the turn ended but that Claude hasn't taken in yet (a `queue-operation` "enqueue" in the transcript with no matching "dequeue" or "remove"; `prompts_queued` in `notify/sessions.py`). That prompt starts the next turn at once, and that turn's Stop pushes; without this check, a subagent finishing a second before the turn ended got a ✅ push while the session kept working. Otherwise it reads the session transcript. If any background work has no matching completion message yet, it's a ⏳ pause (sent only when `waiting_pushes` is on); otherwise it's ✅ done. It replays the task list (`update_plan` in the desktop app, `TodoWrite` in the terminal) and takes the turn's latest `wrap_up` recap and question for the push body. That includes work started before your latest prompt, so a "notify me" sent while a task is already running waits for it. A task Claude stops itself (with `TaskStop`) never sends a completion message, so it counts as finished, and so does any task started more than 24 hours ago (quitting the app kills running tasks without a completion message). Servers and watchers Claude leaves running (`python -m http.server`, `npm run dev`, or a task described as starting a server, daemon or watcher, or as serving something) are ignored, since they never finish; jobs like "Watch for…" or "Wait for…" that end on their own still count.
- **Activity tracking** (`notify/sessions.py`, shared by the hook and the listener): every UserPromptSubmit, the app's own prompts included, writes the session's `.active` marker, and Stop removes it unless background work is still running. Stop hooks don't run when you interrupt a turn, so a marker alone can't say a turn is still going; the transcript decides. A turn starts with a prompt and ends with the Stop hooks' `stop_hook_summary` entry, an `[Request interrupted by user]` prompt, or an API error message; slash-command output written as a prompt doesn't count. A turn whose transcript hasn't changed for 2 hours counts as ended (quitting the app mid-turn leaves it open). The desktop record's own fields (`lastActivityAt`, `lastTurnEdgeAt`, `completedTurns`) can't tell a running turn from a finished one: `lastActivityAt` stays put for minutes while a turn works, and `lastTurnEdgeAt` moves at both the start and the end of a turn. `python notify/sessions.py --active` prints what `/notify_me` would see. Sessions are found from the markers plus the desktop records changed in the last 6 hours (for turns that started before the hook wrote markers), and archived sessions are left out. A session another session started (the record's `spawnedFrom`) is folded into the topmost session that started it.
- **Telegram listener** (`core/listener.py`): the one program that reads the bot's incoming messages, since Telegram lets only one program poll a bot at a time (a second gets HTTP 409 Conflict, and each would swallow the other's messages). It long-polls `getUpdates` 50 seconds at a time, saving the next update's offset before handling each one; reads `~/.claude/phone-bridge.json` on every loop; ignores everything not from your chat, and messages more than 10 minutes old; and runs one instance at a time (a named mutex, `Local\phone-bridge-listener`). `/notify_me` and taps run on worker threads, so a slow one never holds up the next. A tap's button carries `on:<session-id>`, and the listener checks again that the session is still active before writing its flag file (`all`). `/snooze` buttons carry `snooze:<hours>` (1, 4, 12 or 24) or `snooze:end`; a tap writes or deletes the snooze file, so an old `/snooze` message's buttons still work, counting from the tap. Until the config has both the token and the chat it doesn't poll, which leaves `install.py` free to read the bot's messages while it looks for your chat. It starts at sign-in from its Startup shortcut, and as a fallback every hook event checks its heartbeat and starts it if it's more than 150 seconds old.
- **Archiving** (`notify/archive.py`, `notify/archive_steps.ps1`): `/archive` reads the signed-in account's session records (the folder holding the most recently changed record; another account's sessions aren't in the sidebar) and checks each one that isn't archived against the transcript, as listed under Archiving Finished Sessions. It uses the same transcript readers as the hook and `/notify_me` but stricter: a turn counts as open however long it's been quiet (not just 2 hours), servers and watchers count as background work, and only an app restart (the start time of the app's main `claude.exe`) ends turns and background work that never reported back, instead of 2 and 24 hours. The app's own "is running" flag isn't used: it reads false while a session waits on background work. One record field is used: a session the sidebar shows under "Needs input" is left out, following the app's rules (checked in Claude desktop 3.6556): `postTurnSummary.status_category` is `blocked`, `need_input` or `failed`, `turnWrapUp.needsUser` is set, or `error` is set with `errorAt` in the last 7 days. A tap's button carries `archive:<local_… ID>`; Archive All carries `archive_all` and archives the sessions whose buttons are still on that message, in order, with the same steps as a tap (taps on that message meanwhile get "Archive All is still going"). The tap runs the checks again, then `archive_steps.ps1` (UI Automation, no keys or clicks) expands the sidebar row's "More options for <title>" button and invokes the menu's Archive item, cancelling any confirmation dialog the app shows. The tap succeeds once the record reads `isArchived`, within 10 seconds. Archives run one at a time. The app offers no other way to archive from outside: its `claude://` links only start or continue sessions, and it doesn't watch its record files for changes.
- **Clearing archived sessions' pushes** (`notify/cleanup.py`): after each successful send, `push()` appends the message ID to the session's file in `~/.claude/phone-bridge/messages/`, keyed by `CLAUDE_CODE_HOST_SESSION_ID` (for a 🚀 push, the record ID the `.started` file holds). The listener clears a session's file right after an `/archive` tap or Archive All archives it (or finds it already archived), and a thread sweeps every 180 seconds for files whose record reads `isArchived`, which catches sessions archived at the PC. Clearing sends `deleteMessages` in batches of 100 with only the pushes sent less than 47 hours 50 minutes ago, then deletes the file; if a call fails, the file stays and the next sweep tries again. The age cut matters: Telegram refuses to delete a message after 48 hours ("message can't be deleted for everyone"), and one such ID fails the whole batch, while IDs already deleted (by you, in the chat) are skipped without an error. A file whose pushes are all past that age is deleted by the sweep, so sessions outside the app, or deleted rather than archived, don't pile up. A session with no record, or a record that can't be read, is never treated as archived.
- **Commands from other programs (`telegram_commands`):** programs that take commands through the bot are entries in `~/.claude/phone-bridge.json` under `telegram_commands`, run by the listener, never by a poll loop of their own: `{"name": "start", "first_line": ["start a new session"], "run": ["<python>", "<handler.py>"], "timeout": 600}`. A `run` or `choices` program whose first item is a `.py` path relative to the tool, such as `"launcher/launch.py"`, runs with the listener's own Python from the tool's folder (`resolve_run` in `core/bridge.py`), so the config never says where the tool is; any other program runs as written. A message whose first line matches (ignoring case and a trailing full stop) runs that program with no window. An entry can also have a slash command: `"command": "new_session"` (lowercase letters, digits and underscores, as Telegram requires) and `"description"` put it in the bot's command menu ahead of `/notify_me` and `/snooze` (the listener updates the menu whenever the list changes), and a message starting with `/new_session`, with or without the bot's username attached, runs the program too. With `"ask"` (and optionally `"ask_placeholder"`, the grey text in the message box), a slash command or first line with nothing after it gets that question as a reply Telegram opens for you, and the next message you send within 10 minutes runs the program with `text` set to `/<command>` (or the first line) plus your answer on the next line. Any other message, or a reply to a different message, drops the question. The listener deletes the question once your next message arrives or the 10 minutes pass (and after a restart), because Telegram's iPhone app otherwise reopens a reply to it every time you open the chat; so your answer shows "Deleted message" where it quoted the question. `"first_line_match"` is a regex (whole first line, any case) that also matches, such as "Start a new session in Work"; such a line alone gets the `ask` question too, and the answer goes under that line. With `"choices"` (a program that prints `{"choices": [...]}`), `"choose"` (a question), `"choose_default"` and `"choice_line"` (such as `"Start a new session in {}"`), a bare slash command or exact first line first gets the `choose` question with one button for `choose_default` (the command as it is) and one per choice, two to a row. The buttons are `switch_inline_query_current_chat` buttons: a tap fills your message box with the bot's username, a space, the choice and a colon, and opens the keyboard, which a ForceReply question never does on Telegram's iPhone app. A message that starts with the bot's username (written the way a button writes it, ending in `bot`), then a label and a colon, runs the program with the rest of the message under `choice_line` (the label in place of `{}`), or under the bare command when the label is `choose_default`; the listener then writes "→ <label>" under the newest choice question and removes its buttons. The buttons work for as long as they're in the chat, with no state kept. With nothing after the colon, the `ask` question goes out with that line as its head. Taps on the callback buttons older versions sent get "Expired". With no choices (the program failed or printed none), it asks at once. With `"callback_prefix": "env"`, taps on buttons the program sent itself whose data starts with `env:` run the program with `chat_id`, `received_at` and `callback` (`id`, `data`, `message_id`, `text`) on its stdin; it answers the tap itself. The program runs with JSON on its stdin: `chat_id`, `message_id`, `date`, `received_at` and `text`. It never gets the token: it reads the config and sends its own replies. Runs of one command go one at a time in order, and never hold up `/notify_me`. Exit code 0 means it handled everything, including replying about its own failures; any other exit, a failure to start, or no exit within `timeout` seconds (default 600, then it's killed) gets a "Couldn't run <name> (…)" reply. Unlike `/notify_me`, these commands also get messages older than 10 minutes (Telegram keeps them for 24 hours), so the command can say it's too old. Rerunning `install.py` keeps these entries. The phone launcher is one: the installer adds its `start` entry (`run: ["launcher/launch.py"]`, `choices: ["launcher/launch.py", "--environments"]`, `timeout: 1800`), or takes it out when you install the notifications alone.
- **Phone launcher sessions:** just before it presses Enter in a new session, the phone launcher writes a marker holding the prompt in `~/.claude/phone-bridge/markers/`. On UserPromptSubmit, a prompt that matches an unexpired marker (line endings and outer spaces ignored) deletes it, turns pushes on (`all`) and starts `notify_hook.py --started <session>` in the background, which waits up to 20 seconds for the app to title the session and sends the 🚀 push. A test launch's marker (`"test": true`) turns that session's pushes off instead, so test launches never reach the phone. Expired markers are deleted on the way.
- **The launch itself** (`launcher/launch.py`, `launcher/launch_steps.ps1`):
  1. The listener runs `launch.py` hidden, with the message as JSON on stdin, for a message from your chat whose first line matches, or that starts with /new_session, one launch at a time. A /new_session with nothing after it gets the listener's question instead, and the answer runs as `/new_session` plus the answer on the next line.
  2. `launch.py` checks the message (your chat, its age, the prompt), then waits for a quiet PC: low-level keyboard and mouse hooks count every input event, real or simulated, without recording which keys. Before its own hooks start, it judges the last few seconds from the presence watcher. It doesn't use Windows' idle timer, which on some PCs resets every half second with no input.
  3. It **wakes the screens** (tells Windows the display is needed and makes a 0-pixel mouse move marked as its own) and logs whether they were on, off or dimmed.
  4. It writes the **marker** (`~/.claude/phone-bridge/markers/<id>.json`, the prompt and a 2-minute expiry) for the hook, then runs **`launch_steps.ps1`**, which drives the app through Windows UI Automation, finding controls by their accessible names:
     - opens `claude://code/new?q=<prompt>` and waits for the message box ("Prompt") to hold exactly the prompt;
     - sets the **Environment** picker to This computer and the **Folder** picker to No folder (the button then reads "Folder: Choose folder…"), or, for a named environment, the Environment picker to it (the picker shows the latest one and the rest under "More"), leaving the folder it brings; then the **Permissions** picker to the mode setting, checking each button's new name;
     - focuses the message box, and stops there to ask `launch.py` whether any input arrived since the launch began. Only with none, the box still focused and still holding exactly the prompt, it presses **Enter**;
     - confirms the new-session screen gave way to the session, then brings back the window that was in front before.

     Input during a launch makes it start over from the quiet-PC wait. Nothing else is typed or clicked.
  5. The hook sees the new session's first prompt, matches it to the marker, deletes the marker, turns pushes on for the session and, in the background, waits up to 20 seconds for the app to title the session and sends the "started" push.

  The prompt only ever goes into the URL-encoded `claude://` link, never to a shell. The bot token stays in `~/.claude/phone-bridge.json`; the launcher never prints or logs it.
- **Presence watcher** (`core/presence.py`, Windows): starts at Windows sign-in from its Startup shortcut, so it already knows whether you're at the PC when Claude opens. As a fallback, every hook event checks that it's running and starts it in the background if not. It watches keyboard and mouse input through low-level hooks and skips events Windows flags as injected. It records timestamps only, never which keys, and runs one instance at a time (a named mutex, `Local\phone-bridge-presence`). Windows' own idle timer isn't used: it counts injected input, and on some PCs other software resets it constantly. If the watcher isn't running (for example, its shortcut was removed and this is the first message since sign-in), the hook can't tell where the message came from, so it counts as sent while away: a phone message still gets its pushes, and a message typed at the PC may get one extra.
- **Background programs** (the listener, the presence watcher, the 🚀 push) start from `~/.claude` as their working folder, not the tool's folder: a running program's working folder can't be moved or renamed on Windows, so a `git pull` or a move of the clone would fail.

### Changing the Code

The tool's own `CLAUDE.md` ([CLAUDE.md](CLAUDE.md)) holds what a session changing the code needs to know. `python tests/test_phone_bridge.py` runs the offline test suite: the launcher's command parser, the listener's routing of /new_session and its question, the age, length and chat checks, the conversation with the steps script, the hook's marker handling and started push, the waiting-push setting, the core, and the installer. It moves HOME and USERPROFILE to a temporary folder before importing anything, so it touches no real files, Telegram or windows.

`python launcher/launch.py --test "<prompt>" [--env NAME] [--quiet SECONDS]` runs a real launch from the command line, in the named environment with `--env`. Replies go to the console and the log instead of Telegram, and the marker is a test one, so the hook keeps the new session's pushes **off**. `--quiet` makes it wait longer for a quiet PC, for tests run while someone may be using it.

## Updating

Read the [changes](#changes) first for anything that needs you to do something. Each version is also on the repo's [releases page](https://github.com/masfew/toolbox/releases), tagged `phone-bridge-v<version>`, with its notes and a zip of this folder.

From the root of the cloned repo, pull the new version, then rerun the install (PowerShell):

```powershell
git pull
cd extensions\phone-bridge
python install.py
```

The saved token and chat are reused, so it doesn't ask for them. It asks again whether to install the phone launcher unless you pass `--features notify` or `--features notify,launcher`. It stops the running listener and presence watcher and starts them again, and keeps your settings, including the launcher's. Fully quit and reopen Claude Code afterwards, since sessions that were already open keep the hooks they started with.

To stay on a version, check out its tag instead, then rerun the install (PowerShell):

```powershell
git fetch --tags
git checkout phone-bridge-v1.0.0
cd extensions\phone-bridge
python install.py
```

Releases up to phone-bridge-v1.0.0 have the tool's folder in `hooks\phone-bridge`, so after checking out one of those, it's `cd hooks\phone-bridge` instead.

This moves the whole clone, so every other tool in it goes back to that point too. To return to the latest version, run `git checkout main` and `git pull`, then rerun the install. To keep this tool on one version without moving the others, download its zip from the release instead, unzip it, and run `python install.py` from the `phone-bridge` folder inside it. The install copies the tool to `~/.claude/tools/phone-bridge`, so the unzipped folder can be deleted afterwards.

If the tool's folder moves or is renamed, the install keeps working as it is. Rerunning `python install.py` from the new folder points `~/.claude/tools/phone-bridge` there and takes out anything stale.

## Uninstall

From the tool's folder (PowerShell):

```powershell
python install.py --remove
```

If you installed from a release zip and deleted the unzipped folder, run the same command from `~/.claude/tools/phone-bridge` instead.

This stops the listener and the presence watcher, and removes the four hooks from `~/.claude/settings.json` (after backing it up), the two Startup shortcuts, `~/.claude/tools/phone-bridge` and its install record. It leaves `~/.claude/phone-bridge.json`, which holds your bot token and chat ID, and says where it is; delete it yourself if you don't need it, and send `/revoke` to @BotFather to retire the token (or `/deletebot` to delete the bot). It also leaves the logs and state under `~/.claude/phone-bridge/`, which you can delete. Fully quit and reopen Claude Code afterwards. The Siri contact and Shortcut on your iPhone stay until you delete them.

## Troubleshooting

Some commands in the tool's folder show what the tool sees (PowerShell):

| Command | What it shows |
|---|---|
| `python notify/archive.py --list` | What `/archive` would list, and why each other session isn't on it |
| `python notify/sessions.py --active` | What `/notify_me` would see |
| `python notify/cleanup.py --list` | The stored push IDs |
| `python launcher/launch.py --environments` | The saved environments' names, as the listener gets them for its buttons |
| `python install.py --test` | Sends one message to the bot (and reruns the install) |

| Problem | Cause | Fix |
|---|---|---|
| No push arrives | The hook didn't send, or Telegram rejected it | Look for `push` lines in `~/.claude/phone-bridge/phone-bridge.log`. An `-> ok` line (with a `message_id` from Telegram) means Telegram accepted it, so the problem is on the phone. No line at all means the hook didn't push: check the session's flag file in `~/.claude/phone-bridge/flags/` and its per-prompt log line. Telegram keeps no list of the messages a bot has sent, so the log is the record |
| Pushes arrive in the chat but make no banner (iPhone) | Notification settings on the phone | Check Settings → Notifications → Telegram allows banners and uses Immediate delivery, not Scheduled Summary; in Telegram, Settings → Notifications and Sounds → Private Chats is on; the bot's chat isn't muted; and no Focus mode is blocking Telegram. Don't keep Telegram open on the PC: while you're active in Telegram on another device, it likely holds back phone notifications (not tested) |
| A message typed at the PC pushes, or a phone message doesn't | The presence watcher isn't running, or "notify me" is missing | `~/.claude/phone-bridge/presence.json` should have a `heartbeat` from the last few seconds (`last_real_input` is `null` until you touch the real keyboard or mouse after it starts). If it's stale, the next hook event starts it again, or rerun `install.py`. Add "notify me" to a phone message sent while you're also using the PC |
| `failed: HTTP 401` in the log | The token is wrong or was revoked | Get a new one with `/revoke` in @BotFather, delete `telegram_token` from `~/.claude/phone-bridge.json` (otherwise the installer reuses the old one), and rerun `install.py` in your own terminal |
| `failed: HTTP 403 Forbidden: bot was blocked by the user` or `failed: HTTP 400 Bad Request: chat not found` | The bot can't message you, because you blocked it or the chat ID is wrong | Unblock it, delete `telegram_chat_id` from the config, send the bot a message, and rerun `install.py` |
| A slow send | About 1 in 4 sends take about 2.5 s, because the first connection attempt hung and was given up after 2 s | Nothing: they still arrive. A send counts as failed only if no address connects, or Telegram doesn't answer within 10 s; the log then shows just the error's type, such as `failed: TimeoutError` |
| `/notify_me` (or any command) gets no reply | The listener isn't running, or another program is reading the bot | Check that `~/.claude/phone-bridge/listener.json` has a `heartbeat` from the last minute or so. If not, run `pythonw "$HOME\.claude\tools\phone-bridge\core\listener.py"` (or wait for the next hook event, which starts it). If it's running, look for `telegram` lines in `~/.claude/phone-bridge/phone-bridge.log`: `getUpdates failed: HTTP 409` means another program is reading the bot's messages (a second PC running this listener, or a tool polling the bot itself); stop that one |
| `/notify_me` leaves out a session that's working | Its turn started before this version of the hook was installed, or it isn't in the desktop app | Run `python notify/sessions.py --active` in the tool's folder. A session whose turn started before the hook was installed is found only if its desktop record changed in the last 6 hours; a session outside the desktop app only once it gets a new prompt |
| `/archive` lists nothing, or a session you expect is missing | Something about the session is still going, or the app changed | Run `python notify/archive.py --list` for the reason per session. After a Claude desktop app update, the app's records or sidebar may have changed (see the note under [Requirements](#requirements)) |
| /new_session: no reply and no session | The listener isn't running, or the launch failed | Check the listener is running (`~/.claude/phone-bridge/listener.json` has a recent `heartbeat`) and that `~/.claude/phone-bridge/phone-bridge.log` has a `telegram  -> start: exit 0` line. Then read `~/.claude/phone-bridge/launcher.log` |
| "Couldn't start: couldn't find the … button" or "… didn't stick" | The app changed its pickers | The log line names the step and what the button read; update the names in `launcher/launch_steps.ps1` |
| "Couldn't start: the launch script stopped early" | The steps script died partway through a launch | The log's `steps script ended with exit …` line holds the script's first error. A script that dies before its first step (while loading its helpers) is retried automatically, so this reply means it died partway through a launch |
| No "started" push after /new_session | The session's first prompt didn't match the launcher's marker (for example the app changed the prompt's line breaks) | Look for `pushes on (all): phone launcher` in `~/.claude/phone-bridge/phone-bridge.log`. Without it, the marker didn't match |
| `FAILED: no telegram_token ... Run this in a terminal` | The installer has no token yet and no terminal to ask in (for example when Claude Code ran it) | Run `python install.py` in your own PowerShell window and paste the token when it asks |
| `FAILED: Telegram refused the token` | The token is wrong or was revoked | Copy it again from BotFather (or `/revoke` for a new one), then rerun. Nothing was changed |
| `FAILED: no message reached the bot` | The installer waited 3 minutes and found no private message to the bot | Open the bot's chat, send it any message (tapping Start alone may not reach it), then rerun `install.py` |
| `FAILED: the bot has a webhook set` | A webhook stops `getUpdates`, which is how the listener reads your commands | Remove it with the Bot API's `deleteWebhook` method, then rerun. Only checked when installing the launcher |
| `FAILED: the phone launcher runs on Windows with the Claude desktop app only` | `--features notify,launcher` on another system | Use `--features notify` |
| `FAILED: the phone launcher needs the notifications` | `--features launcher` alone | Use `--features notify,launcher` |

## License

MIT. See the [LICENSE](https://github.com/masfew/toolbox/blob/main/LICENSE) file at the root of the repo.

## Changes

- 1.0.0: First public release.
