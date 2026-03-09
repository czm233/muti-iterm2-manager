# muti-iterm2-manager - 架构说明

**日期：** 2026-03-09

## 1. 总体架构

项目是一个单进程、本机部署的异步服务，核心由四层组成：

1. **接入层**：`FastAPI` 暴露 HTTP 接口与 WebSocket。
2. **应用层**：`DashboardService` 负责终端生命周期、状态同步、广播与布局计算。
3. **领域/模型层**：`TerminalRecord`、`TerminalFrame`、`GridLayoutParams` 等结构承载运行态数据。
4. **基础设施层**：真实 iTerm2 后端、Mock 后端、显示器布局工具、静态前端资源。

## 2. 关键模块

### 2.1 API 与页面入口

- `server.py`
  - 提供 `/` 页面入口，动态注入静态资源版本号。
  - 提供 `/api/*` 系列终端控制接口。
  - 提供 `/ws` 实时事件通道。
  - 在应用启动/关闭时分别调用 `service.start()` / `service.stop()`。

### 2.2 服务编排核心

- `service.py`
  - 初始化后端适配器。
  - 持有 `records` 保存所有终端运行记录。
  - 持有 `monitor_tasks` 跟踪每个终端的异步监控任务。
  - 对外提供创建、改名、聚焦、关闭、发送文本、刷新、布局等能力。
  - 负责将终端流式输出转化为前端事件。

### 2.3 后端适配器

- `backend/base.py`
  - 定义 `TerminalBackend` 协议，约束后端能力边界。
- `backend/iterm2_backend.py`
  - 使用 iTerm2 官方 Python API 与 AppleScript 授权机制。
  - 管理连接、重连、锚点终端、受控终端标记、屏幕渲染与窗口控制。
- `backend/mock.py`
  - 用内存数据模拟终端、输出与窗口尺寸，便于演示和前端联调。

### 2.4 运行态分析与显示

- `analyzer.py`
  - 基于关键字/正则把终端输出映射为 `idle/running/done/error/waiting`。
- `display.py`
  - 获取主屏幕可用区域。
  - 计算最大化窗口与监控网格布局。

### 2.5 前端监控墙

- `static/index.html`
  - 定义监控墙整体结构、侧边栏、操作区与主舞台区域。
- `static/app.js`
  - 管理页面状态、HTTP 请求、WebSocket 连接、卡片渲染、拖拽布局、筛选与分页。
- `static/styles.css`
  - 提供深色视觉风格、卡片样式、响应式布局与状态颜色系统。

## 3. 核心运行流程

### 3.1 启动流程

1. `python3 -m multi_iterm2_manager` 进入 `__main__.py`。
2. `load_settings()` 从环境变量读取主机、端口、后端类型等设置。
3. Uvicorn 启动 `server:app`。
4. FastAPI `startup` 事件触发 `DashboardService.start()`。
5. 服务尝试连接 iTerm2、清理残留受管终端、关闭空闲 iTerm。

### 3.2 创建终端流程

1. 前端调用 `POST /api/terminals`。
2. `server.py` 把请求体转为 `CreateTerminalParams`。
3. `DashboardService.create_terminal()`：
   - 确保锚点终端存在；
   - 调后端创建真实或模拟终端；
   - 读取初始屏幕；
   - 创建 `TerminalRecord`；
   - 启动后台监控协程；
   - 切回监控模式并广播更新。

### 3.3 实时监控流程

1. 每个终端对应一个 `_monitor_terminal()` 协程。
2. 协程从后端 `stream_screen()` 持续获取文本与 HTML 渲染。
3. `_apply_screen_text()` 调用 `analyze_screen_text()` 更新状态、摘要和标记。
4. `record_event()` 生成结构化事件。
5. `_broadcast()` 推送给所有 WebSocket 订阅者。
6. 前端收到事件后重绘卡片和统计栏。

### 3.4 终端接管流程

1. 用户在监控墙点击卡片的聚焦/接管动作。
2. 前端调用 `POST /api/terminals/{id}/focus`。
3. 服务调用后端 `focus()` 激活真实 iTerm 窗口。
4. 若窗口已不存在，则记录被标记为 `closed`。

## 4. 数据与状态设计

### 4.1 状态存储

- 所有终端记录都保存在进程内 `records` 字典中。
- 当前没有数据库、文件持久化或跨进程同步机制。
- 服务重启后状态会丢失，但脚本会尽量清理旧会话，避免脏环境残留。

### 4.2 终端状态机

- `idle`：暂无输出
- `running`：有输出但未命中完成/等待/异常规则
- `done`：命中完成关键词
- `waiting`：命中等待输入关键词
- `error`：命中错误关键词或监控异常
- `closed`：真实终端被关闭或主动关闭

## 5. 对外接口形态

### HTTP API

- 页面入口：`GET /`
- 健康检查：`GET /api/health`
- 终端列表：`GET /api/terminals`
- 终端创建/管理：`POST /api/terminals*`
- 布局调整：`POST /api/layouts/grid`

### WebSocket

- 路径：`/ws`
- 事件：`snapshot`、`terminal-updated`、`workspace-mode`、`monitor-layout`

## 6. 架构模式总结

- **适配器模式**：隔离真实 iTerm2 后端与 Mock 后端。
- **服务层模式**：将路由层与业务编排层分离。
- **推送型前端同步**：通过 WebSocket 而不是轮询全量刷新。
- **无持久化轻量架构**：以本机单用户、本次会话管理为优先。

## 7. 已知限制

- 当前仅提供“终端文本镜像”，不是视频级实时缩略图。
- 状态识别依赖关键词规则，复杂任务场景可能误判。
- 没有数据库，重启后不会恢复上次会话状态。
- 真实 iTerm2 后端依赖本地授权、macOS 与 iTerm2 Python API 可用性。

---

_Generated using BMAD Method `document-project` workflow_
