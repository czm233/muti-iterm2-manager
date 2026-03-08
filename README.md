# muti-iterm2-manager

一个面向 macOS 的本地多 iTerm2 管理器与监控墙。

当前实现聚焦在 **监控墙模式**：

- 创建 iTerm2 窗口
- 创建全尺寸运行的 iTerm2 窗口
- 将真实 iTerm 窗口退到后台工作层
- 实时抓取每个窗口当前屏幕文本
- 在 Web 监控墙中同时查看多个窗口镜像
- 2 个任务自动左右布局，3-4 个自动四宫格，5-6 个自动 2×3
- 根据关键词把窗口标记为运行中、已完成、等待中、异常
- 点击卡片后切回对应原生 iTerm2 窗口接管
- 在监控墙里向指定会话发送命令
- 一键回到监控模式 / 一键关闭全部窗口
- 监控墙支持活跃 / 待处理 / 已完成筛选与分页
- 支持一键接管下一个异常或等待中的任务

## 技术方案

- 后端：Python + FastAPI + WebSocket
- iTerm2 控制：官方 Python API
- 前端：原生 HTML/JS + xterm.js
- 布局：前端监控墙自动自适应
- 监控：优先使用 iTerm2 `ScreenStreamer`

## 运行前准备

### 1. 开启 iTerm2 Python API

在 iTerm2 中打开：

`Prefs > General > Magic > Enable Python API server`

### 2. 安装依赖

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
```

### 3. 启动服务

```bash
python3 -m multi_iterm2_manager
```

默认地址：

- Web 面板：`http://127.0.0.1:8765`
- WebSocket：`ws://127.0.0.1:8765/ws`

## 可选模式

### 强制使用真实 iTerm2 后端

```bash
MITERM_BACKEND=iterm2 python3 -m multi_iterm2_manager
```

### 强制使用模拟后端

如果你只是想先看 UI 或没有配置好 iTerm2，可以先跑模拟模式：

```bash
MITERM_BACKEND=mock python3 -m multi_iterm2_manager
```

## 启停脚本

推荐直接用项目根目录脚本：

```bash
./start.sh
./stop.sh
```

脚本行为：

- `./start.sh`：停止旧服务、启动新服务、写入 pid 文件、等待健康检查成功
- `./stop.sh`：停止服务、清理本项目托管的 iTerm 会话、尝试退出空闲 iTerm

脚本运行日志默认放在：

- `.run/multi-iterm2-manager.log`

## 开发 / 验收工作流

本项目默认采用统一的需求 / Bug 处理流程，详见：

- `docs/development-workflow.md`

推荐顺序：

1. 用户提出需求或 bug
2. 修改代码
3. `./stop.sh`
4. 自测并关闭测试环境
5. `./stop.sh`
6. `./start.sh`
7. 通知用户验收

## 当前接口

- `GET /api/terminals`：列出所有终端
- `POST /api/terminals`：创建新终端
- `POST /api/terminals/demo`：创建 4 个四宫格示例窗口
- `POST /api/terminals/{id}/focus`：聚焦某个终端
- `POST /api/terminals/{id}/refresh`：刷新文本快照
- `POST /api/terminals/{id}/send-text`：发送命令
- `POST /api/terminals/{id}/frame`：设置窗口位置和大小
- `POST /api/workspace/monitor-mode`：让真实 iTerm 退回后台监控模式
- `POST /api/layouts/grid`：手动覆盖监控墙网格布局
- `POST /api/terminals/close-all`：关闭全部未关闭窗口
- `WS /ws`：接收终端状态与监控布局实时更新

## 目录说明

- `src/multi_iterm2_manager/server.py`：FastAPI 入口
- `src/multi_iterm2_manager/service.py`：终端编排与监控服务
- `src/multi_iterm2_manager/backend/iterm2_backend.py`：真实 iTerm2 后端
- `src/multi_iterm2_manager/backend/mock.py`：模拟后端
- `src/multi_iterm2_manager/static/index.html`：看板入口页面
- `src/multi_iterm2_manager/static/app.js`：前端逻辑
- `src/multi_iterm2_manager/static/styles.css`：前端样式

## 当前限制

- 当前监控墙展示的是 **终端文本镜像**，不是窗口视频流。
- 关键词分析是规则式实现，后续可以扩展成更强的状态机。
- 真实窗口当前通过“最大化 + 隐藏 iTerm app”实现后台工作层；如果后续要更强的置底能力，再补 Hammerspoon 桥接层。
