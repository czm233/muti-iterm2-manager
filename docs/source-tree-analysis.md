# muti-iterm2-manager - 源码目录分析

**日期：** 2026-03-09

## 概览

这是一个结构相对紧凑的单体项目：核心 Python 包位于 `src/multi_iterm2_manager/`，前端静态资源与后端服务共仓管理，`docs/` 中既包含已有流程文档，也承载本次生成的 AI 上下文文档。

## 完整目录结构

```text
muti-iterm2-manager/
├── README.md
├── pyproject.toml
├── start.sh
├── stop.sh
├── docs/
│   ├── development-workflow.md
│   ├── implementation-plan.md
│   ├── architecture.md
│   ├── api-contracts.md
│   ├── component-inventory.md
│   ├── data-models.md
│   ├── development-guide.md
│   ├── index.md
│   ├── project-overview.md
│   ├── project-scan-report.json
│   └── source-tree-analysis.md
├── src/
│   └── multi_iterm2_manager/
│       ├── __init__.py
│       ├── __main__.py
│       ├── analyzer.py
│       ├── config.py
│       ├── display.py
│       ├── models.py
│       ├── server.py
│       ├── service.py
│       ├── backend/
│       │   ├── base.py
│       │   ├── iterm2_backend.py
│       │   └── mock.py
│       └── static/
│           ├── app.js
│           ├── index.html
│           └── styles.css
└── _bmad/
```

## 关键目录

### `src/multi_iterm2_manager/`

**用途：** 主应用包  
**包含：** 启动入口、API、服务编排、模型、显示逻辑、状态分析器与静态资源定位  
**入口点：** `__main__.py`、`server.py`

### `src/multi_iterm2_manager/backend/`

**用途：** 终端控制后端适配层  
**包含：** 抽象协议、真实 iTerm2 实现、模拟实现  
**集成说明：** `service.py` 通过 `_build_backend()` 动态选择真实或 mock 后端

### `src/multi_iterm2_manager/static/`

**用途：** 内置 Web 监控墙前端  
**包含：** 页面骨架、交互逻辑、样式表  
**集成说明：** 通过 `FastAPI StaticFiles` 挂载到 `/assets`

### `docs/`

**用途：** 项目说明与 AI 上下文文档输出目录  
**包含：** 既有开发流程文档、实现计划文档，以及本次扫描生成的所有说明文件

## 入口点

- **Python 启动入口：** `src/multi_iterm2_manager/__main__.py`
- **FastAPI 应用入口：** `src/multi_iterm2_manager/server.py`
- **前端页面入口：** `src/multi_iterm2_manager/static/index.html`
- **脚本入口：** `start.sh`、`stop.sh`

## 文件组织模式

- **后端逻辑集中式组织**：所有核心业务逻辑集中在单一 Python 包中。
- **协议 + 实现分离**：`backend/base.py` 只描述协议，具体实现放在独立文件。
- **静态资源内嵌部署**：前端未单独使用构建系统，而是以纯静态资源直接被后端托管。
- **文档与实现同仓**：`docs/` 保留用户流程文档，同时也存放面向 AI 的结构化项目文档。

## 关键文件类型

### Python 源码

- **模式：** `src/multi_iterm2_manager/**/*.py`
- **用途：** 业务服务、终端控制、状态分析、启动入口
- **示例：** `server.py`、`service.py`、`backend/iterm2_backend.py`

### 静态前端资源

- **模式：** `src/multi_iterm2_manager/static/*`
- **用途：** 监控墙界面与浏览器端交互
- **示例：** `app.js`、`index.html`、`styles.css`

### 项目配置

- **模式：** `pyproject.toml`、脚本文件、README
- **用途：** 依赖声明、运行说明、脚本化运维
- **示例：** `pyproject.toml`、`start.sh`、`stop.sh`

## 配置文件

- `pyproject.toml`：Python 包、依赖与可选测试依赖声明
- `README.md`：项目目标、运行方式、接口与目录说明
- `start.sh`：正式启动流程、健康检查与日志/PID 管理
- `stop.sh`：停止服务与清理受控 iTerm 会话

## 开发备注

- 项目没有独立测试目录，当前更偏向可运行原型/本地工具形态。
- `static/` 前端与 `service.py` 高度耦合，很多交互都直接依赖服务端当前响应结构。
- `backend/iterm2_backend.py` 是系统复杂度最高的目录，应优先阅读。

---

_Generated using BMAD Method `document-project` workflow_
