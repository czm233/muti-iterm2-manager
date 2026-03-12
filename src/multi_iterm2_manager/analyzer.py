from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from multi_iterm2_manager.models import TerminalStatus


@dataclass
class DetectionRule:
    name: str
    status: TerminalStatus
    type: str  # "content" | "timeout"
    priority: int = 0
    patterns: list[re.Pattern[str]] = field(default_factory=list)
    last_n_lines: int | None = None
    seconds: float = 0.0
    require_patterns: list[re.Pattern[str]] = field(default_factory=list)
    exclude_patterns: list[re.Pattern[str]] = field(default_factory=list)


@dataclass
class RuleEngineConfig:
    default_status: TerminalStatus = TerminalStatus.running
    default_last_n_lines: int = 20
    rules: list[DetectionRule] = field(default_factory=list)


VALID_RULE_TYPES = {"content", "timeout"}

# 包目录下的默认 rules.yaml 回退路径
_PACKAGE_DIR = Path(__file__).parent
_FALLBACK_RULES_PATH = _PACKAGE_DIR.parent.parent / "rules.yaml"


def _compile_patterns(raw: list[str] | None) -> list[re.Pattern[str]]:
    if not raw:
        return []
    return [re.compile(p, re.IGNORECASE) for p in raw]


def load_rules(path: str) -> RuleEngineConfig:
    """读取 YAML 规则文件，解析为 RuleEngineConfig。文件不存在时尝试回退路径，仍无则返回兜底配置。"""
    file_path = Path(path)
    if not file_path.is_file():
        # 尝试包目录的回退路径
        if _FALLBACK_RULES_PATH.is_file():
            file_path = _FALLBACK_RULES_PATH
            print(f"[rules] {path} 未找到，使用回退路径: {file_path}", flush=True)
        else:
            print(f"[rules] 警告: 规则文件 {path} 未找到，使用默认配置（所有终端显示 running）", flush=True)
            return RuleEngineConfig()

    try:
        with open(file_path, encoding="utf-8") as f:
            data = yaml.safe_load(f)

        if not data:
            return RuleEngineConfig()

        settings = data.get("settings", {})
        default_status_str = settings.get("default_status", "running")
        default_status = TerminalStatus(default_status_str)
        default_last_n_lines = int(settings.get("default_last_n_lines", 20))

        rules: list[DetectionRule] = []
        for raw_rule in data.get("rules", []):
            rule_name = raw_rule.get("name", "<unnamed>")
            rule_type = raw_rule.get("type", "")
            # F7: 校验规则类型
            if rule_type not in VALID_RULE_TYPES:
                print(f"[rules] 警告: 规则 '{rule_name}' 的 type='{rule_type}' 无效（允许: {VALID_RULE_TYPES}），已跳过", flush=True)
                continue
            status = TerminalStatus(raw_rule["status"])
            rule = DetectionRule(
                name=rule_name,
                status=status,
                type=rule_type,
                priority=int(raw_rule.get("priority", 0)),
                patterns=_compile_patterns(raw_rule.get("patterns")),
                last_n_lines=raw_rule.get("last_n_lines"),
                seconds=float(raw_rule.get("seconds", 0)),
                require_patterns=_compile_patterns(raw_rule.get("require_patterns")),
                exclude_patterns=_compile_patterns(raw_rule.get("exclude_patterns")),
            )
            rules.append(rule)

        # 按 priority 降序排序
        rules.sort(key=lambda r: r.priority, reverse=True)
        print(f"[rules] 成功加载 {len(rules)} 条规则 (from {file_path})", flush=True)

        return RuleEngineConfig(
            default_status=default_status,
            default_last_n_lines=default_last_n_lines,
            rules=rules,
        )
    except Exception as exc:
        print(f"[rules] 错误: 解析规则文件 {file_path} 失败: {exc}，使用默认配置", flush=True)
        return RuleEngineConfig()


def _get_last_n_lines(text: str, n: int) -> str:
    """取文本最后 n 行"""
    lines = text.splitlines()
    return "\n".join(lines[-n:])


def _match_content_rule(rule: DetectionRule, text: str, default_last_n_lines: int) -> bool:
    """检查内容规则是否命中"""
    n = rule.last_n_lines if rule.last_n_lines is not None else default_last_n_lines
    segment = _get_last_n_lines(text, n)
    for pattern in rule.patterns:
        if pattern.search(segment):
            return True
    return False


def _match_timeout_rule(rule: DetectionRule, text: str, stable_seconds: float, default_last_n_lines: int) -> bool:
    """检查超时规则是否命中"""
    if stable_seconds < rule.seconds:
        return False

    n = rule.last_n_lines if rule.last_n_lines is not None else default_last_n_lines
    segment = _get_last_n_lines(text, n)

    # require_patterns：有则必须至少一个匹配
    if rule.require_patterns:
        if not any(p.search(segment) for p in rule.require_patterns):
            return False

    # exclude_patterns：有则任一匹配时规则不通过
    if rule.exclude_patterns:
        if any(p.search(segment) for p in rule.exclude_patterns):
            return False

    return True


def analyze_screen_text(
    text: str,
    stable_seconds: float,
    config: RuleEngineConfig,
) -> tuple[TerminalStatus, list[str], str]:
    """
    规则引擎核心：根据规则配置分析终端屏幕文本。

    返回 (状态, 命中规则名列表, 摘要文本)
    """
    normalized = text.strip()
    if not normalized:
        return TerminalStatus.idle, [], "暂无输出"

    for rule in config.rules:
        matched = False
        if rule.type == "content":
            matched = _match_content_rule(rule, normalized, config.default_last_n_lines)
        elif rule.type == "timeout":
            matched = _match_timeout_rule(rule, normalized, stable_seconds, config.default_last_n_lines)

        if matched:
            return rule.status, [rule.name], summarize_text(normalized)

    return config.default_status, [], summarize_text(normalized)


def analyze_timeout_only(
    text: str,
    stable_seconds: float,
    config: RuleEngineConfig,
) -> tuple[TerminalStatus, list[str], str] | None:
    """只检查 timeout 类规则，跳过 content 规则。命中则返回结果，未命中返回 None。"""
    normalized = text.strip()
    if not normalized:
        return None

    for rule in config.rules:
        if rule.type != "timeout":
            continue
        if _match_timeout_rule(rule, normalized, stable_seconds, config.default_last_n_lines):
            return rule.status, [rule.name], summarize_text(normalized)

    return None


def summarize_text(text: str, max_lines: int = 3, max_chars: int = 240) -> str:
    lines = [line.rstrip() for line in text.splitlines() if line.strip()]
    if not lines:
        return "暂无输出"

    summary = " | ".join(lines[-max_lines:])
    if len(summary) > max_chars:
        return summary[-max_chars:]
    return summary
