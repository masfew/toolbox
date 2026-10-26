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
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

# Before any of the tool's modules load, so every path they build is in here.
FAKE_HOME = tempfile.TemporaryDirectory(prefix="phone-bridge-test-")
os.environ["HOME"] = os.environ["USERPROFILE"] = FAKE_HOME.name
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from core import bridge, local_app  # noqa: E402
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
            mock.patch.object(self.hook, "start_in_background", lambda *a, **k: self.started.append(a)),
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

    def background_start(self, outside_package, in_package, outside_works=True):
        popened, outside = [], []
        with mock.patch.object(bridge, "in_app_package", lambda: in_package), \
                mock.patch.object(bridge, "start_outside_package", lambda argv: outside.append(argv) or outside_works), \
                mock.patch.object(bridge.subprocess, "Popen", lambda argv, **k: popened.append(argv)):
            bridge.start_in_background("listener.py", outside_package=outside_package)
        return popened, outside

    def test_the_listener_starts_outside_the_app_package_from_inside_it(self):
        popened, outside = self.background_start(True, in_package=True)
        self.assertEqual((popened, [a[1:] for a in outside]), ([], [["listener.py"]]))

    def test_outside_the_package_it_starts_as_usual(self):
        popened, outside = self.background_start(True, in_package=False)
        self.assertEqual((len(popened), outside), (1, []))

    def test_if_wmi_fails_it_still_starts_inside(self):
        popened, outside = self.background_start(True, in_package=True, outside_works=False)
        self.assertEqual((len(popened), len(outside)), (1, 1))

    def test_other_scripts_never_leave_the_package(self):
        popened, outside = self.background_start(False, in_package=True)
        self.assertEqual((len(popened), outside), (1, []))

    def test_the_hook_starts_the_listener_outside_the_package(self):
        self.assertIn("start_in_background(LISTENER_SCRIPT, outside_package=True)",
                      (ROOT / "notify" / "notify_hook.py").read_text(encoding="utf-8"))

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


class HostFile(unittest.TestCase):
    """Another app hosting a session titles its pushes and gives (or drops) the link."""

    def setUp(self):
        from notify import sessions
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.hook = load_hook()
        self.flags = root / "flags"
        self.flags.mkdir()
        (self.flags / "s1").write_text("all")
        self.sent = []
        self.patches = [
            mock.patch.object(bridge, "CONFIG_FILE", root / "phone-bridge.json"),
            mock.patch.object(self.hook, "FLAG_DIR", self.flags),
            mock.patch.object(sessions, "FLAG_DIR", self.flags),
            mock.patch.object(self.hook, "run_by_another_claude", lambda: False),
            mock.patch.object(self.hook, "presence_state", lambda: {"heartbeat": time.time()}),
            mock.patch.object(self.hook, "listener_running", lambda: True),
            mock.patch.object(self.hook, "clear_active", lambda *a: None),
            mock.patch.object(self.hook, "session_started_this_turn", lambda path: False),
            mock.patch.object(self.hook, "prompts_queued", lambda path: False),
            mock.patch.object(self.hook, "background_work_pending", lambda path: []),
            mock.patch.object(self.hook, "push", lambda title, text, tags, url=None: self.sent.append((title, url))),
            mock.patch.dict(os.environ, {self.hook.HOST_SESSION_VAR: ""}),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def stop(self):
        data = json.dumps({"hook_event_name": "Stop", "session_id": "s1", "cwd": str(Path(self.tmp.name) / "shop-game"),
                           "transcript_path": str(Path(self.tmp.name) / "none.jsonl")}).encode()
        with mock.patch.object(sys, "stdin", mock.Mock(buffer=mock.Mock(read=lambda: data))), \
                mock.patch.object(sys, "argv", ["notify_hook.py"]):
            self.hook.main()

    def host(self, value):
        (self.flags / "s1.host.json").write_text(value if isinstance(value, str) else json.dumps(value), encoding="utf-8")

    def test_without_one_the_folder_titles_it_and_the_code_tab_links(self):
        self.stop()
        self.assertEqual(self.sent, [("shop-game", self.hook.CODE_URL)])

    def test_its_title_and_an_empty_link(self):
        self.host({"app": "Some App", "title": "Shop card:  price", "link": ""})
        self.stop()
        self.assertEqual(self.sent, [("Shop card: price", "")])

    def test_its_own_link(self):
        self.host({"title": "Shop card", "link": "https://example.com/s/1"})
        self.stop()
        self.assertEqual(self.sent, [("Shop card", "https://example.com/s/1")])

    def test_a_bad_file_or_link_is_left_out(self):
        self.host("{ not json")
        self.stop()
        self.host({"title": 7, "link": "javascript:alert(1)"})
        self.stop()
        self.assertEqual(self.sent, [("shop-game", self.hook.CODE_URL)] * 2)

    def test_no_link_line_in_the_message(self):
        sent = []
        with mock.patch.object(self.hook, "telegram_call", lambda token, method, body: (sent.append(body) or (200, {"ok": True, "result": {"message_id": 1}}))):
            self.hook.send_telegram({"telegram_chat_id": 1, "telegram_token": "t"}, "Title", "Done.", "white_check_mark", "")
        self.assertTrue(sent[0]["text"].endswith("Done."), sent[0]["text"])


class FakeApp:
    """A local app: a thread that watches a request folder the way the protocol
    describes, takes each <name>.json, and answers with <name>.reply.json (written
    to a temporary name and renamed). `answer(body)` returns the reply object, or
    None to take the request and never answer."""

    def __init__(self, folder, answer):
        self.folder, self.answer, self.seen = Path(folder), answer, []
        self.stopped = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def run(self):
        while not self.stopped.is_set():
            for path in self.folder.glob("*.json"):
                if path.name.endswith(".reply.json"):
                    continue
                try:
                    body = json.loads(path.read_text(encoding="utf-8"))
                    path.unlink()
                except (OSError, ValueError):
                    continue
                self.seen.append(body)
                reply = self.answer(body)
                if reply is not None:
                    tmp = self.folder / (path.stem + ".reply.tmp")
                    tmp.write_text(json.dumps(reply), encoding="utf-8")
                    os.replace(tmp, self.folder / (path.stem + ".reply.json"))
            time.sleep(0.01)

    def stop(self):
        self.stopped.set()
        self.thread.join(2)


def app_config(folder, **extra):
    return {"requests": str(folder), "name": "Some App", "timeout_seconds": 0.5, "start_timeout_seconds": 0.5, **extra}


class LocalAppRequests(unittest.TestCase):
    """core/local_app.py: the request folder protocol, with a fake app."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.folder = Path(self.tmp.name) / "requests"
        self.folder.mkdir()
        self.conf = local_app.settings({"local_app": app_config(self.folder)})
        self.app = None

    def tearDown(self):
        if self.app:
            self.app.stop()
        self.tmp.cleanup()

    def serve(self, answer):
        self.app = FakeApp(self.folder, answer)
        return self.app

    def test_not_set_up(self):
        for config in ({}, {"local_app": "x"}, {"local_app": {}}, {"local_app": {"requests": "  "}},
                       {"local_app": {"requests": 5}}, {"local_app": {"requests": "REPLACE_WITH_THE_APPS_REQUEST_FOLDER"}}):
            self.assertIsNone(local_app.settings(config), config)

    def test_defaults_and_expansion(self):
        with mock.patch.dict(os.environ, {"SOME_APP_DATA": "/data"}):
            conf = local_app.settings({"local_app": {"requests": "$SOME_APP_DATA/in", "default_folder": "$SOME_APP_DATA/p",
                                                     "timeout_seconds": "x", "start_timeout_seconds": -1, "other": 1}})
        self.assertEqual((conf["name"], conf["timeout_seconds"], conf["start_timeout_seconds"]), ("Local app", 5, 30))
        self.assertNotIn("other", conf)
        self.assertEqual((conf["requests"], conf["default_folder"]), ("/data/in", "/data/p"))

    def test_request_returns_the_value_and_leaves_nothing_behind(self):
        app = self.serve(lambda body: {"ok": True, "value": [1, 2]})
        self.assertEqual(local_app.request(self.conf, {"action": "list"}), [1, 2])
        self.assertEqual(app.seen, [{"action": "list"}])
        self.assertEqual(list(self.folder.iterdir()), [])

    def test_request_file_is_written_whole_under_a_safe_name(self):
        names = []
        real_replace = os.replace

        def spy(src, dst):
            names.append((Path(src).name, Path(dst).name))
            return real_replace(src, dst)

        self.serve(lambda body: {"ok": True, "value": None})
        with mock.patch.object(local_app.os, "replace", spy):
            local_app.request(self.conf, {"action": "list"})
        (tmp_name, final_name), = [n for n in names if not n[1].endswith(".reply.json")]  # not the app's own reply
        self.assertRegex(final_name, r"^[0-9a-f]{32}\.json$")
        self.assertEqual(tmp_name, final_name[:-5] + ".tmp")

    def test_an_error_reply_raises_with_the_apps_text(self):
        self.serve(lambda body: {"ok": False, "error": "a turn is running"})
        with self.assertRaises(local_app.AppError) as caught:
            local_app.request(self.conf, {"action": "archive", "session": "s"})
        self.assertEqual(str(caught.exception), "a turn is running")
        self.assertEqual(list(self.folder.iterdir()), [])

    def test_a_missing_folder_is_no_app_at_once(self):
        conf = {**self.conf, "requests": str(Path(self.tmp.name) / "nowhere")}
        started = time.monotonic()
        self.assertIs(local_app.request(conf, {"action": "list"}, timeout=30), local_app.NO_APP)
        self.assertLess(time.monotonic() - started, 1)
        self.assertFalse(Path(conf["requests"]).exists())

    def test_nobody_listening_deletes_the_request_and_is_no_app(self):
        started = time.monotonic()
        self.assertIs(local_app.request(self.conf, {"action": "list"}), local_app.NO_APP)
        self.assertGreaterEqual(time.monotonic() - started, 0.5)
        self.assertEqual(list(self.folder.iterdir()), [], "a late app must not find the request")

    def test_taken_but_never_answered_is_an_error_not_a_fallback(self):
        # The app may be running it, so a caller that fell back could do the work twice.
        app = self.serve(lambda body: None)
        with self.assertRaises(local_app.AppError):
            local_app.request(self.conf, {"action": "start", "options": {}})
        self.assertEqual(len(app.seen), 1)

    def test_too_large_a_request_is_refused_before_writing(self):
        with self.assertRaises(local_app.AppError):
            local_app.request(self.conf, {"action": "start", "options": {"prompt": "x" * local_app.MAX_BODY}})
        self.assertEqual(list(self.folder.iterdir()), [])

    def test_an_unreadable_reply_is_an_error_and_is_cleaned_up(self):
        self.assertIsNone(local_app.read_reply(self.folder / "missing.reply.json"))
        (self.folder / "y.reply.json").write_text("not json")
        self.assertEqual(local_app.read_reply(self.folder / "y.reply.json"),
                         {"ok": False, "error": "the reply wasn't readable"})
        self.assertFalse((self.folder / "y.reply.json").exists())

    def test_the_actions_send_their_bodies(self):
        replies = {"start": {"id": "s1", "title": "New"}, "list": [{"id": "s1"}, {"nope": 1}, "x"],
                   "archive": {"archived": True, "title": "Old"}, "notify": {"title": "Busy"}}
        app = self.serve(lambda body: {"ok": True, "value": replies[body["action"]]})
        options = {"cwd": "/p", "prompt": "hi"}
        self.assertEqual(local_app.start(self.conf, options), {"id": "s1", "title": "New"})
        self.assertEqual(local_app.sessions(self.conf), [{"id": "s1"}])
        self.assertEqual(local_app.archive(self.conf, "c1"), (True, "Old"))
        self.assertEqual(local_app.notify(self.conf, "c1"), "Busy")
        self.assertEqual(app.seen, [{"action": "start", "options": options, "notify": True},
                                    {"action": "list"}, {"action": "archive", "session": "c1"},
                                    {"action": "notify", "session": "c1"}])

    def test_start_waits_for_its_own_longer_timeout(self):
        self.serve(lambda body: time.sleep(0.4) or {"ok": True, "value": {"id": "s1"}})
        conf = {**self.conf, "timeout_seconds": 0.1, "start_timeout_seconds": 2}
        self.assertEqual(local_app.start(conf, {"cwd": "/p", "prompt": "x"}), {"id": "s1"})

    def test_which_sessions_count(self):
        listed = [
            {"id": "a", "status": "finished", "working": False},
            {"id": "b", "status": "idle", "working": False},
            {"id": "c", "status": "failed", "working": False},
            {"id": "d", "status": "working", "working": True},
            {"id": "e", "status": "needs-you", "working": False},
            {"id": "f", "status": "finished", "working": True},
            {"id": "g", "status": "finished", "working": False},
            {"id": "h", "status": "working", "working": True, "parent": "g"},
            {"id": "i", "status": "finished", "working": False, "parent": "a"},
        ]
        self.assertEqual([s["id"] for s in local_app.finished_sessions(listed)], ["a", "b", "c", "i"])
        self.assertEqual([s["id"] for s in local_app.working_sessions(listed)], ["d", "f", "h"])
        self.assertEqual(local_app.session_key({"id": "s", "conversationId": "c"}), "c")
        self.assertEqual(local_app.session_key({"id": "s"}), "s")
        self.assertEqual(local_app.title_of({"id": "s", "title": " "}), "Untitled")


class LocalAppLaunch(unittest.TestCase):
    """The launcher starting a session through the local app, or falling back."""

    PRESETS = [{"name": "Work", "folder": "/projects/work", "model": "model-x", "effort": "high", "worktree": False},
               {"name": "Cloud", "folder": None, "model": None, "effort": None, "worktree": None}]

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.folder = root / "requests"
        self.folder.mkdir()
        self.config = root / "phone-bridge.json"
        self.write_config(local_app=app_config(self.folder, default_folder="/projects/default"))
        self.replies, self.launches, self.pushes = [], [], []
        self.reply_to_start = lambda body: {"ok": True, "value": {"id": "s1", "conversationId": "c1", "title": "Fix it"}}
        self.app = FakeApp(self.folder, lambda body: self.reply_to_start(body))
        self.patches = [
            mock.patch.object(bridge, "CONFIG_FILE", self.config),
            mock.patch.object(launch, "LOG_FILE", root / "launcher.log"),
            mock.patch.object(launch, "MARKER_DIR", root / "markers"),
            mock.patch.object(launch, "reply", lambda message, text: self.replies.append(text)),
            mock.patch.object(launch, "launch", lambda m, p, c, k, e=None: self.launches.append((p, e))),
            mock.patch.object(launch, "presets", lambda: self.PRESETS),
            mock.patch.object(launch, "environments", lambda: [p["name"] for p in self.PRESETS]),
            mock.patch.object(launch.notify_hook, "push_for", lambda *a: self.pushes.append(a)),
            mock.patch.object(launch, "host_info", lambda key: {}),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        self.app.stop()
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def write_config(self, **extra):
        self.config.write_text(json.dumps({"telegram_token": "x", "telegram_chat_id": 42, **extra}))

    def command(self, text):
        now = time.time()
        launch.handle({"chat_id": 42, "message_id": 7, "date": now, "received_at": now, "text": text})

    def test_starts_in_the_default_folder_without_the_desktop_app(self):
        self.command("Start a new session\nFix it")
        self.assertEqual(self.app.seen, [{"action": "start", "notify": True, "options": {
            "cwd": "/projects/default", "prompt": "Fix it", "mode": "Auto"}}])
        self.assertEqual((self.launches, self.replies), ([], []))
        self.assertEqual(self.pushes, [("c1", "Fix it · started", "Fix it", "rocket", "")])

    def test_a_saved_environment_brings_its_folder_and_settings(self):
        self.command("Start a new session in work\nFix it")
        self.assertEqual(self.app.seen[0]["options"], {"cwd": "/projects/work", "prompt": "Fix it", "mode": "Auto",
                                                       "model": "model-x", "effort": "high", "environment": "local"})
        self.assertEqual(self.launches, [])

    def test_a_worktree_environment(self):
        self.PRESETS = [{**self.PRESETS[0], "worktree": True}]
        self.command("Start a new session in Work\nFix it")
        self.assertEqual(self.app.seen[0]["options"]["environment"], "worktree")

    def test_the_launchers_permission_mode_is_passed(self):
        self.write_config(local_app=app_config(self.folder, default_folder="/p"), launcher={"permission_mode": "Plan"})
        self.command("/new_session hi")
        self.assertEqual(self.app.seen[0]["options"]["mode"], "Plan")

    def test_a_long_prompt_has_no_link_limit_through_the_app(self):
        self.command("Start a new session\n" + "\U0001F600" * 3000)
        self.assertEqual((len(self.app.seen), self.replies), (1, []))

    def test_no_environment_and_no_default_folder_leaves_the_folder_to_the_app(self):
        self.write_config(local_app=app_config(self.folder))
        self.command("Start a new session\nFix it")
        self.assertEqual(self.app.seen, [{"action": "start", "notify": True, "options": {"prompt": "Fix it", "mode": "Auto"}}])
        self.assertEqual(self.launches, [])

    def test_an_environment_without_a_folder_means_the_desktop_app(self):
        self.command("Start a new session in Cloud\nFix it")
        self.assertEqual((self.app.seen, self.launches), ([], [("Fix it", "Cloud")]))

    def test_a_missing_folder_falls_back_at_once(self):
        self.write_config(local_app=app_config(Path(self.tmp.name) / "nowhere", default_folder="/p"))
        started = time.monotonic()
        self.command("Start a new session\nFix it")
        self.assertLess(time.monotonic() - started, 0.4)
        self.assertEqual((self.launches, self.replies, self.pushes), ([("Fix it", None)], [], []))

    def test_an_app_that_never_answers_falls_back_and_leaves_no_request(self):
        self.app.stop()
        self.command("Start a new session\nFix it")
        self.assertEqual((self.launches, self.replies), ([("Fix it", None)], []))
        self.assertEqual(list(self.folder.iterdir()), [])

    def test_an_app_that_refuses_is_reported_not_worked_around(self):
        self.reply_to_start = lambda body: {"ok": False, "error": "that folder isn't allowed"}
        self.command("Start a new session\nFix it")
        self.assertEqual((self.launches, self.replies), ([], ["Couldn't start: that folder isn't allowed"]))

    def test_an_app_that_takes_the_request_and_goes_quiet_is_not_run_twice(self):
        self.reply_to_start = lambda body: None
        self.command("Start a new session\nFix it")
        self.assertEqual(self.launches, [])
        self.assertTrue(self.replies[0].startswith("Couldn't start: Some App took the request"), self.replies)

    def test_an_untitled_session_is_called_new_session(self):
        self.reply_to_start = lambda body: {"ok": True, "value": {"id": "s9"}}
        self.command("Start a new session\nFix it")
        self.assertEqual(self.pushes, [("s9", "New session · started", "Fix it", "rocket", "")])

    def test_the_hosts_link_goes_in_the_push(self):
        with mock.patch.object(launch, "host_info", lambda key: {"link": "https://example.com/s/" + key}):
            self.command("Start a new session\nFix it")
        self.assertEqual(self.pushes[0][4], "https://example.com/s/c1")

    def test_a_test_launch_asks_for_no_pushes_and_sends_none(self):
        with mock.patch.object(launch, "test_mode", True), mock.patch.object(launch, "bot", lambda *a: None), \
                mock.patch("builtins.print"):
            launch.handle({"message_id": None, "date": time.time(), "received_at": time.time(),
                           "text": "Start a new session\nFix it"})
        self.assertEqual((self.app.seen[0]["notify"], self.pushes), (False, []))

    def test_without_local_app_nothing_changes(self):
        self.write_config()
        self.command("Start a new session\nFix it")
        self.assertEqual((self.app.seen, self.launches), ([], [("Fix it", None)]))

    def test_old_presets_file_still_gives_folders(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp) / "Packages" / "Claude_abc" / "LocalCache" / "Roaming" / "Claude"
            folder.mkdir(parents=True)
            (folder / "ccd-session-presets.json").write_text(json.dumps({"byAccount": {"a": {"presets": [
                {"name": "Work", "lastUsedAt": 9, "target": {"kind": "local", "cwd": "/w"},
                 "settings": {"modelId": "m", "effort": "low", "worktree": True}},
                {"name": "Cloud", "lastUsedAt": 5, "target": {"kind": "remote"}},
                {"name": "Bare", "lastUsedAt": 1}]}}}))
            with mock.patch.dict(os.environ, {"LOCALAPPDATA": tmp, "APPDATA": str(Path(tmp) / "none")}), \
                    mock.patch.object(launch, "presets", self.real_presets):
                found = launch.presets()
        self.assertEqual(found, [
            {"name": "Work", "folder": "/w", "model": "m", "effort": "low", "worktree": True},
            {"name": "Cloud", "folder": None, "model": None, "effort": None, "worktree": None},
            {"name": "Bare", "folder": None, "model": None, "effort": None, "worktree": None}])

    real_presets = staticmethod(launch.presets)


class LocalAppListener(unittest.TestCase):
    """/archive and /notify_me covering the local app's sessions."""

    LISTED = [
        {"id": "s1", "conversationId": "c1", "title": "Old chat", "status": "finished", "working": False},
        {"id": "s2", "conversationId": "c2", "title": "Busy one", "status": "working", "working": True},
        {"id": "s3", "title": "Waiting", "status": "needs-you", "working": False},
        {"id": "s4", "conversationId": "c4", "title": "Failed run", "status": "failed", "working": False},
    ]

    def setUp(self):
        self.tc = load_listener()
        self.tmp = tempfile.TemporaryDirectory()
        self.folder = Path(self.tmp.name) / "requests"
        self.folder.mkdir()
        self.config = {"telegram_token": "x", "telegram_chat_id": 42, "local_app": app_config(self.folder)}
        self.sent, self.edited, self.cleared = [], [], []
        self.answers = {"list": lambda body: {"ok": True, "value": self.LISTED},
                        "archive": lambda body: {"ok": True, "value": {"archived": True, "title": "x"}},
                        "notify": lambda body: {"ok": True, "value": {"title": "x"}}}
        self.app = FakeApp(self.folder, lambda body: self.answers[body["action"]](body))
        self.desktop_archived = []
        self.review = ([], [], 1234)
        self.patches = [
            mock.patch.object(self.tc, "call", self.fake_call),
            mock.patch.object(self.tc, "note", lambda *a: None),
            mock.patch.object(self.tc, "sessions_without_pushes", lambda: []),
            mock.patch.object(self.tc.archive, "review", lambda: self.review),
            mock.patch.object(self.tc.archive, "archive", lambda key: self.desktop_archived.append(key) or ("archived", "")),
            mock.patch.object(self.tc, "clear_pushes", lambda config, key: self.cleared.append(key)),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        self.app.stop()
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def fake_call(self, config, method, body):
        (self.edited if method == "editMessageText" else self.sent).append((method, body))
        return {"ok": True, "result": {"message_id": 500}}

    def last_text(self):
        return self.sent[-1][1]["text"]

    def buttons(self):
        return [b["callback_data"] for row in self.sent[-1][1]["reply_markup"]["inline_keyboard"] for b in row]

    def test_archive_offers_the_apps_finished_sessions_by_app(self):
        self.review = ([{"id": "local_1", "title": "Desktop chat", "finished": time.time()}], [], 1234)
        self.tc.handle_archive(self.config, {})
        text = self.last_text()
        self.assertIn("Claude desktop app:\n1. Desktop chat (", text)
        self.assertIn("Some App:\n2. Old chat\n3. Failed run", text)
        self.assertNotIn("Busy one", text)
        self.assertNotIn("Waiting", text)
        self.assertEqual(self.buttons(), ["archive:local_1", "archive:app:c1", "archive:app:c4", "archive_all"])
        labels = [b["text"] for row in self.sent[-1][1]["reply_markup"]["inline_keyboard"] for b in row]
        self.assertEqual(labels[:3], ["Desktop chat", "Old chat · Some App", "Failed run · Some App"])

    def test_archive_works_with_only_the_app_when_the_desktop_app_is_off(self):
        self.review = ([], [], None)
        self.tc.handle_archive(self.config, {})
        self.assertIn("Some App:\n1. Old chat", self.last_text())
        self.assertNotIn("Claude desktop app:", self.last_text())

    def test_archive_when_the_app_does_not_answer_is_as_before(self):
        self.app.stop()
        self.review = ([{"id": "local_1", "title": "Desktop chat", "finished": time.time()}], [], 1234)
        self.tc.handle_archive(self.config, {})
        self.assertTrue(self.last_text().startswith("Finished sessions that aren't archived, newest first, with when each finished."))
        self.assertNotIn("Some App", self.last_text())
        self.assertEqual(self.buttons(), ["archive:local_1"])
        self.review = ([], [], None)
        self.tc.handle_archive(self.config, {})
        self.assertEqual(self.last_text(), "Claude isn't running on the PC, so nothing can be archived.")

    def test_archive_with_nothing_finished_anywhere(self):
        self.LISTED = [self.LISTED[1]]
        self.tc.handle_archive(self.config, {})
        self.assertEqual(self.last_text(), "No finished sessions to archive.")

    def test_a_tap_archives_through_the_app_by_conversation_id(self):
        seen = []
        self.answers["archive"] = lambda body: seen.append(body) or {"ok": True, "value": {"archived": True, "title": "Old chat"}}
        query = {"id": "q", "data": "archive:app:c1", "message": {"message_id": 9, "chat": {"id": 42}, "text": "list",
                 "reply_markup": {"inline_keyboard": [[{"text": "Old chat · Some App", "callback_data": "archive:app:c1"}]]}}}
        self.tc.handle_archive_tap(self.config, query)
        self.assertEqual(seen, [{"action": "archive", "session": "c1"}])
        self.assertEqual(self.desktop_archived, [])
        self.assertIn("🗄 Old chat · Some App: archived", self.edited[-1][1]["text"])
        self.assertEqual(self.cleared, ["app:c1"])

    def test_a_session_the_app_will_not_archive_stays_listed_with_its_reason(self):
        self.answers["archive"] = lambda body: {"ok": False, "error": "a turn is running"}
        query = {"id": "q", "data": "archive:app:c1", "message": {"message_id": 9, "chat": {"id": 42}, "text": "list",
                 "reply_markup": {"inline_keyboard": [[{"text": "Old chat · Some App", "callback_data": "archive:app:c1"}]]}}}
        self.tc.handle_archive_tap(self.config, query)
        self.assertIn("⏳ Old chat · Some App: not archived, a turn is running", self.edited[-1][1]["text"])
        self.assertIn("archive:app:c1", str(self.edited[-1][1]["reply_markup"]))
        self.assertEqual(self.cleared, [])

    def test_archive_all_mixes_both_apps(self):
        keyboard = [[{"text": "Desktop chat", "callback_data": "archive:local_1"}],
                    [{"text": "Old chat · Some App", "callback_data": "archive:app:c1"}],
                    [{"text": "Archive All", "callback_data": "archive_all"}]]
        seen = []
        self.answers["archive"] = lambda body: seen.append(body["session"]) or {"ok": True, "value": {"archived": True}}
        self.tc.handle_archive_all(self.config, {"id": "q", "message": {"message_id": 9, "chat": {"id": 42}, "text": "list",
                                                                        "reply_markup": {"inline_keyboard": keyboard}}})
        self.assertEqual((self.desktop_archived, seen), (["local_1"], ["c1"]))
        self.assertIn("Archived 2 of 2", self.edited[-1][1]["text"])

    def test_notify_me_turns_on_the_apps_working_sessions_and_lists_them(self):
        seen = []
        self.answers["notify"] = lambda body: seen.append(body["session"]) or {"ok": True, "value": {"title": "Busy one"}}
        self.tc.handle_notify_me(self.config, {})
        self.assertEqual(seen, ["c2"])
        self.assertEqual(self.last_text(),
                         "Done. All notifications are on (turned on for 1 session).\n\nSome App:\n• Busy one · working")

    def test_notify_me_with_nothing_working_is_as_before(self):
        self.LISTED = [self.LISTED[0]]
        self.tc.handle_notify_me(self.config, {})
        self.assertEqual(self.last_text(), "Done. All notifications were already on.")

    def test_notify_me_reports_a_session_the_app_refuses(self):
        self.answers["notify"] = lambda body: {"ok": False, "error": "no such session"}
        self.tc.handle_notify_me(self.config, {})
        self.assertEqual(self.last_text(), "Couldn't turn pushes on for every session:\n\nSome App:\n"
                                           "• Busy one · couldn't turn pushes on (no such session)")

    def test_notify_me_without_an_answering_app_is_as_before(self):
        self.app.stop()
        self.tc.handle_notify_me(self.config, {})
        self.assertEqual(self.last_text(), "Done. All notifications were already on.")

    def test_one_button_per_session_when_notify_me_all_is_off(self):
        with mock.patch.object(self.tc, "NOTIFY_ME_ALL", False):
            self.tc.handle_notify_me(self.config, {})
        self.assertEqual(self.buttons(), ["on:app:c2"])
        self.assertEqual(self.sent[-1][1]["reply_markup"]["inline_keyboard"][0][0]["text"], "Busy one · Some App, working")
        seen = []
        self.answers["notify"] = lambda body: seen.append(body["session"]) or {"ok": True, "value": {"title": "Busy one"}}
        query = {"id": "q", "data": "on:app:c2", "message": {"message_id": 9, "chat": {"id": 42}, "text": "Tap one",
                 "reply_markup": {"inline_keyboard": [[{"text": "Busy one · Some App, working", "callback_data": "on:app:c2"}]]}}}
        self.tc.handle_tap(self.config, query)
        self.assertEqual(seen, ["c2"])
        self.assertIn("✅ Busy one: pushes on", self.edited[-1][1]["text"])

    def test_a_session_id_too_long_for_a_button_is_left_off(self):
        self.LISTED = [{"id": "s", "conversationId": "c" * 80, "title": "Long", "status": "finished", "working": False}]
        self.tc.handle_archive(self.config, {})
        self.assertEqual(self.last_text(), "No finished sessions to archive.")


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
