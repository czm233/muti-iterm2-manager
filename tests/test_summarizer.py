from __future__ import annotations

import json

import httpx
import pytest

from multi_iterm2_manager.summarizer import DEFAULT_FREE_FALLBACK_MODEL, SummaryConfig, TerminalSummarizer


@pytest.mark.anyio
async def test_glm_free_fallback_model_used_after_primary_quota_error() -> None:
    requests: list[dict] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content.decode("utf-8"))
        requests.append(payload)
        if len(requests) == 1:
            return httpx.Response(429, json={"error": {"message": "quota exceeded"}})
        return httpx.Response(200, json={"choices": [{"message": {"content": "正在运行测试"}}]})

    summarizer = TerminalSummarizer(
        SummaryConfig(
            api_base="https://open.bigmodel.cn/api/paas/v4",
            api_key="test-key",
            model="glm-4.6",
        )
    )
    summarizer._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        result = await summarizer.summarize("terminal-1", "pytest tests\n")
    finally:
        await summarizer.close()

    assert result.text == "正在运行测试"
    assert result.used_ai is True
    assert result.reason == ""
    assert [payload["model"] for payload in requests] == ["glm-4.6", DEFAULT_FREE_FALLBACK_MODEL]
    assert requests[1]["thinking"] == {"type": "disabled"}


@pytest.mark.anyio
async def test_glm_free_fallback_switches_anthropic_base_to_openai_base() -> None:
    request_paths: list[str] = []
    request_models: list[str | None] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        request_paths.append(request.url.path)
        if request.url.path.endswith("/chat/completions"):
            payload = json.loads(request.content.decode("utf-8"))
            request_models.append(payload.get("model"))
            return httpx.Response(200, json={"choices": [{"message": {"content": "正在总结终端"}}]})
        return httpx.Response(429, json={"error": {"message": "quota exceeded"}})

    summarizer = TerminalSummarizer(
        SummaryConfig(
            api_base="https://open.bigmodel.cn/api/anthropic",
            api_key="test-key",
            model="GLM-4.5",
        )
    )
    summarizer._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        result = await summarizer.summarize("terminal-1", "claude is working\n")
    finally:
        await summarizer.close()

    assert result.text == "正在总结终端"
    assert result.used_ai is True
    assert request_paths == ["/api/anthropic/v1/messages", "/api/paas/v4/chat/completions"]
    assert request_models == [DEFAULT_FREE_FALLBACK_MODEL]


@pytest.mark.anyio
async def test_glm_free_fallback_skipped_for_non_glm_api_base() -> None:
    request_count = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal request_count
        request_count += 1
        return httpx.Response(429, json={"error": {"message": "quota exceeded"}})

    summarizer = TerminalSummarizer(
        SummaryConfig(
            api_base="https://api.openai.example/v1",
            api_key="test-key",
            model="gpt-example",
        )
    )
    summarizer._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        result = await summarizer.summarize("terminal-1", "npm run build\n")
    finally:
        await summarizer.close()

    assert request_count == 1
    assert result.used_ai is False
    assert result.reason == "api_error"
    assert "429 请求过多" in result.error_detail


@pytest.mark.anyio
async def test_glm_free_fallback_can_be_disabled_with_empty_model() -> None:
    request_count = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal request_count
        request_count += 1
        return httpx.Response(429, json={"error": {"message": "quota exceeded"}})

    summarizer = TerminalSummarizer(
        SummaryConfig(
            api_base="https://open.bigmodel.cn/api/paas/v4",
            api_key="test-key",
            model="glm-4.6",
            free_fallback_model="",
        )
    )
    summarizer._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        result = await summarizer.summarize("terminal-1", "npm run build\n")
    finally:
        await summarizer.close()

    assert request_count == 1
    assert result.used_ai is False
    assert result.reason == "api_error"
    assert result.error_detail.startswith("主模型(glm-4.6)失败：429 请求过多")
    assert "免费兜底" not in result.error_detail


@pytest.mark.anyio
async def test_glm_free_fallback_error_names_primary_and_fallback_models() -> None:
    request_models: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content.decode("utf-8"))
        request_models.append(payload["model"])
        return httpx.Response(500)

    summarizer = TerminalSummarizer(
        SummaryConfig(
            api_base="https://open.bigmodel.cn/api/paas/v4",
            api_key="test-key",
            model="glm-4.6",
        )
    )
    summarizer._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        result = await summarizer.summarize("terminal-1", "npm run build\n")
    finally:
        await summarizer.close()

    assert request_models == ["glm-4.6", DEFAULT_FREE_FALLBACK_MODEL]
    assert result.used_ai is False
    assert result.reason == "api_error"
    assert "主模型(glm-4.6)失败：500 服务异常" in result.error_detail
    assert f"免费兜底({DEFAULT_FREE_FALLBACK_MODEL})失败：500 服务异常" in result.error_detail
