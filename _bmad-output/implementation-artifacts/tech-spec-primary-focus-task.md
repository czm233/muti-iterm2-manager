---
title: '最重要任务强提醒'
slug: 'primary-focus-task'
created: '2026-04-22'
status: 'Implementation Complete'
stepsCompleted: [1, 2, 3, 4]
tech_stack:
  - 'Python 3.9+'
  - 'FastAPI'
  - 'Vanilla JS'
  - 'CSS'
files_to_modify:
  - 'src/multi_iterm2_manager/models.py'
  - 'src/multi_iterm2_manager/backend/base.py'
  - 'src/multi_iterm2_manager/backend/iterm2_backend.py'
  - 'src/multi_iterm2_manager/backend/mock.py'
  - 'src/multi_iterm2_manager/service.py'
  - 'src/multi_iterm2_manager/server.py'
  - 'src/multi_iterm2_manager/static/index.html'
  - 'src/multi_iterm2_manager/static/app.js'
  - 'src/multi_iterm2_manager/static/styles.css'
  - 'tests/test_summary_flow.py'
code_patterns:
  - '运行时状态放在 TerminalRecord，并通过 to_dict 下发前端'
  - '后端唯一性约束由 DashboardService 保证，路由层只转发'
  - 'iTerm2 session 变量用于跨重启恢复隐藏/静默/标签等状态'
  - '前端通过 WebSocket snapshot/terminal-updated 同步状态'
test_patterns:
  - 'pytest + anyio'
  - '优先补 service 层聚焦逻辑测试'
---

# Tech-Spec: 最重要任务强提醒

## Overview

### Problem Statement

当前监控墙已有待处理队列和 waiting 提示音，但缺少“当前唯一最重要任务”的显式表达。用户在多个 agent 任务并行时，无法持续把注意力锁定到当前主任务。

### Solution

新增一个独立于标签和待处理队列的“最重要任务”状态。用户通过右键菜单对任意终端设置或取消该状态，后端保证全局最多只有一个最重要任务；前端为该任务提供稳定高亮、顶部固定入口和轻度动态提醒。

### Scope

**In Scope:**
- 右键菜单中新增“标记为最重要任务 / 取消最重要任务”
- 后端保证任意时刻最多只有一个最重要任务
- 设置 B 时自动取消 A
- 最重要任务状态通过 iTerm2 session 变量跨重启恢复
- 卡片与顶部区域增加视觉提醒

**Out of Scope:**
- 自动抢焦点或自动切换窗口
- 新的声音提醒系统
- 多级优先级或多个最重要任务

## Context for Development

### Codebase Patterns

- `server.py` 负责 Pydantic payload 和 HTTP 映射，不放业务规则。
- `DashboardService` 维护 `records`，并统一广播 `snapshot` / `terminal-updated`。
- 前端右键菜单动作定义在 `static/app.js` 的 context menu action map 中。
- 已有隐藏、静默、标签状态通过 iTerm2 自定义变量持久化，最重要任务应复用同类模式。

### Files to Reference

| File | Purpose |
| ---- | ------- |
| `src/multi_iterm2_manager/models.py` | 终端运行时字段和序列化输出 |
| `src/multi_iterm2_manager/service.py` | 唯一主任务约束与广播 |
| `src/multi_iterm2_manager/server.py` | 新增切换最重要任务的 API |
| `src/multi_iterm2_manager/backend/iterm2_backend.py` | iTerm2 session 变量持久化与接管恢复 |
| `src/multi_iterm2_manager/static/app.js` | 右键菜单动作、顶部入口与卡片状态渲染 |
| `src/multi_iterm2_manager/static/styles.css` | 最重要任务卡片和顶部入口样式 |

### Technical Decisions

- 独立字段命名为 `is_primary`，不复用 `tags`。
- 唯一性在后端服务层实现，前端只做交互和渲染。
- 若一次操作会修改多个终端的最重要状态，统一广播 `snapshot`，避免前端出现双高亮。
- 第一版视觉提示采用“顶部固定入口 + 卡片边框高亮 + 低频脉冲”，不引入侵入式动画。

## Implementation Plan

### Tasks

- [x] Task 1: 扩展终端模型与后端持久化字段
  - File: `src/multi_iterm2_manager/models.py`
  - File: `src/multi_iterm2_manager/backend/base.py`
  - File: `src/multi_iterm2_manager/backend/iterm2_backend.py`
  - File: `src/multi_iterm2_manager/backend/mock.py`
  - Action: 新增最重要任务状态字段、接管恢复字段与 iTerm2 session 变量读写。

- [x] Task 2: 在服务层实现唯一主任务约束和 API
  - File: `src/multi_iterm2_manager/service.py`
  - File: `src/multi_iterm2_manager/server.py`
  - Action: 提供设置/取消最重要任务的服务方法与 HTTP 接口，保证设置 B 时自动取消 A。

- [x] Task 3: 在前端增加右键菜单动作和视觉提醒
  - File: `src/multi_iterm2_manager/static/index.html`
  - File: `src/multi_iterm2_manager/static/app.js`
  - File: `src/multi_iterm2_manager/static/styles.css`
  - Action: 新增右键菜单入口、顶部最重要任务固定入口、卡片徽标与高亮样式。

- [x] Task 4: 补充核心状态流转验证
  - File: `tests/test_summary_flow.py`
  - Action: 增加 service 层“唯一主任务”和“取消主任务”断言。

### Acceptance Criteria

- [x] AC 1: Given 当前没有最重要任务，when 用户在右键菜单中对任务 A 点击“标记为最重要任务”，then A 被标记为最重要任务。
- [x] AC 2: Given A 已经是最重要任务，when 用户在右键菜单中对任务 B 点击“标记为最重要任务”，then A 自动取消且 B 成为唯一最重要任务。
- [x] AC 3: Given A 已经是最重要任务，when 用户在 A 的右键菜单中点击“取消最重要任务”，then 系统中不再存在最重要任务。
- [x] AC 4: Given 某任务已是最重要任务，when 用户查看监控墙，then 顶部存在固定入口且对应卡片有稳定视觉高亮。
- [x] AC 5: Given 服务重启后重新接管已托管终端，when 该终端之前被标记为最重要任务，then 最重要任务状态可以恢复。

## Additional Context

### Dependencies

- 复用现有 FastAPI / Vanilla JS / iTerm2 Python API，无新增第三方依赖。

### Testing Strategy

- Python 侧执行 `py_compile` 检查新增后端代码语法。
- 前端执行 `node --check src/multi_iterm2_manager/static/app.js` 检查脚本语法。
- 使用 `.venv/bin/python` 运行一次性断言脚本验证 `DashboardService.set_primary()` 的唯一性和取消逻辑。
- 已补 `tests/test_summary_flow.py`，但当前环境未安装 `pytest`，未能直接运行 pytest 命令。

### Notes

- 当前视觉方案偏“沉稳聚焦型”，没有加入强制抢焦点和持续响铃。
- 如果后续需要更强提醒，可在最重要任务进入 `waiting` / `error` 时再增加升级态，而不影响当前基础结构。
