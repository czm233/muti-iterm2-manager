"""终端内容 AI 摘要引擎"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from dataclasses import dataclass

import httpx

logger = logging.getLogger(__name__)

SUMMARY_MAX_CONCURRENCY = 3
SYSTEM_PROMPT = "你是一个终端内容分析助手。请用一句简短的中文总结当前终端正在做什么，不超过80字。只输出总结内容，不要有任何额外文字。"


@dataclass
class SummaryConfig:
    api_base: str = ""
    api_key: str = ""
    model: str = "glm-4.6"
    max_input_chars: int = 2000
    interval_seconds: float = 30.0
    fallback_last_lines: int = 3


@dataclass
class SummaryResult:
    text: str
    used_ai: bool
    from_cache: bool
    reason: str = ""
    error_detail: str = ""


class TerminalSummarizer:
    def __init__(self, config: SummaryConfig):
        self._config = config
        self._client: httpx.AsyncClient | None = None
        # id -> (summary, content_hash, timestamp, used_ai, reason, error_detail)
        self._cache: dict[str, tuple[str, str, float, bool, str, str]] = {}
        self._semaphore = asyncio.Semaphore(SUMMARY_MAX_CONCURRENCY)

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(timeout=15.0)
        return self._client

    @staticmethod
    def _content_hash(text: str) -> str:
        return hashlib.md5(text.encode()).hexdigest()[:12]

    @staticmethod
    def fallback_text(screen_text: str, last_lines: int = 3) -> str:
        lines = screen_text.strip().splitlines()
        tail = lines[-last_lines:] if lines else []
        text = "\n".join(tail).strip()
        return text[:200] if text else "暂无输出"

    def get_cached(self, terminal_id: str) -> str | None:
        entry = self._cache.get(terminal_id)
        if not entry:
            return None
        summary, _, ts, _, _, _ = entry
        if time.time() - ts > self._config.interval_seconds * 2:
            return None
        return summary

    @staticmethod
    def _extract_response_error_text(response: httpx.Response) -> str:
        try:
            data = response.json()
        except Exception:
            data = None

        if isinstance(data, dict):
            for key in ("message", "error", "detail"):
                value = data.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
                if isinstance(value, dict):
                    nested = value.get("message") or value.get("detail")
                    if isinstance(nested, str) and nested.strip():
                        return nested.strip()

        text = (response.text or "").strip()
        if not text:
            return ""
        compact = " ".join(text.split())
        return compact[:120]

    @classmethod
    def _format_error_detail(cls, exc: Exception) -> str:
        if isinstance(exc, httpx.HTTPStatusError):
            response = exc.response
            status = response.status_code
            if status == 429:
                base = "429 请求过多"
            elif status == 401:
                base = "401 认证失败"
            elif status == 403:
                base = "403 无权限"
            elif status == 404:
                base = "404 接口不存在"
            elif status == 408:
                base = "408 请求超时"
            elif status >= 500:
                base = f"{status} 服务异常"
            else:
                phrase = response.reason_phrase or "请求失败"
                base = f"{status} {phrase}"
            detail = cls._extract_response_error_text(response)
            if detail:
                return f"{base} · {detail}"
            return base
        if isinstance(exc, httpx.TimeoutException):
            return "请求超时"
        if isinstance(exc, httpx.ConnectError):
            return "连接失败"
        if isinstance(exc, httpx.NetworkError):
            return "网络错误"
        message = " ".join(str(exc).split()).strip()
        return message[:120] if message else exc.__class__.__name__

    async def summarize(self, terminal_id: str, screen_text: str) -> SummaryResult:
        """生成终端内容摘要。

        Returns:
            SummaryResult: 摘要文本、是否使用了 LLM 生成、是否来自缓存、失败原因等
        """
        text = screen_text.strip()
        if not text:
            return SummaryResult("暂无输出", False, False)

        new_hash = self._content_hash(text)
        cached = self._cache.get(terminal_id)
        if cached:
            _, old_hash, ts, used_ai, reason, error_detail = cached
            if old_hash == new_hash and time.time() - ts < self._config.interval_seconds:
                return SummaryResult(cached[0], used_ai, True, reason, error_detail)
            if time.time() - ts < self._config.interval_seconds:
                return SummaryResult(cached[0], used_ai, True, reason, error_detail)

        # 未配置 API 时直接 fallback
        if not self._config.api_base or not self._config.api_key:
            fallback = self.fallback_text(text, self._config.fallback_last_lines)
            self._cache[terminal_id] = (fallback, new_hash, time.time(), False, "no_api", "未配置 API")
            return SummaryResult(fallback, False, False, "no_api", "未配置 API")

        used_ai = False
        reason = ""
        error_detail = ""
        async with self._semaphore:
            try:
                truncated = text[-self._config.max_input_chars:]
                client = self._get_client()
                api_base = self._config.api_base.rstrip('/')

                # 根据 api_base 自动检测 API 类型
                if "anthropic" in api_base.lower():
                    summary = await self._call_anthropic_api(client, api_base, truncated)
                else:
                    summary = await self._call_openai_api(client, api_base, truncated)

                if summary:
                    used_ai = True
                else:
                    summary = self.fallback_text(text, self._config.fallback_last_lines)
                    reason = "empty_response"
                    error_detail = "模型返回空内容"
            except Exception as e:
                logger.warning("AI 摘要失败 terminal=%s: %s", terminal_id, e)
                reason = "api_error"
                error_detail = self._format_error_detail(e)
                summary = self.fallback_text(text, self._config.fallback_last_lines)

        self._cache[terminal_id] = (summary, new_hash, time.time(), used_ai, reason, error_detail)
        return SummaryResult(summary, used_ai, False, reason, error_detail)

    async def _call_openai_api(
        self, client: httpx.AsyncClient, api_base: str, truncated: str
    ) -> str:
        """调用 OpenAI 兼容格式的摘要接口"""
        url = f"{api_base}/chat/completions"
        resp = await client.post(
            url,
            headers={
                "Authorization": f"Bearer {self._config.api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": self._config.model,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": truncated},
                ],
                "max_tokens": 120,
                "temperature": 0.3,
            },
        )
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"].strip()

    async def _call_anthropic_api(
        self, client: httpx.AsyncClient, api_base: str, truncated: str
    ) -> str:
        """调用 Anthropic Messages API 格式的摘要接口"""
        url = f"{api_base}/v1/messages"
        resp = await client.post(
            url,
            headers={
                "x-api-key": self._config.api_key,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            },
            json={
                "model": self._config.model,
                "max_tokens": 120,
                "system": SYSTEM_PROMPT,
                "messages": [{"role": "user", "content": truncated}],
            },
        )
        resp.raise_for_status()
        data = resp.json()
        # Anthropic 响应格式: {"content": [{"type": "text", "text": "..."}]}
        content_blocks = data.get("content", [])
        for block in content_blocks:
            if block.get("type") == "text":
                return block["text"].strip()
        return ""

    async def close(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()
