# muti-iterm2-manager - 项目概览

**日期：** 2026-03-09  
**类型：** 单体本地后端服务（附带静态 Web 监控墙）  
**架构：** FastAPI + WebSocket + iTerm2 自动化 + 原生静态前端

## 执行摘要

`muti-iterm2-manager` 是一个运行在 macOS 本机上的多 iTerm2 窗口管理器。它通过 Python 调用 iTerm2 官方 API 创建和控制真实终端窗口，同时通过 FastAPI 暴露 HTTP 接口与 WebSocket 事件流，再配合内置静态页面提供“监控墙”式的任务总览、状态判断和快速接管能力。

项目当前实现聚焦于“监控墙模式”：后端维护受管终端的生命周期与状态快照，前端以卡片与网格布局展示多个终端的实时文本镜像，并允许用户创建任务、刷新快照、发送命令、切换焦点、关闭窗口、进入监控模式与调整布局。

## 项目分类

- **仓库类型：** 单体仓库
- **项目类型：** `backend`
- **主要语言：** Python、JavaScript、HTML、CSS
- **架构模式：** 单进程服务编排 + 适配器模式 + 事件推送型仪表盘

## 技术栈概览

| 类别 | 技术 | 说明 |
| --- | --- | --- |
| 后端框架 | FastAPI | 提供 HTTP API 与 WebSocket 入口 |
| 应用运行 | Uvicorn | 通过 `python3 -m multi_iterm2_manager` 启动 |
| 数据模型 | Dataclass + Pydantic | 内部记录用 dataclass，请求校验用 Pydantic |
| 终端控制 | iTerm2 Python API | 真实创建、聚焦、关闭、读取屏幕、发送文本 |
| macOS 交互 | PyObjC / AppKit | 获取屏幕尺寸、辅助启动 iTerm2 |
| 前端 | 原生 HTML/CSS/JS + xterm.js | 内置静态监控墙页面 |
| 通信 | HTTP + WebSocket | HTTP 操作，WebSocket 实时同步状态 |
| 启停脚本 | `start.sh` / `stop.sh` | 管理本地服务与受控 iTerm 会话 |

## 核心能力

- 创建新的 iTerm2 窗口并纳入监控
- 批量生成示例终端任务
- 读取终端当前屏幕文本与带样式的 HTML 镜像
- 基于关键词判断任务状态：运行中、完成、等待、异常、关闭
- 将真实 iTerm2 应用收起到后台监控模式
- 支持刷新、发送文本、改名、关闭、聚焦、调整窗口位置
- 提供 WebSocket 实时推送终端与布局变化
- 提供监控墙前端：筛选、分页、拖拽布局、下一异常任务接管等交互

## 架构亮点

- **后端适配器抽象清晰**：`TerminalBackend` 协议定义统一能力，真实 `ITerm2Backend` 与 `MockTerminalBackend` 可切换。
- **状态模型集中管理**：`DashboardService` 统一维护终端记录、监控任务、订阅者和广播事件。
- **实时刷新链路完整**：终端流式输出 → 分析器打标签 → 广播给前端 → 前端重绘监控墙。
- **兼顾真实环境与演示模式**：支持 `MITERM_BACKEND=mock` 在未配置 iTerm2 时演示页面与流程。
- **本地化运维友好**：配套健康检查、PID 文件、日志文件与启停脚本。

## 开发概览

### 运行前提

- macOS 环境
- 已安装 iTerm2
- 在 iTerm2 中开启 Python API Server
- Python 3.9+

### 快速开始

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
python3 -m multi_iterm2_manager
```

### 常用命令

- **安装：** `pip install -e .`
- **启动：** `python3 -m multi_iterm2_manager`
- **脚本启动：** `./start.sh`
- **脚本停止：** `./stop.sh`
- **模拟模式：** `MITERM_BACKEND=mock python3 -m multi_iterm2_manager`

## 仓库结构摘要

- `src/multi_iterm2_manager/server.py`：FastAPI 入口与全部 API/WS 路由
- `src/multi_iterm2_manager/service.py`：终端编排、状态维护与事件广播中心
- `src/multi_iterm2_manager/backend/`：真实 iTerm2 后端与 Mock 后端
- `src/multi_iterm2_manager/analyzer.py`：终端文本状态分析器
- `src/multi_iterm2_manager/display.py`：显示器尺寸与网格布局计算
- `src/multi_iterm2_manager/static/`：监控墙前端资源
- `docs/`：项目说明、开发流程与本次生成的文档输出

## 文档地图

- [index.md](./index.md) - 文档总索引
- [architecture.md](./architecture.md) - 系统架构详解
- [source-tree-analysis.md](./source-tree-analysis.md) - 目录结构说明
- [component-inventory.md](./component-inventory.md) - 前端与后端核心组件清单
- [development-guide.md](./development-guide.md) - 开发、启动与调试指南
- [api-contracts.md](./api-contracts.md) - HTTP / WebSocket 接口说明
- [data-models.md](./data-models.md) - 运行时数据模型说明

---

_Generated using BMAD Method `document-project` workflow_
