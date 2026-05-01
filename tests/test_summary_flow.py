from __future__ import annotations

import time

import pytest

from multi_iterm2_manager.config import Settings
from multi_iterm2_manager.models import TerminalHandle, TerminalProgramInfo, TerminalRecord, TerminalStatus
from multi_iterm2_manager.service import DashboardService
from multi_iterm2_manager.summarizer import SummaryResult


class FakeSummarizer:
    def __init__(self, result: SummaryResult) -> None:
        self._result = result
        self.calls = 0

    async def summarize(self, terminal_id: str, screen_text: str) -> SummaryResult:
        self.calls += 1
        return self._result


def build_service() -> DashboardService:
    return DashboardService(Settings(backend="mock"))


def build_record(terminal_id: str = "terminal-1") -> TerminalRecord:
    return TerminalRecord(
        id=terminal_id,
        name="测试终端",
        handle=TerminalHandle(
            window_id=f"window-{terminal_id}",
            session_id=f"session-{terminal_id}",
        ),
        status=TerminalStatus.running,
        screen_text="python job.py\nstill working\n",
        content_stable_since=1.0,
    )


@pytest.mark.anyio
async def test_first_summary_broadcasts_summarizing_before_fallback() -> None:
    service = build_service()
    record = build_record()
    service.records[record.id] = record
    service._summarizer = FakeSummarizer(
        SummaryResult(
            text="fallback summary",
            used_ai=False,
            from_cache=False,
            reason="api_error",
            error_detail="429 请求过多",
        )
    )

    events: list[str] = []

    async def fake_broadcast(payload: dict) -> None:
        events.append(payload["terminal"]["aiSummaryStatus"])

    service._broadcast = fake_broadcast  # type: ignore[method-assign]

    await service._generate_summary(record.id)

    assert events == ["summarizing", "fallback"]
    assert record.ai_summary_status == "fallback"
    assert record.ai_summary_reason == "api_error"
    assert record.ai_summary_error_detail == "429 请求过多"
    assert record.ai_summary == "fallback summary"
    assert record.ai_summary_first is False


@pytest.mark.anyio
async def test_retry_from_fallback_broadcasts_summarizing_before_ai_result() -> None:
    service = build_service()
    record = build_record()
    record.ai_summary_first = False
    record.ai_summary_status = "fallback"
    record.ai_summary_reason = "api_error"
    record.ai_summary_error_detail = "429 请求过多"
    record.ai_summary = "old fallback"
    record.ai_summary_at = 0.0
    service.records[record.id] = record
    service._last_summary_status[record.id] = record.status.value
    service._summarizer = FakeSummarizer(
        SummaryResult(text="llm summary", used_ai=True, from_cache=False)
    )

    events: list[str] = []

    async def fake_broadcast(payload: dict) -> None:
        events.append(payload["terminal"]["aiSummaryStatus"])

    service._broadcast = fake_broadcast  # type: ignore[method-assign]

    await service._generate_summary(record.id)

    assert events == ["summarizing", "done"]
    assert record.ai_summary_status == "done"
    assert record.ai_summary == "llm summary"
    assert record.ai_summary_reason == ""
    assert record.ai_summary_error_detail == ""


@pytest.mark.anyio
async def test_cached_fallback_retry_restores_fallback_state() -> None:
    service = build_service()
    record = build_record()
    record.ai_summary_first = False
    record.ai_summary_status = "fallback"
    record.ai_summary_reason = "api_error"
    record.ai_summary_error_detail = "429 请求过多"
    record.ai_summary = "cached fallback"
    record.ai_summary_at = 123.0
    service.records[record.id] = record
    service._last_summary_status[record.id] = record.status.value
    service._summarizer = FakeSummarizer(
        SummaryResult(
            text="cached fallback",
            used_ai=False,
            from_cache=True,
            reason="api_error",
            error_detail="429 请求过多",
        )
    )

    events: list[tuple[str, str]] = []

    async def fake_broadcast(payload: dict) -> None:
        terminal = payload["terminal"]
        events.append((terminal["aiSummaryStatus"], terminal["aiSummaryReason"]))

    service._broadcast = fake_broadcast  # type: ignore[method-assign]

    await service._generate_summary(record.id)

    assert events == [("summarizing", ""), ("fallback", "api_error")]
    assert record.ai_summary_status == "fallback"
    assert record.ai_summary_reason == "api_error"
    assert record.ai_summary_error_detail == "429 请求过多"
    assert record.ai_summary == "cached fallback"


@pytest.mark.anyio
async def test_failed_summary_retry_respects_cooldown() -> None:
    service = build_service()
    record = build_record()
    record.ai_summary_first = False
    record.ai_summary_status = "fallback"
    record.ai_summary_reason = "api_error"
    record.ai_summary_error_detail = "429 请求过多"
    record.ai_summary = "cached fallback"
    record.ai_summary_at = time.time()
    service.records[record.id] = record
    service._last_summary_status[record.id] = record.status.value
    fake = FakeSummarizer(
        SummaryResult(text="should not run", used_ai=True, from_cache=False)
    )
    service._summarizer = fake

    events: list[str] = []

    async def fake_broadcast(payload: dict) -> None:
        events.append(payload["terminal"]["aiSummaryStatus"])

    service._broadcast = fake_broadcast  # type: ignore[method-assign]

    await service._generate_summary(record.id)

    assert fake.calls == 0
    assert events == []
    assert record.ai_summary_status == "fallback"
    assert record.ai_summary_error_detail == "429 请求过多"


@pytest.mark.anyio
async def test_failed_summary_retry_uses_fallback_retry_interval() -> None:
    service = DashboardService(
        Settings(
            backend="mock",
            summary_interval_seconds=300,
            summary_fallback_retry_interval=5,
        )
    )
    record = build_record()
    record.ai_summary_first = False
    record.ai_summary_status = "fallback"
    record.ai_summary_reason = "api_error"
    record.ai_summary_error_detail = "请求超时"
    record.ai_summary = "old fallback"
    record.ai_summary_at = time.time() - 6
    service.records[record.id] = record
    service._last_summary_status[record.id] = record.status.value
    fake = FakeSummarizer(
        SummaryResult(text="retry summary", used_ai=True, from_cache=False)
    )
    service._summarizer = fake

    await service._generate_summary(record.id)

    assert fake.calls == 1
    assert record.ai_summary_status == "done"
    assert record.ai_summary == "retry summary"


@pytest.mark.anyio
async def test_forced_summary_bypasses_failed_retry_cooldown() -> None:
    service = build_service()
    record = build_record()
    record.ai_summary_first = False
    record.ai_summary_status = "fallback"
    record.ai_summary_reason = "api_error"
    record.ai_summary_error_detail = "请求超时"
    record.ai_summary = "old fallback"
    record.ai_summary_at = time.time()
    service.records[record.id] = record
    service._last_summary_status[record.id] = record.status.value
    fake = FakeSummarizer(
        SummaryResult(text="new llm summary", used_ai=True, from_cache=False)
    )
    service._summarizer = fake

    events: list[str] = []

    async def fake_broadcast(payload: dict) -> None:
        events.append(payload["terminal"]["aiSummaryStatus"])

    service._broadcast = fake_broadcast  # type: ignore[method-assign]

    await service._generate_summary(record.id, force=True)

    assert fake.calls == 1
    assert events == ["summarizing", "done"]
    assert record.ai_summary_status == "done"
    assert record.ai_summary == "new llm summary"
    assert record.ai_summary_reason == ""
    assert record.ai_summary_error_detail == ""


@pytest.mark.anyio
async def test_new_terminal_suspends_auto_summary_until_resumed() -> None:
    service = build_service()
    record = build_record()
    service.records[record.id] = record
    service._summarizer = FakeSummarizer(SummaryResult(text="llm summary", used_ai=True, from_cache=False))

    service._skip_initial_summary_until_content_changes(record)

    await service._generate_summary(record.id)

    assert service._summarizer.calls == 0
    assert record.ai_summary_status == "none"
    assert record.ai_summary_reason == "idle"

    service._apply_screen_text(
        record,
        record.screen_text + "new output\n",
        "<pre>new output</pre>",
        is_live=True,
        queue_summary=False,
    )
    await service._generate_summary(record.id)

    assert service._summarizer.calls == 0
    assert record.ai_summary_status == "none"

    service._resume_auto_summary_for_terminal(record)
    await service._generate_summary(record.id)

    assert service._summarizer.calls == 1
    assert record.ai_summary_status == "done"
    assert record.ai_summary == "llm summary"


def test_last_interaction_uses_agent_content_changes_after_baseline() -> None:
    service = build_service()
    record = build_record()
    record.screen_text = ""
    record.content_hash = ""
    record.program = TerminalProgramInfo(key="codex", label="Codex")

    service._apply_screen_text(
        record,
        (
            "Working (9s • esc to interrupt)\n"
            "gpt-5.5 xhigh · ~/repo · Context 27% used · "
            "0.125.0 · Fast on · 380K window · Working · 019dc9b8\n"
        ),
        "<pre>status</pre>",
        is_live=False,
        queue_summary=False,
    )

    assert record.last_interaction_at == 0.0

    service._apply_screen_text(
        record,
        (
            "Working (14s • esc to interrupt)\n"
            "gpt-5.5 xhigh · ~/repo · Context 28% used · "
            "0.125.0 · Fast on · 380K window · Working · 019dc9b8\n"
        ),
        "<pre>status changed</pre>",
        is_live=True,
        queue_summary=False,
    )

    assert record.last_interaction_at == 0.0

    service._apply_screen_text(
        record,
        "user: hello\nassistant: hi\n",
        "<pre>user: hello\nassistant: hi</pre>",
        is_live=True,
        queue_summary=False,
    )

    assert record.last_interaction_at > 0.0
    previous_interaction_at = record.last_interaction_at
    record.program = TerminalProgramInfo(key="shell", label="Shell")

    service._apply_screen_text(
        record,
        "Codex ready\nuser: hello\nassistant: hi\nshell output\n",
        "<pre>shell output</pre>",
        is_live=True,
        queue_summary=False,
    )

    assert record.last_interaction_at == previous_interaction_at


def test_focused_codex_working_bypasses_idle_to_running_focus_guard() -> None:
    service = build_service()
    record = build_record()
    record.status = TerminalStatus.done
    record.screen_text = "$ "
    service.backend.is_session_focused = lambda session_id: True

    service._apply_screen_text(
        record,
        "\n".join([
            "Working (9s • Ctrl+C to interrupt)",
            "gpt-5.5 xhigh",
            "Context 27% left",
        ]),
        "<pre>working</pre>",
        is_live=True,
        queue_summary=False,
    )

    assert record.status == TerminalStatus.running
    assert record.markers == ["codex-working-indicator"]
    assert record.id not in service._focus_suppressed


def test_focused_shell_typing_still_does_not_flip_idle_to_running() -> None:
    service = build_service()
    record = build_record()
    record.status = TerminalStatus.done
    record.screen_text = "$ "
    service.backend.is_session_focused = lambda session_id: True

    service._apply_screen_text(
        record,
        "$ python",
        "<pre>$ python</pre>",
        is_live=True,
        queue_summary=False,
    )

    assert record.status == TerminalStatus.done
    assert record.id in service._focus_suppressed


@pytest.mark.anyio
async def test_focus_terminal_resumes_suspended_summary_and_queues_work() -> None:
    service = build_service()
    record = build_record()
    service.records[record.id] = record
    service._summarizer = FakeSummarizer(SummaryResult(text="llm summary", used_ai=True, from_cache=False))

    service._skip_initial_summary_until_content_changes(record)

    await service.focus_terminal(record.id)

    assert record.last_interaction_at == 0.0
    assert record.id not in service._summary_suspended_terminal_ids
    assert record.id not in service._summary_skipped_initial_hash
    assert service._summary_work_queue().get_nowait() == record.id


@pytest.mark.anyio
async def test_set_primary_enforces_single_terminal() -> None:
    service = build_service()
    first = build_record("terminal-1")
    second = build_record("terminal-2")
    service.records[first.id] = first
    service.records[second.id] = second

    result = await service.set_primary(first.id, True)

    assert result["isPrimary"] is True
    assert first.is_primary is True
    assert second.is_primary is False

    await service.set_primary(second.id, True)

    assert first.is_primary is False
    assert second.is_primary is True


@pytest.mark.anyio
async def test_unset_primary_clears_primary_flag() -> None:
    service = build_service()
    record = build_record("terminal-3")
    service.records[record.id] = record

    await service.set_primary(record.id, True)
    result = await service.set_primary(record.id, False)

    assert result["isPrimary"] is False
    assert record.is_primary is False
