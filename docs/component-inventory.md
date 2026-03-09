# muti-iterm2-manager - 组件清单

**日期：** 2026-03-09

## 概览

虽然项目没有使用 React/Vue 之类的组件框架，但它仍然具备清晰的“后端组件 + 前端页面组件”结构。后端组件负责终端管理与事件广播，前端组件负责监控墙渲染、操作与交互状态维护。

## 后端核心组件

### `DashboardService`

- **类型：** 应用服务
- **职责：** 终端创建、刷新、聚焦、关闭、广播、布局与监控任务管理
- **关键方法：** `create_terminal`、`refresh_terminal`、`send_text`、`close_all_terminals`、`_monitor_terminal`

### `ITerm2Backend`

- **类型：** 基础设施适配器
- **职责：** 连接 iTerm2、创建真实终端窗口、读取屏幕内容、聚焦与关闭窗口
- **特点：** 包含重连、授权环境变量预热、锚点终端、HTML 屏幕渲染

### `MockTerminalBackend`

- **类型：** 模拟适配器
- **职责：** 在无真实 iTerm2 环境下模拟终端生命周期和输出流
- **适用场景：** UI 开发、演示、联调

### `analyze_screen_text`

- **类型：** 状态分析器
- **职责：** 根据终端文本命中规则，判断 `done/error/waiting/running`
- **局限：** 当前为规则式分析，不含上下文状态机

### `display.py` 布局工具

- **类型：** 辅助组件
- **职责：** 获取显示器边界、计算最大化窗口、根据任务数推导网格布局

## 运行时数据组件

### `TerminalRecord`

- **角色：** 终端运行记录聚合对象
- **包含：** 标识、句柄、状态、摘要、屏幕文本、HTML 镜像、窗口位置、错误信息

### `TerminalHandle`

- **角色：** 与真实/模拟终端绑定的底层句柄
- **包含：** `window_id`、`session_id`、`tab_id`

### `TerminalFrame`

- **角色：** 窗口几何信息
- **包含：** `x/y/width/height`

## 前端页面组件

### Hero 区块

- 展示项目标题、WebSocket 状态、版本号、主操作按钮
- 主要操作：创建示例任务、收起所有、刷新全部、关闭全部

### 创建任务表单

- 输入任务名
- 提交后调用 `POST /api/terminals`

### 监控墙网格

- 承载全部终端卡片
- 基于服务端返回的 `columns/rows` 或前端布局状态渲染

### 终端卡片

- 显示终端名、状态、摘要、标记、屏幕镜像
- 支持动作：聚焦、改名、发送文本、刷新、关闭
- 支持拖拽重排/拆分布局

### 统计栏与过滤器

- 提供状态汇总、当前筛选视图、分页与异常任务快速接管能力

## 前端逻辑模块（按函数职责分组）

### 状态持久化

- `saveViewState`
- `loadViewState`
- `applySidebarState`

### 网络通信

- `request`
- `connectWebSocket`
- `loadInitialState`

### 渲染与布局

- `applyLayout`
- `renderTerminalCard`
- `renderLayoutNode`
- `refreshWall`
- `applySnapshot`

### 交互行为

- `focusTerminal`
- `renameTerminal`
- `bindCardActions`
- `commitSplitDrop`
- `reorderTerminals`

### 统计与筛选

- `renderStats`
- `getFilteredTerminals`
- `getPagedTerminals`
- `getNextAttentionTerminal`

## 设计系统元素

- **状态色：** `done`、`warn`、`error` 等语义色变量定义在 `:root`
- **统一卡片基底：** `hero`、`panel`、`wall-card` 使用相同玻璃态面板风格
- **状态徽标：** `status-pill`、`marker`、`badge` 统一使用圆角胶囊设计

## 复用性观察

- 当前后端复用性较高，尤其是 `DashboardService` 与后端协议层。
- 当前前端更多是页面级脚本式组织，可进一步拆出独立模块或组件文件。

---

_Generated using BMAD Method `document-project` workflow_
