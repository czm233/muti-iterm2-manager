# 项目级代理协作规则

## 默认响应策略

- 当用户提出任何需求时，先理解用户真实意图，再决定如何响应。
- 除非用户明确说明“不用 BMAD / 不走流程 / 直接回答”，否则优先尝试匹配并调用当前仓库内可用的 BMAD workflow、agent 或 skill 来处理问题。
- 优先级顺序：
  1. 先判断用户问题是否已经明显对应某个 BMAD skill / workflow
  2. 若能匹配，则优先按该流程执行，而不是直接凭常识自由回答
  3. 若存在多个可选流程，选择最小且最贴合当前任务的那个
  4. 若没有合适的 BMAD 流程，或流程无法覆盖当前问题，再退回普通直接回答

## 用户体验要求

- 用户不需要主动记忆或输入 BMAD 命令。
- 代理应主动完成“理解问题 → 选择合适 BMAD 流程 → 执行/解释结果”这一层路由。
- 在回复中可简短说明“这次我按哪个 BMAD 流程处理”，但不要把回复变成一堆命令教学，除非用户明确要求解释。

## 例外情况

- 如果用户明确要求：
  - 直接回答
  - 不要走 BMAD
  - 只做代码解释
  - 只做普通对话
  则按用户要求执行。
- 如果用户请求与 BMAD 流程冲突，以用户最新明确要求为准。

## 路由偏好

- 小功能 / 小修复：优先考虑 `bmad-bmm-quick-spec` → `bmad-bmm-quick-dev`
- 较大新功能：优先考虑从 `bmad-bmm-create-prd` 开始的完整流程
- 重构或架构调整：优先考虑 `bmad-bmm-create-architecture`
- 迭代规划：优先考虑 `bmad-bmm-sprint-planning`

## 版本号规则（强制执行）

- **每次修改代码都必须更新版本号**
- 版本号需要同步更新两个文件：
  - `pyproject.toml` → `version = "x.x.x"`
  - `src/multi_iterm2_manager/__init__.py` → `__version__ = "x.x.x"`
- 采用 patch 递增（如 0.1.1 → 0.1.2 → 0.1.3）

## 多 Claude 环境规则（强制执行）

- **本机有 4 个 Claude Code 环境需要同时支持**：
  - `claude`（官方 Claude Code）
  - `claude-glm`
  - `claude-glm51`
  - `claude-glmt5t`
- **所有涉及 Claude Code 配置的改动（如 hooks 注入）必须对这 4 个环境全部生效**
- 对应的配置目录可能各不相同，修改前必须先确认每个环境的 settings.json 位置
- 典型路径格式：`~/.claude/settings.json`、`~/.claude-glm/settings.json` 等

## 验收提示规则（强制执行）

- **每次修改完代码，等待用户验收时，必须告知：**
  1. 需不需要重启后端
     - 只有改了 Python 后端功能代码、影响运行时行为时才需要
     - 如果只是因为版本号规则修改了 `pyproject.toml` 和 `src/multi_iterm2_manager/__init__.py` 的版本号，不需要要求用户重启后端
  2. 需不需要强制刷新前端（改了 JS/CSS/HTML 静态文件需要刷新浏览器）
