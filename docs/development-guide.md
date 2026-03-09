# muti-iterm2-manager - 开发指南

**日期：** 2026-03-09

## 1. 前置条件

- macOS
- 已安装 iTerm2
- Python 3.9+
- 已在 iTerm2 中启用 Python API Server

启用路径：

`Prefs > General > Magic > Enable Python API server`

## 2. 安装依赖

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
```

开发测试依赖：

```bash
pip install -e .[dev]
```

## 3. 启动方式

### 直接启动

```bash
python3 -m multi_iterm2_manager
```

默认地址：

- Web 面板：`http://127.0.0.1:8765`
- WebSocket：`ws://127.0.0.1:8765/ws`

### 使用脚本启动

```bash
./start.sh
```

`start.sh` 的职责：

- 停掉旧服务
- 启动新服务
- 写入 `.run/multi-iterm2-manager.pid`
- 输出日志到 `.run/multi-iterm2-manager.log`
- 等待健康检查成功

### 停止服务

```bash
./stop.sh
```

`stop.sh` 的职责：

- 停止正在运行的服务进程
- 清理本项目托管的 iTerm 会话
- 尝试关闭空闲 iTerm

## 4. 环境变量

| 变量名 | 默认值 | 作用 |
| --- | --- | --- |
| `MITERM_HOST` | `127.0.0.1` | 监听地址 |
| `MITERM_PORT` | `8765` | 监听端口 |
| `MITERM_BACKEND` | `auto` | 后端模式：`auto` / `iterm2` / `mock` |
| `MITERM_DEMO_COLUMNS` | `2` | 示例布局列数 |
| `MITERM_DEMO_ROWS` | `2` | 示例布局行数 |

### 常见模式

#### 强制真实后端

```bash
MITERM_BACKEND=iterm2 python3 -m multi_iterm2_manager
```

#### 使用模拟后端

```bash
MITERM_BACKEND=mock python3 -m multi_iterm2_manager
```

## 5. 典型开发流程

推荐使用项目现有工作流：

1. 修改代码
2. `./stop.sh`
3. 自测
4. `./stop.sh`
5. `./start.sh`
6. 通知用户验收

详情见：`docs/development-workflow.md`

## 6. 调试建议

### 后端调试

- 先访问 `GET /api/health` 确认服务已启动
- 查看 `.run/multi-iterm2-manager.log`
- 若真实后端失败，优先检查 iTerm2 授权弹窗是否已允许

### 前端调试

- 打开浏览器开发者工具查看 WebSocket 与接口请求
- 先使用 `MITERM_BACKEND=mock` 验证页面交互是否正常

### iTerm2 相关调试

- 检查 iTerm2 是否开启 API Server
- 若连接失败，关注 AppleScript 授权与环境变量 `ITERM2_COOKIE` / `ITERM2_KEY` 获取流程

## 7. 测试情况

- 项目声明了 `pytest` 开发依赖
- 当前仓库未发现现成测试目录或测试文件
- 建议后续补充：
  - `analyzer.py` 单元测试
  - `display.py` 布局计算测试
  - `service.py` + `MockTerminalBackend` 集成测试

## 8. 常见开发任务

### 新增终端操作接口

1. 在 `server.py` 新增路由
2. 在 `service.py` 增加服务方法
3. 必要时扩展 `TerminalBackend` 协议与具体实现
4. 在 `static/app.js` 增加调用与 UI 绑定

### 调整布局算法

1. 优先修改 `display.py`
2. 检查服务端 `monitor_layout()` 输出
3. 校验前端 `applyLayout()` 与拖拽逻辑是否兼容

### 扩展状态识别

1. 修改 `analyzer.py` 的正则规则
2. 校验前端状态文案与颜色映射

---

_Generated using BMAD Method `document-project` workflow_
