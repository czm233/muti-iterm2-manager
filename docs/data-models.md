# muti-iterm2-manager - 数据模型

**日期：** 2026-03-09

## 总览

项目当前没有数据库、ORM 或迁移系统，数据模型全部是**运行时内存模型**。这意味着“数据模型”更多代表服务内部结构、请求体和事件载荷，而不是持久化表结构。

## 1. 终端领域模型

### `TerminalStatus`

枚举值：

- `idle`
- `running`
- `done`
- `error`
- `waiting`
- `closed`

作用：表示受控终端当前状态。

### `TerminalFrame`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `x` | float | 窗口左上角 X 坐标 |
| `y` | float | 窗口左上角 Y 坐标 |
| `width` | float | 窗口宽度 |
| `height` | float | 窗口高度 |

用途：用于记录或设置真实 iTerm 窗口的几何信息。

### `TerminalHandle`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `window_id` | string | iTerm 窗口 ID |
| `session_id` | string | 会话 ID |
| `tab_id` | string \/ null | 标签页 ID |

用途：把业务记录与底层 iTerm 实体绑定。

### `TerminalRecord`

这是项目最重要的运行时聚合模型。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 本项目内部任务 ID |
| `name` | string | 终端显示名称 |
| `handle` | `TerminalHandle` | 底层句柄 |
| `command` | string \/ null | 启动命令 |
| `profile` | string \/ null | iTerm profile |
| `status` | `TerminalStatus` | 当前状态 |
| `summary` | string | 最近输出摘要 |
| `screen_text` | string | 纯文本快照 |
| `screen_html` | string | 富文本 HTML 快照 |
| `frame` | `TerminalFrame` \/ null | 窗口尺寸 |
| `markers` | list[string] | 命中的分析规则 |
| `updated_at` | string | 最近更新时间 |
| `is_live` | bool | 是否来自流式监控 |
| `last_error` | string \/ null | 最近异常 |

### 关系说明

- 一个 `TerminalRecord` 拥有一个 `TerminalHandle`
- 一个 `TerminalRecord` 可选拥有一个 `TerminalFrame`
- `DashboardService.records` 是 `terminal_id -> TerminalRecord` 的内存索引

## 2. 请求参数模型

### `CreateTerminalParams`

- `name`
- `command`
- `profile`
- `frame`

用于服务层与后端层之间创建终端。

### `GridLayoutParams`

- `columns`
- `rows`
- `task_ids`
- `gap`
- `padding`

用于布局广播与网格计算。

## 3. API 请求体验证模型

这些模型定义在 `server.py` 中，使用 Pydantic 完成校验。

### `FramePayload`

- `x`
- `y`
- `width > 100`
- `height > 100`

### `CreateTerminalPayload`

- `name`：可空，长度不超过 60
- `command`
- `profile`
- `frame`

### `SendTextPayload`

- `text`：最少 1 个字符

### `RenamePayload`

- `name`：1 到 60 字符

### `CreateDemoPayload`

- `count`：1 到 12

### `GridLayoutPayload`

- `columns`：1 到 6
- `rows`：1 到 6
- `task_ids`：可选
- `gap`：0 到 64
- `padding`：0 到 128

## 4. 事件模型

### `snapshot`

- 表示当前全量终端与布局快照

### `terminal-updated`

- 表示某个终端状态、输出或窗口信息已变化

### `workspace-mode`

- 表示工作区模式切换，目前主要是 `monitor`

### `monitor-layout`

- 表示监控墙网格布局变化

## 5. 数据存储策略

- **持久化：** 无
- **存储介质：** Python 进程内内存
- **生命周期：** 随服务进程启动/结束而创建/销毁

## 6. 演进建议

如果项目后续需要更强的可恢复性，可新增：

- 终端会话快照持久化
- 用户自定义布局持久化
- 操作审计日志
- 更细粒度的状态机与任务阶段模型

---

_Generated using BMAD Method `document-project` workflow_
