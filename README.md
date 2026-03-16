# Multi iTerm2 Manager

macOS 本地多 iTerm2 终端监控墙 —— 在一个 Web 面板中实时监控和操作多个 iTerm2 终端窗口。

## 环境要求

- **macOS**（依赖 iTerm2 和 pyobjc）
- **iTerm2** 已安装并运行
- **Python 3.9+**

## 快速开始

### 1. 开启 iTerm2 Python API

iTerm2 → Settings → General → Magic → 勾选 **Enable Python API**

### 2. 安装依赖

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
```

### 3. 启动

```bash
./start.sh
```

服务就绪后会打印地址，默认 `http://127.0.0.1:8765`，浏览器打开即可。

### 4. 停止

```bash
./stop.sh
```

`stop.sh` 会关闭所有受管终端窗口并退出 iTerm2（如果没有其他窗口）。

## 启停脚本行为

| 脚本 | 行为 |
|------|------|
| `./start.sh` | 安全重启模式：停旧进程 → 启新进程 → 自动接管之前的终端窗口（窗口不关闭、布局不丢失） |
| `./stop.sh` | 完整清理：关闭所有受管终端 → 停止服务 |

重启后端不需要重新接管终端，终端 ID 和布局跨重启持久化。

日志路径：`.run/multi-iterm2-manager.log`

## 手动启动（不用脚本）

```bash
source .venv/bin/activate

# 真实 iTerm2 后端
MITERM_BACKEND=iterm2 python -m multi_iterm2_manager

# 模拟后端（无需 iTerm2，仅看 UI）
MITERM_BACKEND=mock python -m multi_iterm2_manager
```

## 功能概览

- 创建 / 接管 / 关闭 iTerm2 终端窗口
- 实时屏幕镜像（带 ANSI 颜色）
- 自动状态检测（运行中 / 已完成 / 异常 / 等待中）
- 拖拽排序、分割布局、网格列宽调整
- 标签分组筛选、按标签独立保存布局
- 终端静默（不进入通知队列）
- 隐藏终端（从默认视图移除但不关闭）
- 待处理队列（异常/等待中的终端排队提醒）
- 点击卡片跳转到原生 iTerm2 窗口
- 向终端发送命令
- 界面调优（边距、间距、边框等实时调整）

## 界面调优

项目根目录 `ui-settings.yaml` 为默认界面配置，也可在页面菜单中直接修改并保存。

## 目录结构

```
src/multi_iterm2_manager/
├── server.py          # FastAPI 入口 + 路由
├── service.py         # 终端编排与监控服务
├── models.py          # 数据模型
├── config.py          # 配置加载
├── analyzer.py        # 终端状态规则引擎
├── display.py         # 屏幕/窗口坐标工具
├── backend/
│   ├── iterm2_backend.py  # 真实 iTerm2 后端
│   └── mock.py            # 模拟后端
└── static/
    ├── index.html     # 前端入口
    ├── app.js         # 前端逻辑
    └── styles.css     # 前端样式
```

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/terminals` | 列出所有终端 |
| GET | `/api/health` | 健康检查 |
| POST | `/api/terminals` | 创建终端 |
| POST | `/api/terminals/{id}/focus` | 聚焦终端（跳转到 iTerm2） |
| POST | `/api/terminals/{id}/send-text` | 发送命令 |
| POST | `/api/terminals/{id}/hidden` | 设置隐藏 |
| POST | `/api/terminals/{id}/muted` | 设置静默 |
| POST | `/api/terminals/{id}/tags` | 设置标签 |
| POST | `/api/terminals/{id}/close` | 关闭终端 |
| POST | `/api/terminals/{id}/detach` | 解绑终端（不关闭窗口） |
| POST | `/api/terminals/close-all` | 关闭全部 |
| POST | `/api/sessions/adopt` | 接管已有终端 |
| POST | `/api/workspace/monitor-mode` | 收起所有窗口 |
| WS | `/ws` | 实时状态推送 |
