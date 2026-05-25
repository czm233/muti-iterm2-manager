"""终端内容 AI 摘要引擎"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from dataclasses import dataclass

import httpx

logger = logging.getLogger(__name__)

SUMMARY_MAX_CONCURRENCY = 3
DEFAULT_SUMMARY_TITLE_MAX_CHARS = 12
SYSTEM_PROMPT = (
    "你是一个终端内容分析助手。请基于终端内容输出 JSON，不要 Markdown。"
    "JSON 必须包含 summary 和 title 两个字符串字段。"
    "summary 用一句简短中文总结当前终端正在做什么，不超过80字。"
    f"title 是极简中文标题，优先4到8个字，最多{DEFAULT_SUMMARY_TITLE_MAX_CHARS}个字，"
    "表达清楚，不要结尾标点。"
)
DEFAULT_FREE_FALLBACK_MODEL = "glm-4.7-flash"
DEFAULT_GLM_OPENAI_API_BASE = "https://open.bigmodel.cn/api/paas/v4"
GLM_API_BASE_MARKERS = ("bigmodel.cn", "z.ai")
TITLE_TRAILING_PUNCTUATION = " \t\r\n。！？；：，、,.!?:;\"'`“”‘’（）()[]【】"


@dataclass
class SummaryConfig:
    api_base: str = ""
    api_key: str = ""
    model: str = "glm-4.6"
    free_fallback_model: str = DEFAULT_FREE_FALLBACK_MODEL
    max_input_chars: int = 2000
    interval_seconds: float = 30.0
    fallback_last_lines: int = 3
    title_max_chars: int = DEFAULT_SUMMARY_TITLE_MAX_CHARS


@dataclass
class SummaryResult:
    text: str
    used_ai: bool
    from_cache: bool
    reason: str = ""
    error_detail: str = ""
    title: str = ""


@dataclass
class GeneratedSummary:
    text: str
    title: str = ""


class TerminalSummarizer:
    def __init__(self, config: SummaryConfig):
        self._config = config
        self._client: httpx.AsyncClient | None = None
        # id -> (summary, title, content_hash, timestamp, used_ai, reason, error_detail)
        self._cache: dict[str, tuple[str, str, str, float, bool, str, str]] = {}
        self._semaphore = asyncio.Semaphore(SUMMARY_MAX_CONCURRENCY)

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(timeout=15.0)
        return self._client

    @staticmethod
    def _content_hash(text: str) -> str:
        return hashlib.md5(text.encode()).hexdigest()[:12]

    def _title_max_chars(self) -> int:
        try:
            configured = int(self._config.title_max_chars)
        except (TypeError, ValueError):
            configured = DEFAULT_SUMMARY_TITLE_MAX_CHARS
        return max(1, min(60, configured))

    def _system_prompt(self) -> str:
        title_max_chars = self._title_max_chars()
        return (
            "你是一个终端内容分析助手。请基于终端内容输出 JSON，不要 Markdown。"
            "JSON 必须包含 summary 和 title 两个字符串字段。"
            "summary 用一句简短中文总结当前终端正在做什么，不超过80字。"
            f"title 是极简中文标题，优先4到8个字，最多{title_max_chars}个字，"
            "表达清楚，不要结尾标点。"
        )

    @staticmethod
    def _normalize_title(title: str, max_chars: int) -> str:
        text = " ".join(str(title or "").split()).strip(TITLE_TRAILING_PUNCTUATION)
        for prefix in ("标题:", "标题：", "title:", "Title:"):
            if text.startswith(prefix):
                text = text[len(prefix):].strip()
        text = text.strip(TITLE_TRAILING_PUNCTUATION)
        if len(text) > max_chars:
            text = text[:max_chars].strip(TITLE_TRAILING_PUNCTUATION)
        return text

    @classmethod
    def fallback_title(cls, summary: str, max_chars: int = DEFAULT_SUMMARY_TITLE_MAX_CHARS) -> str:
        text = " ".join(str(summary or "").split()).strip()
        for separator in ("。", "，", "；", ";", "|", "\n"):
            if separator in text:
                text = text.split(separator, 1)[0].strip()
        try:
            configured = int(max_chars or DEFAULT_SUMMARY_TITLE_MAX_CHARS)
        except (TypeError, ValueError):
            configured = DEFAULT_SUMMARY_TITLE_MAX_CHARS
        return cls._normalize_title(text, max(1, min(60, configured)))

    @classmethod
    def _parse_generated_summary(cls, raw_content: str, title_max_chars: int) -> GeneratedSummary:
        content = str(raw_content or "").strip()
        if not content:
            return GeneratedSummary("")

        json_source = content
        if json_source.startswith("```"):
            lines = json_source.splitlines()
            if len(lines) >= 3:
                json_source = "\n".join(lines[1:-1]).strip()

        payload: dict | None = None
        for candidate in (json_source, json_source[json_source.find("{"): json_source.rfind("}") + 1]):
            if not candidate.strip():
                continue
            try:
                decoded = json.loads(candidate)
            except Exception:
                continue
            if isinstance(decoded, dict):
                payload = decoded
                break

        if payload is not None:
            summary = str(payload.get("summary") or payload.get("text") or payload.get("摘要") or "").strip()
            title = str(payload.get("title") or payload.get("标题") or "").strip()
            if summary:
                clean_title = cls._normalize_title(title, title_max_chars) or cls.fallback_title(summary, title_max_chars)
                return GeneratedSummary(summary, clean_title)

        summary = content
        return GeneratedSummary(summary, cls.fallback_title(summary, title_max_chars))

    @staticmethod
    def _is_glm_api_base(api_base: str) -> bool:
        lower = api_base.lower()
        return any(marker in lower for marker in GLM_API_BASE_MARKERS)

    @staticmethod
    def _free_fallback_api_base(api_base: str) -> str:
        lower = api_base.lower().rstrip("/")
        if "open.bigmodel.cn/api/anthropic" in lower:
            return DEFAULT_GLM_OPENAI_API_BASE
        return api_base

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
        summary, _, _, ts, _, _, _ = entry
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

    @staticmethod
    def _format_model_error(label: str, model: str, detail: str) -> str:
        display_model = model.strip() or "未指定模型"
        display_detail = detail.strip() or "请求失败"
        return f"{label}({display_model})失败：{display_detail}"

    def _should_try_free_fallback(self, api_base: str) -> bool:
        fallback_model = self._config.free_fallback_model.strip()
        primary_model = self._config.model.strip()
        return (
            bool(fallback_model)
            and fallback_model.lower() != primary_model.lower()
            and self._is_glm_api_base(api_base)
        )

    async def _try_free_fallback_api(
        self,
        client: httpx.AsyncClient,
        api_base: str,
        truncated: str,
        *,
        terminal_id: str,
    ) -> tuple[GeneratedSummary | None, str]:
        if not self._should_try_free_fallback(api_base):
            return None, ""

        fallback_api_base = self._free_fallback_api_base(api_base)
        fallback_model = self._config.free_fallback_model.strip()
        started = time.monotonic()
        try:
            logger.info(
                "AI 摘要免费兜底请求开始 terminal=%s model=%s api_base=%s",
                terminal_id,
                fallback_model,
                fallback_api_base,
            )
            summary = await self._call_openai_api(
                client,
                fallback_api_base,
                truncated,
                model=fallback_model,
            )
            elapsed = time.monotonic() - started
            if summary.text:
                logger.info(
                    "AI 摘要免费兜底请求成功 terminal=%s model=%s elapsed=%.2fs",
                    terminal_id,
                    fallback_model,
                    elapsed,
                )
                return summary, ""
            logger.warning(
                "AI 摘要免费兜底返回空内容 terminal=%s model=%s elapsed=%.2fs",
                terminal_id,
                fallback_model,
                elapsed,
            )
            return None, self._format_model_error("免费兜底", fallback_model, "模型返回空内容")
        except Exception as exc:
            elapsed = time.monotonic() - started
            detail = self._format_error_detail(exc)
            logger.warning(
                "AI 摘要免费兜底请求失败 terminal=%s model=%s api_base=%s elapsed=%.2fs detail=%s",
                terminal_id,
                fallback_model,
                fallback_api_base,
                elapsed,
                detail,
            )
            return None, self._format_model_error("免费兜底", fallback_model, detail)

    @staticmethod
    def _append_free_fallback_error(primary_detail: str, fallback_detail: str) -> str:
        if not fallback_detail:
            return primary_detail
        if not primary_detail:
            return fallback_detail
        return f"{primary_detail}；{fallback_detail}"

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
            cached_summary, cached_title, old_hash, ts, used_ai, reason, error_detail = cached
            if old_hash == new_hash and time.time() - ts < self._config.interval_seconds:
                return SummaryResult(cached_summary, used_ai, True, reason, error_detail, title=cached_title)
            if time.time() - ts < self._config.interval_seconds:
                return SummaryResult(cached_summary, used_ai, True, reason, error_detail, title=cached_title)

        # 未配置 API 时直接 fallback
        if not self._config.api_base or not self._config.api_key:
            fallback = self.fallback_text(text, self._config.fallback_last_lines)
            title = self.fallback_title(fallback, self._title_max_chars())
            self._cache[terminal_id] = (fallback, title, new_hash, time.time(), False, "no_api", "未配置 API")
            return SummaryResult(fallback, False, False, "no_api", "未配置 API", title=title)

        used_ai = False
        reason = ""
        error_detail = ""
        title = ""
        async with self._semaphore:
            truncated = text[-self._config.max_input_chars:]
            client = self._get_client()
            api_base = self._config.api_base.rstrip('/')
            primary_model = self._config.model.strip()
            primary_protocol = "anthropic" if "anthropic" in api_base.lower() else "openai"
            started = time.monotonic()
            try:
                # 根据 api_base 自动检测 API 类型
                logger.info(
                    "AI 摘要主请求开始 terminal=%s model=%s api_base=%s protocol=%s",
                    terminal_id,
                    primary_model,
                    api_base,
                    primary_protocol,
                )
                if "anthropic" in api_base.lower():
                    generated = await self._call_anthropic_api(client, api_base, truncated)
                else:
                    generated = await self._call_openai_api(client, api_base, truncated)
                elapsed = time.monotonic() - started

                if generated.text:
                    logger.info(
                        "AI 摘要主请求成功 terminal=%s model=%s elapsed=%.2fs",
                        terminal_id,
                        primary_model,
                        elapsed,
                    )
                    used_ai = True
                    summary = generated.text
                    title = generated.title
                else:
                    primary_error = self._format_model_error("主模型", primary_model, "模型返回空内容")
                    logger.warning(
                        "AI 摘要主请求返回空内容 terminal=%s model=%s elapsed=%.2fs",
                        terminal_id,
                        primary_model,
                        elapsed,
                    )
                    fallback_summary, fallback_error = await self._try_free_fallback_api(
                        client,
                        api_base,
                        truncated,
                        terminal_id=terminal_id,
                    )
                    if fallback_summary:
                        summary = fallback_summary.text
                        title = fallback_summary.title
                        used_ai = True
                    else:
                        summary = self.fallback_text(text, self._config.fallback_last_lines)
                        title = self.fallback_title(summary, self._title_max_chars())
                        reason = "empty_response"
                        error_detail = self._append_free_fallback_error(primary_error, fallback_error)
            except Exception as e:
                elapsed = time.monotonic() - started
                primary_detail = self._format_error_detail(e)
                primary_error = self._format_model_error("主模型", primary_model, primary_detail)
                logger.warning(
                    "AI 摘要主请求失败 terminal=%s model=%s api_base=%s protocol=%s elapsed=%.2fs detail=%s",
                    terminal_id,
                    primary_model,
                    api_base,
                    primary_protocol,
                    elapsed,
                    primary_detail,
                )
                fallback_summary, fallback_error = await self._try_free_fallback_api(
                    client,
                    api_base,
                    truncated,
                    terminal_id=terminal_id,
                )
                if fallback_summary:
                    summary = fallback_summary.text
                    title = fallback_summary.title
                    used_ai = True
                else:
                    reason = "api_error"
                    error_detail = self._append_free_fallback_error(
                        primary_error,
                        fallback_error,
                    )
                    summary = self.fallback_text(text, self._config.fallback_last_lines)
                    title = self.fallback_title(summary, self._title_max_chars())

        if not title:
            title = self.fallback_title(summary, self._title_max_chars())
        self._cache[terminal_id] = (summary, title, new_hash, time.time(), used_ai, reason, error_detail)
        return SummaryResult(summary, used_ai, False, reason, error_detail, title=title)

    async def _call_openai_api(
        self,
        client: httpx.AsyncClient,
        api_base: str,
        truncated: str,
        *,
        model: str | None = None,
    ) -> GeneratedSummary:
        """调用 OpenAI 兼容格式的摘要接口"""
        url = f"{api_base}/chat/completions"
        payload = {
            "model": model or self._config.model,
            "messages": [
                {"role": "system", "content": self._system_prompt()},
                {"role": "user", "content": truncated},
            ],
            "max_tokens": 180,
            "temperature": 0.3,
        }
        if self._is_glm_api_base(api_base):
            payload["thinking"] = {"type": "disabled"}
        resp = await client.post(
            url,
            headers={
                "Authorization": f"Bearer {self._config.api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
        )
        resp.raise_for_status()
        data = resp.json()
        content = data["choices"][0]["message"]["content"].strip()
        return self._parse_generated_summary(content, self._title_max_chars())

    async def _call_anthropic_api(
        self, client: httpx.AsyncClient, api_base: str, truncated: str
    ) -> GeneratedSummary:
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
                "max_tokens": 180,
                "system": self._system_prompt(),
                "messages": [{"role": "user", "content": truncated}],
            },
        )
        resp.raise_for_status()
        data = resp.json()
        # Anthropic 响应格式: {"content": [{"type": "text", "text": "..."}]}
        content_blocks = data.get("content", [])
        for block in content_blocks:
            if block.get("type") == "text":
                return self._parse_generated_summary(block["text"].strip(), self._title_max_chars())
        return GeneratedSummary("")

    async def close(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()
