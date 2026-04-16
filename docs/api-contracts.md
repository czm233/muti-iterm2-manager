# muti-iterm2-manager - API 契约

**日期：** 2026-03-09

## 概览

- **协议：** HTTP + JSON、WebSocket
- **认证：** 当前未实现身份认证
- **错误风格：** FastAPI 默认错误响应，常见为 `{"detail": "..."}`

## HTTP 接口

### `GET /`

- **用途：** 返回监控墙主页 HTML
- **响应：** `text/html`
- **备注：** 会注入前端静态资源版本号，响应头含 `Cache-Control: no-store`

### `GET /api/health`

- **用途：** 健康检查
- **响应示例：**

```json
{
  "ok": true,
  "backend": "auto",
  "terminals": 0,
  "itermReady": true,
  "version": "0.1.0"
}
```

### `GET /api/terminals`

- **用途：** 获取全部终端与当前布局信息
- **响应示例：**

```json
{
  "items": [
    {
      "id": "task-ab12cd34",
      "name": "终端 1",
      "windowId": "...",
      "sessionId": "...",
      "tabId": "...",
      "command": "/bin/zsh -l",
      "profile": null,
      "status": "running",
      "summary": "最近几行输出摘要",
      "screenText": "完整文本快照",
      "screenHtml": "<pre>...</pre>",
      "frame": {"x": 10, "y": 10, "width": 1200, "height": 700},
      "markers": [],
      "program": {
        "key": "claude-code",
        "label": "Claude Code",
        "source": "direct",
        "pid": 12345,
        "commandLine": "claude"
      },
      "updatedAt": "2026-03-09T16:00:00",
      "isLive": true,
      "lastError": null
    }
  ],
  "layout": {
    "count": 1,
    "columns": 1,
    "rows": 1
  }
}
```

### `POST /api/terminals`

- **用途：** 创建新终端
- **请求体：**

```json
{
  "name": "任务 A",
  "command": "/bin/zsh -l",
  "profile": null,
  "frame": {
    "x": 0,
    "y": 0,
    "width": 1200,
    "height": 800
  }
}
```

- **字段约束：**
  - `name`：可空，最大 60 字符
  - `frame.width` / `frame.height`：大于 100

### `POST /api/terminals/demo`

- **用途：** 批量创建示例终端
- **请求体：**

```json
{
  "count": 4
}
```

- **约束：** `1 <= count <= 12`

### `POST /api/terminals/close-all`

- **用途：** 关闭所有未关闭终端

### `POST /api/workspace/monitor-mode`

- **用途：** 让真实 iTerm 应用切回后台监控模式
- **响应示例：**

```json
{
  "type": "workspace-mode",
  "mode": "monitor",
  "layout": {
    "count": 4,
    "columns": 2,
    "rows": 2
  }
}
```

### `POST /api/terminals/{terminal_id}/rename`

- **用途：** 修改终端名称
- **请求体：**

```json
{
  "name": "新的终端名称"
}
```

- **错误：**
  - 404：终端不存在
  - 400：名称为空、过长或重复

### `POST /api/terminals/{terminal_id}/focus`

- **用途：** 聚焦真实终端窗口

### `POST /api/terminals/{terminal_id}/close`

- **用途：** 关闭指定终端

### `POST /api/terminals/{terminal_id}/refresh`

- **用途：** 立即刷新指定终端快照

### `POST /api/terminals/{terminal_id}/send-text`

- **用途：** 向指定终端发送文本
- **请求体：**

```json
{
  "text": "ls -la"
}
```

- **约束：** 最少 1 个字符；服务端会自动补换行

### `POST /api/terminals/{terminal_id}/frame`

- **用途：** 设置终端窗口位置和大小
- **请求体：**

```json
{
  "x": 10,
  "y": 20,
  "width": 1000,
  "height": 700
}
```

### `POST /api/layouts/grid`

- **用途：** 广播监控墙布局信息
- **请求体：**

```json
{
  "columns": 2,
  "rows": 2,
  "task_ids": ["task-a", "task-b"],
  "gap": 12,
  "padding": 36
}
```

- **备注：** 当前后端主要广播布局，不直接重排真实窗口。

## WebSocket 契约

### 连接地址

`WS /ws`

### 服务端推送事件

#### `snapshot`

首次订阅后立即发送的全量快照：

```json
{
  "type": "snapshot",
  "terminals": [],
  "layout": {"count": 0, "columns": 1, "rows": 1}
}
```

#### `terminal-updated`

单个终端发生变化时发送：

```json
{
  "type": "terminal-updated",
  "terminal": {"id": "task-ab12cd34", "status": "running"},
  "layout": {"count": 1, "columns": 1, "rows": 1}
}
```

#### `workspace-mode`

切换到监控模式时发送：

```json
{
  "type": "workspace-mode",
  "mode": "monitor",
  "layout": {"count": 4, "columns": 2, "rows": 2}
}
```

#### `monitor-layout`

网格布局更新时发送：

```json
{
  "type": "monitor-layout",
  "layout": {"count": 4, "columns": 2, "rows": 2}
}
```

## 领域对象

### Terminal Record

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 内部任务 ID |
| `name` | string | 终端显示名称 |
| `windowId` | string | 真实/模拟窗口 ID |
| `sessionId` | string | 会话 ID |
| `tabId` | string \/ null | 标签页 ID |
| `command` | string \/ null | 创建时命令 |
| `profile` | string \/ null | iTerm 配置 |
| `status` | string | `idle/running/done/error/waiting/closed` |
| `summary` | string | 输出摘要 |
| `screenText` | string | 纯文本屏幕内容 |
| `screenHtml` | string | HTML 镜像 |
| `frame` | object \/ null | 窗口位置尺寸 |
| `markers` | string[] | 命中的规则标记 |
| `program` | object | 当前识别到的前台程序信息 |
| `updatedAt` | string | 更新时间 |
| `isLive` | boolean | 是否来自流式更新 |
| `lastError` | string \/ null | 最近错误 |

## 认证与安全现状

- 当前无登录、权限或租户隔离。
- 适用于本机单用户场景，不适合直接暴露到公网。

---

_Generated using BMAD Method `document-project` workflow_
