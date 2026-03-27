# Multi iTerm2 Manager

[![macOS](https://img.shields.io/badge/platform-macOS-lightgrey)](https://www.apple.com/macos)
[![Python 3.9+](https://img.shields.io/badge/python-3.9+-blue)](https://www.python.org)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**Web-based terminal dashboard for managing multiple iTerm2 windows on macOS.**

**Keywords:** `iTerm2 manager` `terminal dashboard` `terminal monitor` `SSH session manager` `macOS terminal tool` `multiple terminals`

---

## 功能

- 📊 **实时屏幕镜像** — 在 Web 面板中查看所有终端内容，支持 ANSI 彩色
- 🚦 **自动状态检测** — 智能识别 运行中 / 已完成 / 异常 / 等待中
- 📋 **待处理队列** — 异常/等待中的终端自动排队提醒，一键跳转处理
- ⚡ **一键聚焦** — 点击卡片直接跳转到原生 iTerm2 窗口
- 🏷️ **标签分组** — 按项目/服务器/工作流分组，独立保存布局
- 🎨 **拖拽布局** — 拖拽排序、网格列宽调整、实时界面调优
- 🔇 **静默模式** — 指定终端不进入通知队列
- 👁️ **隐藏终端** — 从视图移除但不关闭窗口
- ⌨️ **远程发命令** — 向终端发送命令
- ♻️ **跨重启持久化** — 重启后端自动接管之前的终端，ID 和布局不丢失

---

## 快速开始

### 环境要求

- **macOS**（依赖 iTerm2 AppleScript API）
- **iTerm2** 已安装并运行
- **Python 3.9+**

### 安装

```bash
# 1. 开启 iTerm2 Python API
# iTerm2 → Settings → General → Magic → 勾选 Enable Python API

# 2. 克隆并安装
git clone https://github.com/czm233/muti-iterm2-manager.git
cd muti-iterm2-manager
python3 -m venv .venv
source .venv/bin/activate
pip install -e .

# 3. 启动
./start.sh
```

浏览器打开 http://127.0.0.1:8765

### 停止

```bash
./stop.sh
```

---

## 启停脚本说明

| 脚本 | 行为 |
|------|------|
| `./start.sh` | 安全重启：停旧进程 → 启新进程 → 自动接管之前的终端（窗口不关闭、布局不丢失） |
| `./stop.sh` | 完整清理：关闭所有受管终端 → 停止服务 |

日志路径：`.run/multi-iterm2-manager.log`

---

## 手动启动（可选）

```bash
source .venv/bin/activate

# 真实 iTerm2 后端
MITERM_BACKEND=iterm2 python -m multi_iterm2_manager

# 模拟后端（无需 iTerm2，仅看 UI）
MITERM_BACKEND=mock python -m multi_iterm2_manager
```

---

## 界面配置

项目根目录 `ui-settings.yaml` 为默认配置，也可在页面菜单中直接修改并保存。

```yaml
card_gap: 12
card_padding: 8
border_radius: 8
# ... 更多选项
```

---

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

---

## 目录结构

```
src/multi_iterm2_manager/
├── server.py              # FastAPI 路由
├── service.py             # 终端编排与监控
├── models.py              # 数据模型
├── config.py              # 配置加载
├── analyzer.py            # 状态检测规则引擎
├── display.py             # 屏幕/窗口坐标工具
├── backend/
│   ├── iterm2_backend.py  # 真实 iTerm2 后端
│   └── mock.py            # 模拟后端
└── static/
    ├── index.html         # 前端入口
    ├── app.js             # 前端逻辑
    └── styles.css         # 前端样式
```

---

## 适用场景

- **DevOps / SRE** — 监控多个 SSH 会话，查看命令执行状态
- **全栈开发** — 前端/后端/数据库/后台任务分终端运行，一目了然
- **构建部署** — 观察长时间构建和部署，完成或失败时通知
- **分布式系统** — 同时监控多个服务、日志和进程

---

## License

[MIT](LICENSE)
