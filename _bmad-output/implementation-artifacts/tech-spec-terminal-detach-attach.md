---
title: '终端热脱钩/热挂载（Detach / Attach）'
slug: 'terminal-detach-attach'
created: '2026-03-10'
status: 'completed'
stepsCompleted: [1, 2, 3, 4]
tech_stack: ['Python >=3.9', 'FastAPI >=0.115', 'iTerm2 Python API', 'vanilla JS', 'Pydantic >=2.8']
files_to_modify: ['backend/iterm2_backend.py', 'service.py', 'server.py', 'static/app.js', 'static/index.html']
code_patterns: ['session variable 标记管理(MANAGED_FLAG_VAR/MANAGED_OWNER_VAR/ANCHOR_ROLE_VAR)', 'DashboardService 单一编排中心', 'server.py Pydantic payload + try/except 路由', 'WebSocket 广播(snapshot/terminal-updated)', '_run_with_reconnect 重连包装', 'monitor_tasks 异步流监控']
test_patterns: ['无现有测试套件', 'MockTerminalBackend 可用于 service 层测试']
---

# Tech-Spec: 终端热脱钩/热挂载（Detach / Attach）

**Created:** 2026-03-10

## Overview

### Problem Statement

用户使用监控墙开启终端进行 Claude Code 编程时，同时需要修改监控墙自身的代码。修改后重启监控墙会关闭所有被管理终端（`mitm_managed=true`），导致正在运行的 Claude Code 会话丢失工作进度。当前没有机制让终端脱离监控墙管理后存活于重启周期之间。

### Solution

新增 Detach（解绑）和 Attach（接管）机制：
- **Detach**：清除终端的管理标记，从监控墙内存中移除，显现 iTerm2 窗口，但不关闭 session。终端在监控墙重启时不受影响。
- **Attach**：扫描 iTerm2 中未被管理的 session，用户选择后纳入监控墙管理。

### Scope

**In Scope:**
- 后端 Detach 接口：清标记、移除记录、显现窗口
- 后端扫描接口：列出可接管的 iTerm2 session
- 后端 Adopt 接口：接管指定 session 纳入管理
- 前端卡片 ⋯ 菜单添加"解绑"按钮
- 前端任务菜单添加"接管已有终端"区域
- 确认 close_all 只关闭有管理标记的终端

**Out of Scope:**
- 自动重连/自动发现
- 终端状态持久化到磁盘
- 终端分组管理
- 解绑状态下的实时输出监控

## Context for Development

### Codebase Patterns

- **Session Variable 标记体系**：`MANAGED_FLAG_VAR="user.mitm_managed"`、`MANAGED_OWNER_VAR="user.mitm_owner"`、`ANCHOR_ROLE_VAR="user.mitm_role"`。创建时设置 `managed=True, owner=MANAGED_OWNER_VALUE, role="managed"`；锚点终端额外设置 `role="anchor"`。
- **DashboardService 编排**：所有终端生命周期操作通过 `service.py` 的 `DashboardService` 类。`self.records: dict[str, TerminalRecord]` 为内存记录，`self.monitor_tasks: dict[str, asyncio.Task]` 为每终端的屏幕流监控任务。
- **关闭流程**：`close_terminal` → `backend.close(handle)`（杀进程+关窗口）→ `_mark_terminal_closed`（状态置 closed、取消 monitor task、广播）。`close_all_terminals` 遍历 `self.records` 中非 closed 的记录逐个关闭。
- **启动清理**：`service.start()` → `backend.cleanup_managed_terminals()`（遍历所有 iTerm2 session，关闭 `mitm_managed=true` 的）→ `maybe_quit_app()`。
- **路由模式**：`server.py` 使用 Pydantic BaseModel 做 payload 校验，try/except 包装，KeyError→404，ValueError→400，其它→500。
- **前端事件**：WebSocket event types 为 `snapshot`（全量）和 `terminal-updated`（单终端增量），前端 `app.js` 中的 `handleWebSocketMessage` 处理。
- **`_run_with_reconnect`**：所有 backend 调用通过此方法包装，首次失败后重建连接再试一次，timeout=8s。
- **`focus` 方法**：`app.async_activate()` + `session.async_activate(select_tab=True, order_window_front=True)` — 可作为"显现窗口"的参考实现。

### Files to Reference

| File | Purpose | 关键锚点 |
| ---- | ------- | ------- |
| `backend/iterm2_backend.py:20-24` | Session variable 常量定义 | MANAGED_FLAG_VAR 等 |
| `backend/iterm2_backend.py:64-85` | `cleanup_managed_terminals` | 遍历+过滤+关闭模式 |
| `backend/iterm2_backend.py:120-148` | `create_terminal` | 打标记+隐藏窗口流程 |
| `backend/iterm2_backend.py:223-228` | `focus` | 显现窗口参考 |
| `backend/iterm2_backend.py:272-285` | `close` | 关闭终端流程 |
| `backend/iterm2_backend.py:330-336` | `_is_managed_session` | 判断是否被管理 |
| `service.py:94-116` | `create_terminal` | 创建记录+启动监控+广播 |
| `service.py:171-190` | `close_terminal/close_all` | 关闭流程 |
| `service.py:268-289` | `_start_monitor/_monitor_terminal` | 屏幕流监控 |
| `service.py:291-303` | `_mark_terminal_closed` | 关闭状态标记+取消监控 |
| `server.py:157-164` | `close_terminal` 路由 | 路由模式参考 |
| `models.py:36-40` | `TerminalHandle` | window_id + session_id + tab_id |
| `static/app.js:1107-1121` | `detailsToggle.onclick` | 菜单事件绑定位置 |
| `static/app.js:1229-1260` | `renderTerminalCard` | 卡片 HTML 渲染模板 |

### Technical Decisions

- **Detach 操作顺序**：①显现 iTerm2 窗口（focus 方式）→ ②清除 3 个 session variable → ③取消 monitor task → ④从 `self.records` 移除 → ⑤广播 snapshot 事件（全量刷新前端）
- **Detach 不调用 `backend.close()`**：区别于关闭，不杀进程、不关窗口
- **Attach 扫描逻辑**：复用 `cleanup_managed_terminals` 的遍历模式，但反向过滤：只返回 `mitm_managed != true` 且 `mitm_role != anchor` 的 session
- **Attach 需要获取终端名称**：通过 `session.async_get_variable("name")` 或 `session.name` 获取
- **接管后复用 `create_terminal` 的后半段**：打标记 → 创建 TerminalRecord → 启动监控 → 隐藏窗口 → 广播
- **前端解绑确认**：因为操作不可逆（窗口会显现、从监控墙消失），建议用 `confirm()` 弹窗
- **重启安全已确认**：`close_all_terminals` 只遍历 `self.records`（解绑后已移除），`cleanup_managed_terminals` 只关闭 `mitm_managed=true`（解绑后已清除标记），两条路径都安全

## Implementation Plan

### Task 1: Backend — 新增 `detach` 方法（清标记+显现窗口）

- [x] Task 1: 在 `ITerm2Backend` 中新增 `detach(handle)` 方法
  - File: `src/multi_iterm2_manager/backend/iterm2_backend.py`
  - Action: 在 `focus` 方法（line 223）后面新增 `detach` 方法，内部逻辑：
    1. 调用 `focus` 的相同逻辑显现窗口（`app.async_activate()` + `session.async_activate()`）
    2. 清除 3 个 session variable：`session.async_set_variable(MANAGED_FLAG_VAR, "")`, `session.async_set_variable(MANAGED_OWNER_VAR, "")`, `session.async_set_variable(ANCHOR_ROLE_VAR, "")`
    3. 用 `_run_with_reconnect` 包装
  - Notes: 不调用 `close()`，不杀进程，不关窗口。设为空字符串即可让 `_is_managed_session` 返回 False

### Task 2: Backend — 新增 `scan_unmanaged_sessions` 方法

- [x] Task 2: 在 `ITerm2Backend` 中新增 `scan_unmanaged_sessions()` 方法
  - File: `src/multi_iterm2_manager/backend/iterm2_backend.py`
  - Action: 复用 `cleanup_managed_terminals`（line 64）的遍历模式，但反向过滤。返回 `list[dict]`，每个 dict 包含：
    - `session_id`: session.session_id
    - `window_id`: window.window_id
    - `tab_id`: tab.tab_id
    - `name`: `await session.async_get_variable("name")` 或 session.name，fallback 到 session_id
    - `title`: `await session.async_get_variable("terminalTitle")` 或空字符串（用于预览标题）
  - 过滤条件：排除 `_is_managed_session` 为 True 的，排除 `mitm_role == "anchor"` 的
  - Notes: 用 `_run_with_reconnect` 包装

### Task 3: Backend — 新增 `adopt` 方法（打管理标记）

- [x] Task 3: 在 `ITerm2Backend` 中新增 `adopt(session_id, name)` 方法
  - File: `src/multi_iterm2_manager/backend/iterm2_backend.py`
  - Action: 接受 session_id，执行 `create_terminal`（line 120）后半段的打标记逻辑：
    1. 通过 `_get_session(session_id)` 获取 session 对象
    2. 设置 3 个标记：`MANAGED_FLAG_VAR=True`, `MANAGED_OWNER_VAR=MANAGED_OWNER_VALUE`, `ANCHOR_ROLE_VAR="managed"`
    3. 通过 session 获取 window_id 和 tab_id，构建 `TerminalHandle`
    4. 可选：设置终端名称 `session.async_set_name(name)`
    5. 调用 `hide_app()` 隐藏窗口
  - Returns: `TerminalHandle`
  - Notes: 用 `_run_with_reconnect` 包装。需通过 app 遍历找到 session 所在的 window 和 tab 来构建完整 TerminalHandle

### Task 4: Service — 新增 `detach_terminal` 编排方法

- [x] Task 4: 在 `DashboardService` 中新增 `detach_terminal(terminal_id)` 方法
  - File: `src/multi_iterm2_manager/service.py`
  - Action: 在 `close_terminal`（line 171）附近新增，逻辑：
    1. 通过 `_get_record(terminal_id)` 获取记录（不存在抛 KeyError）
    2. 若 `record.status == TerminalStatus.closed`，抛 `ValueError("终端已关闭，无法解绑")`
    3. 调用 `self.backend.detach(record.handle)` — 显现窗口+清标记
    4. 取消该终端的 monitor task：`task = self.monitor_tasks.pop(record.id, None); if task: task.cancel()`
    5. 从 `self.records` 中删除该记录：`del self.records[record.id]`
    6. 广播 `self.snapshot_event()`（全量刷新，因为卡片已移除）
  - Returns: `{"detached": True, "terminalId": terminal_id}`

### Task 5: Service — 新增 `scan_sessions` 和 `adopt_terminal` 编排方法

- [x] Task 5a: 新增 `scan_sessions()` 方法
  - File: `src/multi_iterm2_manager/service.py`
  - Action: 直接调用并返回 `self.backend.scan_unmanaged_sessions()` 的结果
  - Returns: `list[dict]`

- [x] Task 5b: 新增 `adopt_terminal(session_id, name)` 方法
  - File: `src/multi_iterm2_manager/service.py`
  - Action: 复用 `create_terminal`（line 94）的后半段逻辑：
    1. 调用 `await self.backend.adopt(session_id, name)` 获取 `TerminalHandle`
    2. 获取 frame：`await self.backend.get_frame(handle)`
    3. 创建 `TerminalRecord`（`id=new_terminal_id()`, `name=name`, `handle=handle`, `frame=frame`）
    4. 放入 `self.records`
    5. 调用 `self.refresh_terminal(record.id)` 获取初始屏幕内容
    6. 调用 `self._start_monitor(record.id)` 启动屏幕流监控
    7. 调用 `self.enter_monitor_mode()` 隐藏 iTerm2
    8. 广播 `self.record_event(record.id)`
  - Returns: `record.to_dict()`
  - Notes: 如果 `name` 为空，用 `self._next_default_name()` 生成默认名

### Task 6: Server — 新增 3 个路由

- [x] Task 6: 在 `server.py` 中新增 3 个路由
  - File: `src/multi_iterm2_manager/server.py`
  - Action: 在 `close_terminal` 路由（line 157）附近，按现有 try/except 模式新增：

  **6a) POST `/api/terminals/{terminal_id}/detach`**
  ```python
  @app.post("/api/terminals/{terminal_id}/detach")
  async def detach_terminal(terminal_id: str) -> dict:
      try:
          return await service.detach_terminal(terminal_id)
      except KeyError as exc:
          raise HTTPException(status_code=404, detail=str(exc)) from exc
      except ValueError as exc:
          raise HTTPException(status_code=400, detail=str(exc)) from exc
      except Exception as exc:
          raise HTTPException(status_code=500, detail=str(exc)) from exc
  ```

  **6b) GET `/api/iterm2/sessions`**
  ```python
  @app.get("/api/iterm2/sessions")
  async def scan_sessions() -> dict:
      try:
          sessions = await service.scan_sessions()
          return {"items": sessions}
      except Exception as exc:
          raise HTTPException(status_code=500, detail=str(exc)) from exc
  ```

  **6c) POST `/api/terminals/adopt`**
  新增 Pydantic payload：
  ```python
  class AdoptPayload(BaseModel):
      session_id: str
      name: str | None = Field(default=None, max_length=60)
  ```
  路由：
  ```python
  @app.post("/api/terminals/adopt")
  async def adopt_terminal(payload: AdoptPayload) -> dict:
      try:
          terminal = await service.adopt_terminal(payload.session_id, payload.name)
          return {"item": terminal, "layout": service.monitor_layout()}
      except ValueError as exc:
          raise HTTPException(status_code=400, detail=str(exc)) from exc
      except Exception as exc:
          raise HTTPException(status_code=500, detail=str(exc)) from exc
  ```

### Task 7: Frontend — 卡片 ⋯ 菜单添加"解绑"按钮

- [x] Task 7: 在卡片 details panel 中添加"解绑"按钮
  - File: `src/multi_iterm2_manager/static/app.js`
  - Action:
    1. 在 `renderTerminalCard`（line 1235 `wall-card-tools` 区域）添加解绑按钮：
       ```html
       <button data-action="detach" class="secondary">解绑</button>
       ```
    2. 在 `bindCardActions`（line 1030 附近）中添加 `detach` action 处理：
       - 弹出 `confirm("确定要解绑此终端吗？解绑后终端将从监控墙消失，在 iTerm2 中显现。")` 确认
       - 调用 `POST /api/terminals/${record.id}/detach`
       - 成功后 `setMessage("终端已解绑")`
       - 错误时 `setMessage(error.message, true)`
    3. 解绑按钮仅在 `record.status !== "closed"` 时显示

### Task 8: Frontend — 任务菜单添加"接管已有终端"区域

- [x] Task 8: 在顶部"任务"菜单中添加"接管已有终端"功能
  - File: `src/multi_iterm2_manager/static/app.js` + `src/multi_iterm2_manager/static/index.html`
  - Action:
    1. 在 `index.html` 的"任务"菜单（line 24 `topbar-menu-panel--form`）中，在现有"创建新任务"表单下方，添加"接管已有终端"区域：
       ```html
       <div class="panel-title">接管已有终端</div>
       <div id="adopt-session-list" class="adopt-session-list">
         <button id="scan-sessions" class="secondary">扫描可用终端</button>
       </div>
       ```
    2. 在 `app.js` 中添加扫描和接管逻辑：
       - 点击"扫描可用终端"按钮 → `GET /api/iterm2/sessions`
       - 将返回的 session 列表渲染为可点击项（显示 `name` 和 `session_id`）
       - 每项有"接管"按钮 → `POST /api/terminals/adopt` with `{session_id, name}`
       - 接管成功后刷新列表，显示成功消息
       - 无可用终端时显示"未发现可接管的终端"

### Task 9: Frontend — 基础样式

- [x] Task 9: 为接管列表添加基础 CSS 样式
  - File: `src/multi_iterm2_manager/static/styles.css`
  - Action: 添加 `.adopt-session-list` 的简单样式：
    - 列表项之间的间距
    - 每个 session 项显示为一行（名称 + 接管按钮）
    - 扫描中 loading 状态

## Acceptance Criteria

- [ ] AC 1: Given 一个正在运行的被管理终端，when 用户点击卡片 ⋯ 菜单中的"解绑"按钮并确认，then 终端从监控墙卡片列表中消失，iTerm2 窗口显现在桌面上，终端进程继续运行
- [ ] AC 2: Given 一个已解绑的终端存在于 iTerm2 中，when 监控墙重启（stop + start），then 该终端不会被 `cleanup_managed_terminals` 关闭，session 和进程保持不变
- [ ] AC 3: Given 一个已解绑的终端存在于 iTerm2 中，when 用户点击"关闭全部终端"，then 该终端不受影响（因为已从 `self.records` 移除）
- [ ] AC 4: Given iTerm2 中存在未被管理的 session（非 anchor），when 用户在任务菜单中点击"扫描可用终端"，then 返回的列表包含该 session 的 session_id 和名称
- [ ] AC 5: Given 扫描列表显示了一个可接管的 session，when 用户点击"接管"按钮，then 该 session 被打上管理标记、纳入监控、iTerm2 窗口被隐藏、前端出现新的终端卡片
- [ ] AC 6: Given 一个已被管理的终端，when 用户执行扫描，then 该终端不出现在可接管列表中
- [ ] AC 7: Given 锚点终端（role=anchor），when 用户执行扫描，then 锚点终端不出现在可接管列表中
- [ ] AC 8: Given 一个已关闭的终端（status=closed），when 用户点击"解绑"，then 收到错误提示"终端已关闭，无法解绑"
- [ ] AC 9: Given 完整的解绑→重启→接管流程，when 用户依次执行：解绑终端A → 重启监控墙 → 扫描 → 接管终端A，then 终端A重新出现在监控墙中，屏幕内容可正常显示

## Additional Context

### Dependencies

无新增依赖，全部使用现有 iTerm2 Python API 能力。

### Testing Strategy

- 使用 MockTerminalBackend 测试 service 层的 detach/adopt 流程
- 手动测试：解绑 → 重启监控墙 → 接管回来 的完整流程
- 手动验证：解绑后 `cleanup_managed_terminals` 不影响已解绑终端
- 手动验证：解绑后"关闭全部"不影响已解绑终端
- 手动验证：扫描列表正确过滤已管理和锚点终端

### Notes

- 当前 `close_all_terminals` 只关闭 `self.records` 中的终端，解绑后已从 records 移除，自然不受影响
- `cleanup_managed_terminals`（启动时调用）会关闭所有 `mitm_managed=true` 的终端，解绑后标记已清除，也不受影响
- `adopt` 方法需要遍历 app 的 window/tab/session 树来找到 session_id 对应的 window_id 和 tab_id，因为 iTerm2 API 没有直接从 session_id 反查 window 的方法（`app.get_session_by_id` 返回 session 但无法直接获取 window_id）
- 前端解绑操作后通过 snapshot 全量刷新而非 terminal-updated 增量更新，因为卡片需要完全移除
