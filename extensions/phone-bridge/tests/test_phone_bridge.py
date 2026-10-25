#!/usr/bin/env python3
"""
Offline tests for phone-bridge: the core, the listener's routing, the phone
launcher and its hand-off to the notification hook, and the installer's
choices. They touch no Telegram, no Claude window and none of your real files:
the home folder itself is moved to a temporary folder before anything loads.
Run: python tests/test_phone_bridge.py
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

# Before any of the tool's modules load, so every path they build is in here.
FAKE_HOME = tempfile.TemporaryDirectory(prefix="phone-bridge-test-")
os.environ["HOME"] = os.environ["USERPROFILE"] = FAKE_HOME.name
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from core import bridge  # noqa: E402
from launcher import launch  # noqa: E402

assert str(bridge.CLAUDE_DIR).startswith(FAKE_HOME.name), "the tests must never see the real home folder"


def load_hook():
    from notify import notify_hook
    return notify_hook


def load_install():
    spec = importlib.util.spec_from_file_location("phone_bridge_install_under_test", ROOT / "install.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Parse(unittest.TestCase):
    def test_start_command_with_prompt(self):
        self.assertEqual(launch.parse("Start a new session\nFix the login bug"), ("Fix the login bug", None))

    def test_any_case_and_full_stop(self):
        for first in ("start a new session.", "START A NEW SESSION", "New session", "new session."):
            self.assertEqual(launch.parse(f"{first}\nhello")[0], "hello", first)

    def test_line_breaks_kept(self):
        prompt, _ = launch.parse("Start a new session\nLine one\n\nLine three\r\nLine four")
        self.assertEqual(prompt, "Line one\n\nLine three\nLine four")

    def test_no_prompt(self):
        for text in ("Start a new session", "Start a new session\n   \n"):
            self.assertEqual(launch.parse(text), (None, "Add your prompt on the line under Start a new session."))

    def test_not_a_start_command(self):
        self.assertIsNone(launch.parse("Start a new session please\nhi")[0])
        self.assertIsNone(launch.parse("hello")[0])

    def test_listener_lines_match_the_parser(self):
        for line in launch.COMMAND_LINES:
            self.assertEqual(launch.parse(f"{line}\nx")[0], "x")

    def test_slash_command(self):
        self.assertEqual(launch.parse("/new_session Fix the login bug"), ("Fix the login bug", None))
        self.assertEqual(launch.parse("/New_Session\x40MyClaudeBot\nLine one\n\nLine three")[0], "Line one\n\nLine three")
        self.assertEqual(launch.parse("/new_session first\nsecond")[0], "first\nsecond")

    def test_siri_shortcut_message(self):
        # The Shortcut sends "/new_session " plus the dictated text, on one line.
        self.assertEqual(launch.parse("/new_session Check the build logs."), ("Check the build logs.", None))

    def test_siri_contact(self):
        install = load_install()
        self.assertEqual(install.siri_contact("123456789:AAbbCC-dd"), ("123456789", "https://t.me/\x40id123456789"))
        self.assertIsNone(install.siri_contact("not-a-token"))

    def test_slash_command_without_prompt(self):
        self.assertEqual(launch.parse("/new_session  "), (None, "Add your prompt after /new_session."))
        self.assertIsNone(launch.parse("/new_sessions hi")[0])

    def test_environment_in_the_first_line(self):
        self.assertEqual(launch.parse("Start a new session in Work\nFix it"), ("Fix it", None))
        self.assertEqual(launch.environment_name("Start a new session in Work\nFix it"), "Work")
        self.assertEqual(launch.environment_name("new session in Client Site 1.1.\nx"), "Client Site 1.1")
        self.assertIsNone(launch.environment_name("Start a new session\nin Work"))
        self.assertIsNone(launch.environment_name("/new_session in Work fix it"))
        self.assertEqual(launch.parse("Start a new session in Work"),
                         (None, "Add your prompt on the line under Start a new session."))

    def test_listener_pattern_matches_the_parser(self):
        import re
        for line in ("Start a new session in Work", "new session in Design Review.", "Start a new session"):
            self.assertTrue(re.fullmatch(launch.FIRST_LINE_MATCH, line, re.IGNORECASE), line)
            self.assertIsNotNone(launch.parse(line + "\nx")[0], line)
        self.assertEqual(launch.environment_name(launch.CHOICE_LINE.format("Home Lab") + "\nx"), "Home Lab")


class Environments(unittest.TestCase):
    NAMES = ["Work", "Client Site 1.1", "Client Site 2.2.2", "Design Review", "Home Lab"]

    def test_exact_ignoring_case(self):
        self.assertEqual(launch.resolve("work", self.NAMES, {}), ("exact", "Work"))
        self.assertEqual(launch.resolve("home lab", self.NAMES, {}), ("exact", "Home Lab"))

    def test_nickname(self):
        self.assertEqual(launch.resolve("CS", self.NAMES, {"cs": "Client Site 1.1"}), ("exact", "Client Site 1.1"))
        self.assertEqual(launch.resolve("x", self.NAMES, {"x": "Not saved"}), ("none", None))

    def test_close(self):
        self.assertEqual(launch.resolve("Wrk", self.NAMES, {}), ("close", "Work"))
        self.assertEqual(launch.resolve("Design", self.NAMES, {}), ("close", "Design Review"))
        self.assertEqual(launch.resolve("Client Site 1.2", self.NAMES, {})[0], "close")

    def test_none(self):
        self.assertEqual(launch.resolve("Garden", self.NAMES, {}), ("none", None))

    def test_read_from_the_apps_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp) / "Packages" / "Claude_abc" / "LocalCache" / "Roaming" / "Claude"
            folder.mkdir(parents=True)
            (folder / "ccd-session-presets.json").write_text(json.dumps({"byAccount": {
                "a": {"presets": [{"name": "Old", "lastUsedAt": 1}, {"name": "Work", "lastUsedAt": 9}]},
                "b": {"presets": [{"name": "Work", "lastUsedAt": 5}, {"name": "Mid", "lastUsedAt": 4}]}}}))
            with mock.patch.dict(os.environ, {"LOCALAPPDATA": tmp, "APPDATA": str(Path(tmp) / "none")}):
                self.assertEqual(launch.environments(), ["Work", "Mid", "Old"])
            with mock.patch.dict(os.environ, {"LOCALAPPDATA": str(Path(tmp) / "none"), "APPDATA": str(Path(tmp) / "none")}):
                self.assertIsNone(launch.environments())


def load_listener():
    from core import listener
    return listener


class Listener(unittest.TestCase):
    """The listener routing the launcher's commands, with Telegram replaced."""

    ENTRY = {"name": "start", "first_line": list(launch.COMMAND_LINES), "command": launch.SLASH_COMMAND,
             "description": "Start a new Claude session on the PC", "ask": "What should the new session do?",
             "ask_placeholder": "Your prompt", "run": ["python", "launch.py"]}

    def setUp(self):
        self.tc = load_listener()
        self.config = {"telegram_token": "x", "telegram_chat_id": 42, "telegram_commands": [self.ENTRY]}
        self.queued, self.sent, self.deleted, self.ids = [], [], [], iter([])
        self.tmp = tempfile.TemporaryDirectory()
        self.patches = [
            mock.patch.object(self.tc, "queue_external", self.fake_queue),
            mock.patch.object(self.tc.workers, "submit", lambda fn, *a: fn(*a)),
            mock.patch.object(self.tc, "call", self.fake_call),
            mock.patch.object(self.tc, "note", lambda *a: None),
            mock.patch.object(self.tc, "sessions_without_pushes", lambda: []),
            mock.patch.object(self.tc, "STATE_FILE", Path(self.tmp.name) / "listener.json"),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def fake_queue(self, command, message, tap=None):
        self.queued.append((command["name"], tap["data"] if tap else message["text"]))

    def fake_call(self, config, method, body):
        if method == "deleteMessage":
            self.deleted.append(body["message_id"])
            return {"ok": True, "result": True}
        self.sent.append(body)
        return {"ok": True, "result": {"message_id": next(self.ids, 500)}}

    def send(self, text, age=0, reply_to=None):
        message = {"message_id": 7, "chat": {"id": 42}, "date": time.time() - age, "text": text}
        if reply_to:
            message["reply_to_message"] = {"message_id": reply_to}
        self.tc.dispatch({"message": message}, self.config)

    def ask(self):
        """Gets the bot to ask "What should the new session do?" (id 500)."""
        self.send("/new_session")

    def test_command_with_prompt_runs_at_once(self):
        self.send("/new_session Fix the bug")
        self.send("/new_session\x40MyClaudeBot\nLine one")
        self.send("Start a new session\nhi")
        self.assertEqual([t for _, t in self.queued], ["/new_session Fix the bug", "/new_session\x40MyClaudeBot\nLine one",
                                                       "Start a new session\nhi"])
        self.assertEqual(self.sent, [])

    def test_command_alone_asks_then_the_answer_runs_it(self):
        self.send("/new_session")
        self.assertEqual(self.sent[0]["text"], "What should the new session do?")
        self.assertEqual(self.sent[0]["reply_markup"], {"force_reply": True, "input_field_placeholder": "Your prompt"})
        self.send("Fix the bug\nand test it", reply_to=500)
        self.assertEqual(self.queued, [("start", "/new_session\nFix the bug\nand test it")])
        self.assertEqual(launch.parse(self.queued[0][1])[0], "Fix the bug\nand test it")

    def test_answer_without_reply_counts(self):
        self.send("/new_session")
        self.send("Fix the bug")
        self.assertEqual(self.queued, [("start", "/new_session\nFix the bug")])

    def test_only_the_next_message_answers(self):
        self.send("/new_session")
        self.send("/notify_me")
        self.send("Fix the bug")
        self.assertEqual(self.queued, [])
        self.assertTrue(self.sent[-1]["text"].startswith("I know these commands"))

    def test_reply_to_another_message_doesnt_answer(self):
        self.send("/new_session")
        self.send("Fix the bug", reply_to=123)
        self.assertEqual(self.queued, [])

    def test_question_expires(self):
        self.send("/new_session")
        with mock.patch.object(self.tc.time, "time", return_value=time.time() + self.tc.ASK_SECONDS + 1):
            self.send("Fix the bug", age=-self.tc.ASK_SECONDS - 1)
        self.assertEqual(self.queued, [])

    def test_old_command_alone_gets_no_question(self):
        self.send("/new_session", age=self.tc.MAX_MESSAGE_AGE + 60)
        self.assertEqual((self.sent, self.queued), ([], []))

    def test_menu_and_hint(self):
        self.assertEqual([c["command"] for c in self.tc.menu_commands(self.config)], ["new_session", "notify_me", "snooze", "archive"])
        self.send("hello")
        self.assertEqual(self.sent[-1]["text"], "I know these commands: /new_session, /notify_me, /snooze, /archive")

    # Telegram's iPhone app reopens a reply to the newest ForceReply question
    # every time the chat opens, until that question is deleted.
    def test_answered_question_is_deleted(self):
        self.ask()
        self.assertEqual(self.deleted, [])
        self.send("Fix the bug", reply_to=500)
        self.assertEqual(self.deleted, [500])

    def test_question_used_up_by_another_message_is_deleted(self):
        self.ask()
        self.send("/notify_me")
        self.assertEqual((self.queued, self.deleted), ([], [500]))
        self.send("hello")
        self.assertEqual(self.deleted, [500])

    def test_unanswered_question_is_deleted_when_it_expires(self):
        self.ask()
        self.tc.expire_question(self.config)
        self.assertEqual(self.deleted, [])
        with mock.patch.object(self.tc.time, "time", return_value=time.time() + self.tc.ASK_SECONDS + 1):
            self.tc.expire_question(self.config)
        self.assertEqual(self.deleted, [500])
        self.send("Fix the bug")
        self.assertEqual((self.queued, self.deleted), ([], [500]))

    def test_question_used_up_while_being_sent_is_deleted(self):
        waiting = {"command": self.ENTRY, "head": None, "message_id": None, "expires": time.time() + 60}
        self.tc.handle_ask(self.config, waiting, {"message_id": 7})  # awaiting already moved on
        self.assertEqual(self.deleted, [500])

    def test_state_file_keeps_the_open_question_for_a_restart(self):
        self.ask()
        self.assertEqual(self.tc.saved_state("question"), 500)
        self.send("Fix the bug")
        self.tc.save_state(9)
        self.assertEqual((self.tc.saved_state("question"), self.tc.saved_state("offset")), (None, 9))
        self.tc.save_state()
        self.assertEqual(self.tc.saved_state("offset"), 9)


class ListenerEnvironments(Listener):
    """The listener with the launcher's full entry: environment buttons and taps."""

    ENTRY = {**Listener.ENTRY, "first_line_match": launch.FIRST_LINE_MATCH, "choose": "Where should the new session run?",
             "choose_default": "No folder", "choices": ["python", "launch.py", "--environments"],
             "choice_line": launch.CHOICE_LINE, "callback_prefix": "env"}

    def setUp(self):
        super().setUp()
        self.choices = ["Work", "Home Lab"]
        p = mock.patch.object(self.tc, "get_choices", lambda command: list(self.choices))
        p.start()
        self.patches.append(p)

    def ask(self):
        self.send("/new_session")
        self.send("\x40my_claude_bot No folder: ")

    def tap(self, data, question=500, chat=42):
        self.tc.dispatch({"callback_query": {"id": "q1", "data": data, "message": {
            "message_id": question, "chat": {"id": chat}, "text": "Where should the new session run?"}}}, self.config)

    # The buttons fill the message box with "@<bot> <choice>: " and open the
    # keyboard; the message sent from it carries the choice.
    def test_buttons_fill_the_message_box(self):
        self.send("Start a new session")
        self.assertEqual(self.sent[0]["text"], "Where should the new session run?")
        rows = self.sent[0]["reply_markup"]["inline_keyboard"]
        self.assertEqual([[b["text"] for b in row] for row in rows], [["No folder", "Work"], ["Home Lab"]])
        self.assertEqual([b["switch_inline_query_current_chat"] for row in rows for b in row],
                         ["No folder: ", "Work: ", "Home Lab: "])
        self.assertFalse(any("callback_data" in b for row in rows for b in row))

    def test_filled_message_runs_it_and_marks_the_choice(self):
        self.send("/new_session")
        self.send("\x40my_claude_bot Home Lab: Fix the bug: the one in shop.py\nand test it")
        text = self.queued[0][1]
        self.assertEqual((launch.environment_name(text), launch.parse(text)[0]),
                         ("Home Lab", "Fix the bug: the one in shop.py\nand test it"))
        self.assertEqual(self.sent[-1], {"chat_id": 42, "message_id": 500,
                                         "text": "Where should the new session run?\n→ Home Lab"})

    def test_filled_default_runs_the_bare_command(self):
        self.send("/new_session")
        self.send("\x40My_Claude_Bot   no folder:Fix the bug")
        self.assertEqual(self.queued, [("start", "/new_session\nFix the bug")])
        self.assertEqual(launch.parse(self.queued[0][1]), ("Fix the bug", None))

    def test_filled_message_from_older_buttons_still_runs(self):
        self.send("\x40my_claude_bot Work: Fix the bug", age=3600)
        self.assertEqual(self.queued, [("start", "Start a new session in Work\nFix the bug")])
        self.assertEqual(self.sent, [])  # no question to mark, and the launcher says what's too old

    def test_filled_with_nothing_after_it_asks(self):
        self.send("/new_session")
        self.send("\x40my_claude_bot Work: ")
        self.assertEqual(self.sent[-1]["text"], "What should the new session do?")
        self.send("Fix the bug")
        self.assertEqual(self.queued, [("start", "Start a new session in Work\nFix the bug")])
        self.ask()
        self.send("Fix it")
        self.assertEqual(self.queued[-1], ("start", "/new_session\nFix it"))

    def test_command_alone_asks_then_the_answer_runs_it(self):
        self.ask()
        self.send("Fix the bug\nand test it", reply_to=500)
        self.assertEqual(self.queued, [("start", "/new_session\nFix the bug\nand test it")])

    def test_answer_without_reply_counts(self):
        self.ask()
        self.send("Fix the bug")
        self.assertEqual(self.queued, [("start", "/new_session\nFix the bug")])

    def test_other_mentions_are_not_choices(self):
        self.send("\x40someone Work: Fix the bug")
        self.assertEqual(self.queued, [])
        self.assertTrue(self.sent[-1]["text"].startswith("I know these commands"))

    def test_taps_on_old_callback_buttons_expire(self):
        self.tap("pick:1")
        self.assertEqual(self.sent[-1]["text"], "Where should the new session run?\nExpired. Send the command again.")

    def test_no_choices_asks_at_once(self):
        self.choices = []
        self.send("/new_session")
        self.assertEqual(self.sent[0]["text"], "What should the new session do?")
        self.send("Fix the bug")
        self.assertEqual(self.queued, [("start", "/new_session\nFix the bug")])

    def test_named_environment_alone_asks_for_the_prompt(self):
        self.send("Start a new session in Work")
        self.assertEqual(self.sent[0]["text"], "What should the new session do?")
        self.send("Fix the bug")
        self.assertEqual(self.queued, [("start", "Start a new session in Work\nFix the bug")])

    def test_named_environment_with_prompt_runs_at_once(self):
        self.send("Start a new session in Wrk\nFix the bug")
        self.assertEqual(self.queued, [("start", "Start a new session in Wrk\nFix the bug")])

    def test_filled_message_deletes_the_open_question(self):
        self.ids = iter([600, 0, 601])  # buttons, the edit, question
        self.send("/new_session")
        self.send("\x40my_claude_bot Work:")
        self.assertEqual(self.sent[-1]["text"], "What should the new session do?")
        self.send("\x40my_claude_bot Home Lab: Fix the bug")
        self.assertEqual(self.deleted, [601])
        self.assertEqual(self.queued, [("start", "Start a new session in Home Lab\nFix the bug")])

    def test_did_you_mean_taps_go_to_the_launcher(self):
        self.tap("env:ab12cd34:y", question=900)
        self.tap("env:ab12cd34:n", question=900, chat=99)
        self.tap("other:1", question=900)
        self.assertEqual(self.queued, [("start", "env:ab12cd34:y")])


class Taps(unittest.TestCase):
    """The launcher's side of "Did you mean ...?": the question, and the taps."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        config = root / "phone-bridge.json"
        config.write_text(json.dumps({"telegram_token": "x", "telegram_chat_id": 42}))
        self.calls, self.launches = [], []
        self.patches = [
            mock.patch.object(bridge, "CONFIG_FILE", config),
            mock.patch.object(launch, "LOG_FILE", root / "launcher.log"),
            mock.patch.object(launch, "MARKER_DIR", root / "markers"),
            mock.patch.object(launch, "PENDING_FILE", root / "pending.json"),
            mock.patch.object(launch, "bot", lambda method, body, what: self.calls.append((method, body))),
            mock.patch.object(launch, "launch", lambda m, p, c, k, e=None: self.launches.append((p, e))),
            mock.patch.object(launch, "environments", lambda: ["Work", "Home Lab"]),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def command(self, text):
        now = time.time()
        launch.handle({"chat_id": 42, "message_id": 7, "date": now, "received_at": now, "text": text})

    def tap(self, data, chat=42):
        launch.handle({"chat_id": chat, "received_at": time.time(),
                       "callback": {"id": "q1", "data": data, "message_id": 600, "text": "Did you mean Work?"}})

    def question(self):
        body = self.calls[-1][1]
        return body["text"], [b["callback_data"] for b in body["reply_markup"]["inline_keyboard"][0]]

    def test_exact_name_launches_in_it(self):
        self.command("Start a new session in work\nFix it")
        self.assertEqual((self.launches, self.calls), ([("Fix it", "Work")], []))

    def test_no_environment_launches_without(self):
        self.command("Start a new session\nFix it")
        self.assertEqual(self.launches, [("Fix it", None)])

    def test_unknown_name_lists_the_ones_that_exist(self):
        self.command("Start a new session in Garden\nFix it")
        self.assertEqual(self.calls[-1][1]["text"], "No environment called Garden exists. These do: Work, Home Lab.")
        self.assertEqual(self.launches, [])

    def test_yes_starts_with_the_suggestion_and_a_second_tap_does_nothing(self):
        self.command("Start a new session in Wrk\nLine one\nLine two")
        text, (yes, no) = self.question()
        self.assertEqual(text, "No environment called Wrk. Did you mean Work?")
        self.assertEqual(self.launches, [])
        self.tap(yes)
        self.assertEqual(self.launches, [("Line one\nLine two", "Work")])
        self.assertEqual(self.calls[-2][0], "answerCallbackQuery")
        self.assertEqual(self.calls[-1][1]["text"], "Did you mean Work?\nYes: starting in Work.")
        self.tap(yes)
        self.tap(no)
        self.assertEqual(len(self.launches), 1)
        self.assertEqual(self.calls[-1][1]["text"], "Did you mean Work?\nExpired: not started.")

    def test_no_starts_nothing(self):
        self.command("Start a new session in Wrk\nFix it")
        _, (yes, no) = self.question()
        self.tap(no)
        self.tap(yes)
        self.assertEqual(self.launches, [])
        self.assertEqual(self.calls[-3][1]["text"], "Did you mean Work?\nNo: not started.")

    def test_yes_after_ten_minutes_starts_nothing(self):
        self.command("Start a new session in Wrk\nFix it")
        _, (yes, _no) = self.question()
        with mock.patch.object(launch.time, "time", return_value=time.time() + launch.PENDING_SECONDS + 1):
            self.tap(yes)
        self.assertEqual(self.launches, [])

    def test_tap_from_another_chat_ignored(self):
        self.command("Start a new session in Wrk\nFix it")
        _, (yes, _no) = self.question()
        self.tap(yes, chat=99)
        self.assertEqual(self.launches, [])
        self.tap(yes)
        self.assertEqual(len(self.launches), 1)

    def test_apps_file_unreadable(self):
        with mock.patch.object(launch, "environments", lambda: None):
            self.command("Start a new session in Work\nFix it")
        self.assertEqual(self.calls[-1][1]["text"], "Couldn't start: couldn't read the app's environments")


class Handle(unittest.TestCase):
    """handle() up to the launch, with the launch and replies replaced."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.config = root / "phone-bridge.json"
        self.config.write_text(json.dumps({"telegram_token": "x", "telegram_chat_id": 42}))
        self.replies, self.launches = [], []
        self.patches = [
            mock.patch.object(bridge, "CONFIG_FILE", self.config),
            mock.patch.object(launch, "LOG_FILE", root / "launcher.log"),
            mock.patch.object(launch, "MARKER_DIR", root / "markers"),
            mock.patch.object(launch, "reply", lambda message, text: self.replies.append(text)),
            mock.patch.object(launch, "launch", self.fake_launch),
        ]
        for p in self.patches:
            p.start()
        self.result = None

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def fake_launch(self, message, prompt, conf, marker, environment=None):
        self.launches.append(prompt)
        return self.result

    def message(self, text, age=0, chat=42):
        now = time.time()
        return {"chat_id": chat, "message_id": 7, "date": now - age, "received_at": now, "text": text}

    def test_starts(self):
        launch.handle(self.message("Start a new session\nhi"))
        self.assertEqual((self.launches, self.replies), (["hi"], []))

    def test_too_old(self):
        msg = self.message("Start a new session\nhi", age=180)
        launch.handle(msg)
        sent = time.strftime("%H:%M", time.localtime(msg["date"]))
        self.assertEqual((self.launches, self.replies), ([], [f"Not started, too old: sent at {sent}"]))

    def test_other_chat_ignored(self):
        launch.handle(self.message("Start a new session\nhi", chat=99))
        self.assertEqual((self.launches, self.replies), ([], []))

    def test_no_prompt(self):
        launch.handle(self.message("Start a new session"))
        self.assertEqual(self.replies, ["Add your prompt on the line under Start a new session."])

    def test_prompt_too_long(self):
        launch.handle(self.message("Start a new session\n" + "x" * 8000))
        self.assertEqual(self.launches, ["x" * 8000])
        launch.handle(self.message("Start a new session\n" + "\U0001F600" * 3000))  # 36,000 characters encoded
        self.assertEqual(self.replies, ["Couldn't start: the prompt is too long for the app's link"])

    def test_failure_reply_and_marker_removed(self):
        self.result = "Claude isn't running on the PC"
        launch.MARKER_DIR.mkdir()
        with mock.patch.object(launch.time, "time", return_value=1000.0):
            (launch.MARKER_DIR / "7-1000.json").write_text("{}")
            launch.handle({**self.message("Start a new session\nhi"), "date": 1000, "received_at": 1000})
        self.assertEqual(self.replies, ["Couldn't start: Claude isn't running on the PC"])
        self.assertFalse((launch.MARKER_DIR / "7-1000.json").exists())

    def test_settings_ignore_bypass(self):
        self.config.write_text(json.dumps({"telegram_token": "x", "telegram_chat_id": 42, "launcher": {
            "permission_mode": "Bypass permissions", "quiet_seconds": 3}}))
        conf = launch.settings()
        self.assertEqual((conf["permission_mode"], conf["quiet_seconds"]), ("Auto", 3))

    def test_settings_without_a_launcher_section(self):
        self.assertEqual(launch.settings(), launch.DEFAULTS)


class Steps(unittest.TestCase):
    """run_steps()'s conversation with launch_steps.ps1, through a stand-in script."""

    def run_fake(self, script, events_during=0):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        fake = Path(tmp.name) / "fake.py"
        fake.write_text(script)

        class Watch:
            events = 0

        watch = Watch()

        real_popen = launch.subprocess.Popen

        def popen(args, **kw):
            watch.events += events_during  # input arrives while the steps run
            return real_popen([sys.executable, str(fake)], **kw)

        with mock.patch.object(launch.subprocess, "Popen", popen), \
                mock.patch.object(launch, "LOG_FILE", Path(tmp.name) / "log"):
            return launch.run_steps("hi", {**launch.DEFAULTS}, watch)

    READY = ("import json, sys\nrequest = json.loads(sys.stdin.readline())\n"
             "print(json.dumps({'event': 'ready'}), flush=True)\nanswer = sys.stdin.readline().strip()\n")

    def test_go_when_quiet(self):
        script = self.READY + "print(json.dumps({'event': 'done', 'restore': answer}), flush=True)\n"
        self.assertEqual(self.run_fake(script), ("done", {"event": "done", "restore": "go"}))

    def test_stop_when_input_arrived(self):
        script = self.READY + "print(json.dumps({'event': 'retry', 'why': answer}), flush=True)\n"
        self.assertEqual(self.run_fake(script, events_during=3), ("retry", "stop"))

    def test_failure_with_input_is_a_retry(self):
        script = "import json\nprint(json.dumps({'event': 'fail', 'message': \"couldn't choose This computer\"}))\n"
        self.assertEqual(self.run_fake(script)[0], "fail")
        self.assertEqual(self.run_fake(script, events_during=1)[0], "retry")

    def test_script_that_dies_while_setting_up_is_a_retry(self):
        script = "import sys\nsys.stderr.write('Add-Type : Cannot execute a program.\\n')\nsys.exit(1)\n"
        self.assertEqual(self.run_fake(script), ("retry", "the launch script stopped before its first step"))

    def test_script_that_dies_after_a_step(self):
        script = "import json, sys\nprint(json.dumps({'event': 'step', 'name': 'app'}), flush=True)\nsys.exit(3)\n"
        self.assertEqual(self.run_fake(script), ("fail", "the launch script stopped early"))


class HookMarker(unittest.TestCase):
    """The hook's side: a launched session's first prompt matches the marker."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.hook = load_hook()
        self.markers = root / "markers"
        self.markers.mkdir()
        self.flags = root / "flags"
        self.started = []
        self.patches = [
            mock.patch.object(self.hook, "MARKER_DIR", self.markers),
            mock.patch.object(self.hook, "FLAG_DIR", self.flags),
            mock.patch.object(bridge, "LOG_FILE", root / "phone-bridge.log"),
            mock.patch.object(self.hook, "run_by_another_claude", lambda: False),
            mock.patch.object(self.hook, "seconds_since_real_input", lambda: 0.0),
            mock.patch.object(self.hook, "presence_state", lambda: {"heartbeat": time.time()}),
            mock.patch.object(self.hook, "listener_running", lambda: True),
            mock.patch.object(self.hook, "mark_active", lambda *a: None),
            mock.patch.object(self.hook, "start_in_background", lambda *a: self.started.append(a)),
            mock.patch.dict(os.environ, {self.hook.HOST_SESSION_VAR: ""}),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def submit(self, prompt):
        data = json.dumps({"hook_event_name": "UserPromptSubmit", "session_id": "launched1",
                           "prompt": prompt, "cwd": self.tmp.name}).encode()
        with mock.patch.object(sys, "stdin", mock.Mock(buffer=mock.Mock(read=lambda: data))), \
                mock.patch.object(sys, "argv", ["notify_hook.py"]):
            self.hook.main()

    def marker(self, prompt, test=False, expires_in=60):
        (self.markers / "7-1.json").write_text(json.dumps(
            {"prompt": prompt, "expires": time.time() + expires_in, "test": test}))

    def test_match_turns_pushes_on_and_queues_started_push(self):
        self.marker("Line one\nLine two")
        self.submit("Line one\r\nLine two\n")  # at the PC (0 s idle), so only the marker turns pushes on
        self.assertEqual((self.flags / "launched1").read_text(), "all")
        self.assertEqual(json.loads((self.flags / "launched1.started").read_text())["prompt"], "Line one\r\nLine two")
        self.assertEqual(self.started[0][1:], ("--started", "launched1"))
        self.assertEqual(list(self.markers.iterdir()), [])

    def test_test_marker_turns_pushes_off(self):
        # A No folder session's first prompt opens with the app's note about its scratch workspace.
        self.marker("hi", test=True)
        self.submit("<system-reminder>\nThe user started this session without choosing a project folder."
                    "\n</system-reminder>\n\nhi")
        self.assertFalse((self.flags / "launched1").exists())
        self.assertEqual(self.started, [])

    def test_other_prompt_leaves_marker(self):
        self.marker("hi")
        self.submit("something else")
        self.assertFalse((self.flags / "launched1").exists())
        self.assertEqual(len(list(self.markers.iterdir())), 1)

    def test_expired_marker_removed(self):
        self.marker("hi", expires_in=-1)
        self.submit("hi")
        self.assertFalse((self.flags / "launched1").exists())
        self.assertEqual(list(self.markers.iterdir()), [])

    def test_started_push(self):
        self.flags.mkdir()
        (self.flags / "s1.started").write_text(json.dumps({"prompt": "Fix it", "record": "local_x"}))
        sent = []
        with mock.patch.object(self.hook, "desktop_record", lambda local_id: {"title": "Fix the bug",
                                                                              "bridgeSessionIds": ["session_ab"]}), \
                mock.patch.object(self.hook, "push", lambda *a: sent.append(a)):
            self.hook.started_push("s1")
        self.assertEqual(sent, [("Fix the bug · started", "Fix it", "rocket", "https://claude.ai/code/session_ab")])
        self.assertFalse((self.flags / "s1.started").exists())


class Core(unittest.TestCase):
    """The pieces both features share."""

    def test_files_live_in_the_config_and_one_state_folder(self):
        self.assertEqual(bridge.CONFIG_FILE, bridge.CLAUDE_DIR / "phone-bridge.json")
        for path in (bridge.LOG_FILE, bridge.FLAG_DIR, bridge.MESSAGES_DIR, bridge.MARKER_DIR, bridge.PRESENCE_FILE,
                     bridge.LISTENER_FILE, bridge.SNOOZE_FILE, launch.LOG_FILE, launch.PENDING_FILE):
            self.assertEqual(path.parent, bridge.STATE_DIR, path)

    def test_relative_commands_run_from_the_tool(self):
        self.assertEqual(bridge.resolve_run(["launcher/launch.py", "--environments"]),
                         [bridge.python_exe(), str(bridge.TOOL_DIR / "launcher" / "launch.py"), "--environments"])
        self.assertEqual(bridge.resolve_run(["C:/x/handler.py"]), ["C:/x/handler.py"])
        self.assertEqual(bridge.resolve_run(["node", "handler.js"]), ["node", "handler.js"])

    def test_snooze_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(bridge, "SNOOZE_FILE", Path(tmp) / "s" / "snooze.json"):
            self.assertIsNone(bridge.snoozed_until())
            until = time.time() + 60
            bridge.set_snooze(until)
            self.assertAlmostEqual(bridge.snoozed_until(), until)
            bridge.set_snooze(None)
            self.assertIsNone(bridge.snoozed_until())

    def test_the_listener_never_loads_the_hook(self):
        code = ("import sys; sys.path.insert(0, sys.argv[1]); from core import listener; "
                "sys.exit(1 if 'notify.notify_hook' in sys.modules else 0)")
        self.assertEqual(subprocess.run([sys.executable, "-I", "-c", code, str(ROOT)]).returncode, 0)

    def test_every_script_finds_its_imports_when_run_from_its_own_folder(self):
        # As Python runs a script: its own folder first on sys.path. Not as
        # __main__, so nothing starts.
        for script in ("core/listener.py", "core/presence.py", "notify/notify_hook.py", "notify/archive.py",
                       "notify/cleanup.py", "notify/sessions.py", "launcher/launch.py"):
            path = ROOT / script
            code = "import runpy, sys; sys.path.insert(0, sys.argv[1]); runpy.run_path(sys.argv[2], run_name='imported')"
            result = subprocess.run([sys.executable, "-I", "-c", code, str(path.parent), str(path)],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, f"{script}: {result.stderr[-500:]}")


class ListenerRuns(unittest.TestCase):
    """The listener running a command's program."""

    def test_relative_program_runs_with_this_python_from_the_tool(self):
        tc = load_listener()
        ran = []
        with mock.patch.object(tc.subprocess, "run", lambda argv, **kw: ran.append(argv) or mock.Mock(returncode=0)), \
                mock.patch.object(tc, "note", lambda *a: None):
            tc.run_external({"name": "start", "run": ["launcher/launch.py"]}, {"message_id": 1})
        self.assertEqual(ran, [[bridge.python_exe(), str(bridge.TOOL_DIR / "launcher" / "launch.py")]])


class WaitingPushes(unittest.TestCase):
    """The waiting push follows the config's waiting_pushes, off by default."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.hook = load_hook()
        self.flags = root / "flags"
        self.flags.mkdir()
        (self.flags / "s1").write_text("all")
        self.config = root / "phone-bridge.json"
        self.sent = []
        self.patches = [
            mock.patch.object(bridge, "CONFIG_FILE", self.config),
            mock.patch.object(self.hook, "FLAG_DIR", self.flags),
            mock.patch.object(self.hook, "run_by_another_claude", lambda: False),
            mock.patch.object(self.hook, "presence_state", lambda: {"heartbeat": time.time()}),
            mock.patch.object(self.hook, "listener_running", lambda: True),
            mock.patch.object(self.hook, "clear_active", lambda *a: None),
            mock.patch.object(self.hook, "session_started_this_turn", lambda path: False),
            mock.patch.object(self.hook, "prompts_queued", lambda path: False),
            mock.patch.object(self.hook, "background_work_pending", lambda path: ["build"]),
            mock.patch.object(self.hook, "push", lambda title, text, tags, url=None: self.sent.append(tags)),
            mock.patch.dict(os.environ, {self.hook.HOST_SESSION_VAR: ""}),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def stop(self):
        data = json.dumps({"hook_event_name": "Stop", "session_id": "s1", "cwd": self.tmp.name,
                           "transcript_path": str(Path(self.tmp.name) / "none.jsonl")}).encode()
        with mock.patch.object(sys, "stdin", mock.Mock(buffer=mock.Mock(read=lambda: data))), \
                mock.patch.object(sys, "argv", ["notify_hook.py"]):
            self.hook.main()

    def test_off_by_default(self):
        self.stop()
        self.assertEqual(self.sent, [])

    def test_on_in_the_config(self):
        self.config.write_text(json.dumps({"waiting_pushes": True}))
        self.stop()
        self.assertEqual(self.sent, ["hourglass_flowing_sand"])


class Installer(unittest.TestCase):
    """install.py's feature choice and the launcher's config entry."""

    def setUp(self):
        self.install = load_install()

    def test_features(self):
        self.assertEqual(self.install.parse_features("notify"), ["notify"])
        self.assertEqual(self.install.parse_features("launcher, notify"), ["notify", "launcher"])
        for bad in ("launcher", "notify,phone"):
            with self.assertRaises(SystemExit), mock.patch("sys.stderr"):
                self.install.parse_features(bad)

    def test_without_a_terminal_it_keeps_the_last_choice(self):
        entry = self.install.launcher_entry(launch)
        with mock.patch.object(self.install.sys.stdin, "isatty", lambda: False), \
                mock.patch.object(self.install.os, "name", "nt"):
            self.assertEqual(self.install.choose_features(None, {}), ["notify", "launcher"])
            self.assertEqual(self.install.choose_features(None, {"telegram_token": "x"}), ["notify"])
            self.assertEqual(self.install.choose_features(None, {"telegram_token": "x", "telegram_commands": [entry]}),
                             ["notify", "launcher"])

    def test_the_null_device_is_no_terminal(self):
        # Windows calls the null device a tty; the token prompt would wait forever on it.
        with open(os.devnull) as null, mock.patch.object(self.install.sys, "stdin", null):
            self.assertFalse(self.install.has_terminal())

    def test_the_claude_md_question_is_not_asked_on_the_null_device(self):
        # The template's question, shared by every installer with INSTRUCTIONS, used to raise EOFError here.
        with open(os.devnull) as null, mock.patch.object(self.install.sys, "stdin", null), \
                mock.patch("builtins.input", side_effect=EOFError):
            self.assertIsNone(self.install.ask_instructions())

    def test_placeholders_count_as_not_set(self):
        self.assertFalse(self.install.is_set("REPLACE_WITH_YOUR_BOT_TOKEN"))
        self.assertFalse(self.install.is_set(None))
        self.assertTrue(self.install.is_set(42))

    def test_launcher_entry_names_the_launcher_relative_to_the_tool(self):
        entry = self.install.launcher_entry(launch)
        self.assertEqual((entry["run"], entry["choices"]),
                         (["launcher/launch.py"], ["launcher/launch.py", "--environments"]))
        self.assertEqual(entry["command"], "new_session")

    def test_launcher_in_and_out(self):
        other = {"name": "other", "run": ["x.py"]}
        config = {"telegram_token": "x", "telegram_commands": [other, {"name": "start", "run": ["old/launch.py"]}],
                  "launcher": {"quiet_seconds": 3}}
        with mock.patch.object(self.install, "webhook_url", lambda token, b: ""), \
                mock.patch.object(self.install.os, "name", "nt"), mock.patch("builtins.print"):
            config = self.install.set_up_features(config, ["notify", "launcher"], bridge, launch)
            self.assertEqual([c["name"] for c in config["telegram_commands"]], ["other", "start"])
            self.assertEqual(config["launcher"]["quiet_seconds"], 3)
            self.assertEqual(config["launcher"]["attempts"], launch.DEFAULTS["attempts"])
            self.assertTrue(self.install.launcher_installed(config))
            config = self.install.set_up_features(config, ["notify"], bridge, launch)
        self.assertEqual(config["telegram_commands"], [other])
        self.assertFalse(self.install.launcher_installed(config))
        self.assertEqual(config["launcher"]["quiet_seconds"], 3)  # your settings stay for a later rerun


if __name__ == "__main__":
    unittest.main()
