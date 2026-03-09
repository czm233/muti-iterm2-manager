const state = {
  terminals: new Map(),
  orderedTerminalIds: [],
  views: new Map(),
  layout: { count: 0, columns: 1, rows: 1 },
  layoutMode: 2,
  layoutEngineMode: "grid",
  fitMode: false,
  splitLayoutTree: null,
  draggedTerminalId: null,
  hoverTargetPaneId: null,
  hoverDropZone: null,
  editingTitleTerminalId: null,
  filter: "active",
  page: 1,
  pageSize: 6,
  focusedInputTerminalId: null,
};

const VIEW_STATE_STORAGE_KEY = "mitm-monitor-view-state";

function saveViewState() {
  try {
    const payload = {
      orderedTerminalIds: state.orderedTerminalIds,
      layoutMode: state.layoutMode,
      layoutEngineMode: state.layoutEngineMode,
      fitMode: state.fitMode,
      splitLayoutTree: state.splitLayoutTree,
      sidebarCollapsed: dashboardSidebar?.classList.contains("is-collapsed") || false,
    };
    window.localStorage.setItem(VIEW_STATE_STORAGE_KEY, JSON.stringify(payload));
  } catch {
  }
}

function loadViewState() {
  try {
    const raw = window.localStorage.getItem(VIEW_STATE_STORAGE_KEY);
    if (!raw) return;
    const payload = JSON.parse(raw);
    if (Array.isArray(payload.orderedTerminalIds)) {
      state.orderedTerminalIds = payload.orderedTerminalIds;
    }
    if (payload.layoutMode === 1 || payload.layoutMode === 2) {
      state.layoutMode = payload.layoutMode;
    }
    if (payload.layoutEngineMode === "grid" || payload.layoutEngineMode === "split") {
      state.layoutEngineMode = payload.layoutEngineMode;
    }
    state.fitMode = Boolean(payload.fitMode);
    state.splitLayoutTree = payload.splitLayoutTree || null;
    if (payload.sidebarCollapsed && dashboardSidebar) {
      dashboardSidebar.classList.add("is-collapsed");
    }
  } catch {
  }
}

const grid = document.getElementById("grid");
const stats = document.getElementById("stats");
const message = document.getElementById("message");
const createForm = document.getElementById("create-form");
const createDemoButton = document.getElementById("create-demo");
const monitorModeButton = document.getElementById("monitor-mode");
const refreshAllButton = document.getElementById("refresh-all");
const closeAllButton = document.getElementById("close-all");
const wallControls = document.getElementById("wall-controls");
const wsStatus = document.getElementById("ws-status");
const buildVersion = document.getElementById("build-version");
const sidebarToggle = document.getElementById("sidebar-toggle");
const dashboardLayout = document.querySelector(".dashboard-layout");
const dashboardSidebar = document.querySelector(".dashboard-sidebar");
const hero = document.querySelector(".hero");
const heroDock = document.getElementById("hero-dock");



function applySidebarState() {
  if (!dashboardLayout || !dashboardSidebar || !sidebarToggle || !hero || !heroDock) {
    return;
  }
  const collapsed = dashboardSidebar.classList.contains('is-collapsed');
  dashboardLayout.dataset.sidebarCollapsed = collapsed ? 'true' : 'false';
  sidebarToggle.textContent = collapsed ? '»' : '«';
  sidebarToggle.setAttribute('aria-label', collapsed ? '展开侧栏' : '折叠侧栏');

  if (collapsed) {
    heroDock.hidden = false;
    if (hero.parentElement !== heroDock) {
      heroDock.appendChild(hero);
    }
  } else {
    heroDock.hidden = true;
    if (hero.parentElement !== dashboardSidebar) {
      dashboardSidebar.prepend(hero);
    }
  }
}

function setWebSocketStatus(status, detail = "") {
  if (!wsStatus) {
    return;
  }
  wsStatus.className = `status-pill status-${status}`;
  if (status === "connected") {
    wsStatus.textContent = "WebSocket 已连接";
  } else if (status === "reconnecting") {
    wsStatus.textContent = detail || "WebSocket 重连中";
  } else if (status === "disconnected") {
    wsStatus.textContent = detail || "WebSocket 已断开";
  } else {
    wsStatus.textContent = detail || "WebSocket 连接中";
  }
}

function setMessage(text, isError = false) {
  if (!message) {
    return;
  }
  message.textContent = text;
  message.style.color = isError ? "#fda4af" : "#93a8cb";
}

function clearTransientErrorMessage() {
  if (!message) {
    return;
  }
  const text = (message.textContent || "").toLowerCase();
  const patterns = [
    "websocket 已断开",
    "websocket 异常",
    "no close frame received or sent",
    "close frame",
  ];
  if (patterns.some((pattern) => text.includes(pattern))) {
    setMessage("");
  }
}

function humanizeErrorMessage(text) {
  const raw = String(text || "");
  const normalized = raw.toLowerCase();
  if (normalized.includes("no close frame received or sent") || normalized.includes("connection closed") || normalized.includes("socket closed")) {
    return "与 iTerm 的底层连接刚刚断开，系统已尝试自动重连；请重试刚才的操作。";
  }
  return raw;
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : await response.text();

  if (!response.ok) {
    const detail = typeof data === "string" ? data : data.detail || "请求失败";
    throw new Error(humanizeErrorMessage(detail));
  }
  return data;
}

function statusLabel(status) {
  return {
    idle: "空闲",
    running: "运行中",
    done: "已完成",
    error: "异常",
    waiting: "等待中",
    closed: "已关闭",
  }[status] || status;
}

function filterLabel(filter) {
  return {
    all: "全部",
    active: "活跃",
    attention: "待处理",
    done: "已完成",
  }[filter] || filter;
}

function normalizeText(text) {
  if (!text) {
    return "暂无输出";
  }
  return text.replace(/\n/g, "\r\n");
}

function createLayoutId(prefix = "node") {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function createTerminalLayoutNode(terminalId) {
  return {
    id: createLayoutId("terminal"),
    type: "terminal",
    terminalId,
  };
}

function createSplitLayoutNode(direction, children) {
  return {
    id: createLayoutId("split"),
    type: "split",
    direction,
    children,
  };
}

function getActiveTerminalRecords() {
  return state.orderedTerminalIds
    .map((id) => state.terminals.get(id))
    .filter((record) => record && record.status !== "closed");
}

function buildInitialSplitTree(terminals) {
  const items = terminals.filter((record) => record.status !== "closed");
  if (items.length === 0) return null;
  if (items.length === 1) return createTerminalLayoutNode(items[0].id);
  return items.slice(1).reduce((root, record) => {
    return createSplitLayoutNode("row", [root, createTerminalLayoutNode(record.id)]);
  }, createTerminalLayoutNode(items[0].id));
}

function getTerminalIdsFromTree(node) {
  if (!node) return [];
  if (node.type === "terminal") return [node.terminalId];
  return node.children.flatMap((child) => getTerminalIdsFromTree(child));
}

function removeTerminalFromTree(node, terminalId) {
  if (!node) return null;
  if (node.type === "terminal") {
    return node.terminalId === terminalId ? null : node;
  }
  const nextChildren = node.children
    .map((child) => removeTerminalFromTree(child, terminalId))
    .filter(Boolean);
  if (nextChildren.length === 0) return null;
  if (nextChildren.length === 1) return nextChildren[0];
  return { ...node, children: nextChildren };
}

function zoneToDirection(zone) {
  return zone === "left" || zone === "right" ? "row" : "column";
}

function insertWithZone(targetNode, draggedNode, zone) {
  const direction = zoneToDirection(zone);
  if (direction === "row") {
    return createSplitLayoutNode(direction, zone === "left" ? [draggedNode, targetNode] : [targetNode, draggedNode]);
  }
  return createSplitLayoutNode(direction, zone === "top" ? [draggedNode, targetNode] : [targetNode, draggedNode]);
}

function insertTerminalBySplit(node, targetTerminalId, draggedNode, zone) {
  if (!node) return draggedNode;
  if (node.type === "terminal") {
    if (node.terminalId === targetTerminalId) {
      return insertWithZone(node, draggedNode, zone);
    }
    return node;
  }
  const direction = zoneToDirection(zone);
  const targetChildIndex = node.children.findIndex((child) => child.type === "terminal" && child.terminalId === targetTerminalId);
  if (targetChildIndex !== -1 && node.direction === direction) {
    const nextChildren = [...node.children];
    const insertIndex = (zone === "left" || zone === "top") ? targetChildIndex : targetChildIndex + 1;
    nextChildren.splice(insertIndex, 0, draggedNode);
    return { ...node, children: nextChildren };
  }
  return {
    ...node,
    children: node.children.map((child) => insertTerminalBySplit(child, targetTerminalId, draggedNode, zone)),
  };
}

function appendTerminalToSplitTree(root, terminalId) {
  const node = createTerminalLayoutNode(terminalId);
  if (!root) return node;
  if (root.type === "split" && root.direction === "row") {
    return { ...root, children: [...root.children, node] };
  }
  return createSplitLayoutNode("row", [root, node]);
}

function syncSplitTree() {
  if (state.layoutEngineMode !== "split") {
    return;
  }
  const active = getActiveTerminalRecords();
  if (!state.splitLayoutTree) {
    state.splitLayoutTree = buildInitialSplitTree(active);
    return;
  }
  const activeIds = active.map((record) => record.id);
  const treeIds = getTerminalIdsFromTree(state.splitLayoutTree);
  let nextTree = state.splitLayoutTree;
  for (const treeId of treeIds) {
    if (!activeIds.includes(treeId)) {
      nextTree = removeTerminalFromTree(nextTree, treeId);
    }
  }
  const nextIds = getTerminalIdsFromTree(nextTree);
  for (const record of active) {
    if (!nextIds.includes(record.id)) {
      nextTree = appendTerminalToSplitTree(nextTree, record.id);
    }
  }
  state.splitLayoutTree = nextTree;
}

function getDropZone(event, element) {
  const rect = element.getBoundingClientRect();
  const localX = event.clientX - rect.left;
  const localY = event.clientY - rect.top;
  const width = rect.width;
  const height = rect.height;

  const horizontalBand = Math.max(28, Math.min(96, width * 0.24));
  const verticalBand = Math.max(28, Math.min(96, height * 0.24));

  const inLeft = localX <= horizontalBand;
  const inRight = localX >= width - horizontalBand;
  const inTop = localY <= verticalBand;
  const inBottom = localY >= height - verticalBand;

  const candidates = [];
  if (inLeft) candidates.push({ zone: 'left', value: localX });
  if (inRight) candidates.push({ zone: 'right', value: width - localX });
  if (inTop) candidates.push({ zone: 'top', value: localY });
  if (inBottom) candidates.push({ zone: 'bottom', value: height - localY });

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => a.value - b.value);
  return candidates[0].zone;
}

function clearSplitDropPreview() {
  state.hoverTargetPaneId = null;
  state.hoverDropZone = null;
  document.querySelectorAll('.wall-card').forEach((card) => {
    card.classList.remove('split-preview-left', 'split-preview-right', 'split-preview-top', 'split-preview-bottom');
  });
}

function applySplitDropPreview(card, terminalId, zone) {
  clearSplitDropPreview();
  if (!card || !zone) return;
  state.hoverTargetPaneId = terminalId;
  state.hoverDropZone = zone;
  card.classList.add(`split-preview-${zone}`);
}

function commitSplitDrop(targetTerminalId, zone) {
  if (!state.draggedTerminalId || !targetTerminalId || !zone) return;
  if (state.draggedTerminalId === targetTerminalId) return;
  const active = getActiveTerminalRecords();
  const draggedNode = createTerminalLayoutNode(state.draggedTerminalId);
  const removed = removeTerminalFromTree(state.splitLayoutTree || buildInitialSplitTree(active), state.draggedTerminalId);
  state.splitLayoutTree = insertTerminalBySplit(removed, targetTerminalId, draggedNode, zone);
  clearSplitDropPreview();
  saveViewState();
  refreshWall();
}

function escapeHtml(text) {
  return (text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function updateTerminalSnapshot(record, mount) {
  if (!mount) {
    return;
  }
  const text = record.screenText && record.screenText.trim() ? record.screenText : "暂无输出";
  mount.innerHTML = record.screenHtml || `<pre class="terminal-mirror">${escapeHtml(text)}</pre>`;
  window.requestAnimationFrame(() => {
    mount.scrollTop = mount.scrollHeight;
    const mirror = mount.querySelector(".terminal-mirror");
    if (mirror) {
      mirror.scrollTop = mirror.scrollHeight;
    }
  });
}

function inferLayout(terminals) {
  const count = terminals.filter((record) => record.status !== "closed").length;
  if (count <= 0) return { count: 0, columns: 1, rows: 1, fitMode: state.fitMode };
  const columns = Math.max(1, Math.min(2, state.layoutMode || 2));
  return { count, columns, rows: Math.max(1, Math.ceil(count / columns)), fitMode: state.fitMode };
}

function applyLayout(_layoutFromServer = null) {
  const active = getActiveTerminalRecords();
  const layout = inferLayout(active);
  state.layout = layout;
  grid.dataset.columns = String(Math.min(layout.columns || 1, 4));
  grid.dataset.rows = String(layout.rows || 1);
  grid.dataset.fitMode = layout.fitMode ? "true" : "false";
  grid.dataset.engine = state.layoutEngineMode;
  syncSplitTree();
}

function getFilteredTerminals() {
  const all = state.orderedTerminalIds
    .map((id) => state.terminals.get(id))
    .filter(Boolean);
  if (state.filter === "all") return all;
  if (state.filter === "active") return all.filter((record) => record.status !== "closed");
  if (state.filter === "attention") return all.filter((record) => ["error", "waiting"].includes(record.status));
  if (state.filter === "done") return all.filter((record) => record.status === "done");
  return all;
}

function shouldPaginateCurrentFilter() {
  return state.filter === "all" || state.filter === "done";
}

function getPagedTerminals() {
  const filtered = getFilteredTerminals();
  if (state.layoutEngineMode === "split" || !shouldPaginateCurrentFilter()) {
    state.page = 1;
    return {
      items: filtered,
      totalPages: 1,
      totalItems: filtered.length,
    };
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / state.pageSize));
  state.page = Math.min(state.page, totalPages);
  const start = (state.page - 1) * state.pageSize;
  return {
    items: filtered.slice(start, start + state.pageSize),
    totalPages,
    totalItems: filtered.length,
  };
}

function getNextAttentionTerminal() {
  return [...state.terminals.values()].find((record) => record.status === "error") || [...state.terminals.values()].find((record) => record.status === "waiting");
}


function syncTerminalOrder(terminals) {
  const incomingIds = terminals.map((record) => record.id);
  const existing = state.orderedTerminalIds.filter((id) => incomingIds.includes(id));
  const appended = incomingIds.filter((id) => !existing.includes(id));
  state.orderedTerminalIds = [...existing, ...appended];
}

function shouldIgnoreDragStart(target) {
  return Boolean(target.closest('.wall-card-terminal, button, input, textarea, details, summary, .wall-card-input, .wall-card-details-panel, .wall-card-details'));
}

function reorderTerminals(sourceId, targetId) {
  if (!sourceId || !targetId || sourceId === targetId) {
    return;
  }
  const ids = [...state.orderedTerminalIds];
  const sourceIndex = ids.indexOf(sourceId);
  const targetIndex = ids.indexOf(targetId);
  if (sourceIndex === -1 || targetIndex === -1) {
    return;
  }
  const [item] = ids.splice(sourceIndex, 1);
  ids.splice(targetIndex, 0, item);
  state.orderedTerminalIds = ids;
  saveViewState();
  refreshWall();
}

function renderStats() {
  const counts = { running: 0, done: 0, waiting: 0, error: 0, closed: 0, idle: 0 };
  for (const record of state.terminals.values()) {
    counts[record.status] = (counts[record.status] || 0) + 1;
  }
  const page = getPagedTerminals();
  stats.innerHTML = [
    `<span class="stat-chip status-running">活跃 ${state.layout.count}</span>`,
    `<span class="stat-chip status-running">布局 ${state.layout.columns} × ${state.layout.rows}</span>`,
    `<span class="stat-chip status-running">筛选 ${filterLabel(state.filter)}</span>`,
    `<span class="stat-chip status-running">页码 ${state.page}/${page.totalPages}</span>`,
    `<span class="stat-chip status-running">运行中 ${counts.running}</span>`,
    `<span class="stat-chip status-done">已完成 ${counts.done}</span>`,
    `<span class="stat-chip status-waiting">等待中 ${counts.waiting}</span>`,
    `<span class="stat-chip status-error">异常 ${counts.error}</span>`,
  ].join("");
}

async function focusTerminal(id, name) {
  await request(`/api/terminals/${id}/focus`, { method: "POST" });
  setMessage(`已切到 ${name}，现在可以在原生 iTerm 手动接管`);
}

async function renameTerminal(id, name) {
  return await request(`/api/terminals/${id}/rename`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

function restoreInputFocus(card, record) {
  if (state.focusedInputTerminalId !== record.id) {
    return;
  }
  const input = card.querySelector(".wall-card-input input");
  const inputWrap = card.querySelector(".wall-card-input-wrap");
  if (!input || !inputWrap) {
    return;
  }
  inputWrap.classList.add("is-expanded");
  const form = card.querySelector(".wall-card-input");
  if (form) {
    form.hidden = false;
  }
  window.requestAnimationFrame(() => {
    input.focus();
    const length = input.value.length;
    input.setSelectionRange(length, length);
  });
}

function bindCardActions(card, record) {
  card.draggable = true;
  card.ondragstart = (event) => {
    if (shouldIgnoreDragStart(event.target) || record.status === "closed") {
      event.preventDefault();
      return;
    }
    state.draggedTerminalId = record.id;
    card.classList.add('is-dragging');
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', record.id);
    }
  };
  card.ondragend = () => {
    state.draggedTerminalId = null;
    card.classList.remove('is-dragging');
    clearSplitDropPreview();
  };
  card.ondragover = (event) => {
    if (!state.draggedTerminalId || state.draggedTerminalId === record.id) {
      return;
    }
    event.preventDefault();
    if (state.layoutEngineMode === 'split') {
      const zone = getDropZone(event, card);
      if (zone) {
        applySplitDropPreview(card, record.id, zone);
      } else {
        clearSplitDropPreview();
      }
      return;
    }
    card.classList.add('is-drag-over');
  };
  card.ondragleave = () => {
    card.classList.remove('is-drag-over');
    if (state.layoutEngineMode === 'split') {
      clearSplitDropPreview();
    }
  };
  card.ondrop = (event) => {
    event.preventDefault();
    card.classList.remove('is-drag-over');
    if (state.layoutEngineMode === 'split') {
      const zone = getDropZone(event, card);
      commitSplitDrop(record.id, zone);
      return;
    }
    reorderTerminals(state.draggedTerminalId, record.id);
  };
  const startRename = () => {
    if (!title || !titleInput) return;
    state.editingTitleTerminalId = record.id;
    title.hidden = true;
    titleInput.hidden = false;
    titleInput.value = record.name;
    window.requestAnimationFrame(() => {
      titleInput.focus();
      titleInput.select();
    });
  };

  const finishRename = async (commit) => {
    if (!title || !titleInput) return;
    const nextName = titleInput.value.trim();
    titleInput.hidden = true;
    title.hidden = false;
    if (!commit) {
      state.editingTitleTerminalId = null;
      refreshWall();
      return;
    }
    if (!nextName || nextName === record.name) {
      state.editingTitleTerminalId = null;
      refreshWall();
      return;
    }
    try {
      await renameTerminal(record.id, nextName);
      state.editingTitleTerminalId = null;
      setMessage(`已将终端重命名为 ${nextName}`);
    } catch (error) {
      state.editingTitleTerminalId = record.id;
      title.hidden = true;
      titleInput.hidden = false;
      window.requestAnimationFrame(() => titleInput.focus());
      setMessage(error.message, true);
    }
  };

  const terminalArea = card.querySelector(".wall-card-terminal");
  const details = card.querySelector(".wall-card-details");
  const title = card.querySelector(".wall-card-title");
  const titleInput = card.querySelector(".wall-card-title-input");
  const summary = details?.querySelector("summary");

  const detailsPanel = card.querySelector(".wall-card-details-panel");

  if (details) {
    details.onclick = (event) => event.stopPropagation();
  }
  if (title) {
    title.ondblclick = (event) => {
      event.stopPropagation();
      startRename();
    };
  }
  if (titleInput) {
    titleInput.onclick = (event) => event.stopPropagation();
    titleInput.onkeydown = async (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        await finishRename(true);
      }
      if (event.key === "Escape") {
        event.preventDefault();
        await finishRename(false);
      }
    };
    titleInput.onblur = async () => {
      await finishRename(true);
    };
  }
  if (summary) {
    summary.onclick = (event) => {
      event.stopPropagation();
      event.preventDefault();
      const expanded = details.open;
      details.open = !expanded;
      if (detailsPanel) {
        detailsPanel.hidden = expanded;
      }
    };
  }

  terminalArea.onclick = async (event) => {
    event.stopPropagation();
    if (record.status === "closed") return;
    try {
      await focusTerminal(record.id, record.name);
    } catch (error) {
      setMessage(error.message, true);
    }
  };

  card.querySelector("[data-action='refresh']").onclick = async (event) => {
    event.stopPropagation();
    try {
      await request(`/api/terminals/${record.id}/refresh`, { method: "POST" });
      setMessage(`已刷新 ${record.name}`);
    } catch (error) {
      setMessage(error.message, true);
    }
  };

  card.querySelector("[data-action='hide']").onclick = async (event) => {
    event.stopPropagation();
    try {
      await request("/api/workspace/monitor-mode", { method: "POST" });
      setMessage("真实 iTerm 已退到后台，回到监控模式");
    } catch (error) {
      setMessage(error.message, true);
    }
  };

  const inputWrap = card.querySelector(".wall-card-input-wrap");
  const inputToggle = card.querySelector(".wall-card-input-toggle");
  const form = card.querySelector(".wall-card-input");
  const input = form.querySelector("input");

  const expandInput = () => {
    inputWrap.classList.add("is-expanded");
    form.hidden = false;
    window.requestAnimationFrame(() => {
      input.focus();
      const length = input.value.length;
      input.setSelectionRange(length, length);
    });
  };

  const collapseInput = () => {
    inputWrap.classList.remove("is-expanded");
    form.hidden = true;
  };

  const send = async () => {
    if (!input.value.trim()) return;
    try {
      state.focusedInputTerminalId = record.id;
      await request(`/api/terminals/${record.id}/send-text`, { method: "POST", body: JSON.stringify({ text: input.value }) });
      input.value = "";
      setMessage(`已向 ${record.name} 发送命令`);
      expandInput();
    } catch (error) {
      setMessage(error.message, true);
    }
  };

  inputToggle.onclick = (event) => {
    event.stopPropagation();
    if (inputWrap.classList.contains("is-expanded")) {
      collapseInput();
    } else {
      expandInput();
    }
  };

  form.querySelector("button").onclick = async (event) => {
    event.stopPropagation();
    await send();
  };
  input.onclick = (event) => {
    event.stopPropagation();
    state.focusedInputTerminalId = record.id;
  };
  input.onfocus = () => {
    state.focusedInputTerminalId = record.id;
  };
  input.onkeydown = async (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      await send();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      collapseInput();
    }
  };
}

function renderTerminalCard(record) {
  return renderTerminal(record);
}

function renderLayoutNode(node) {
  if (!node) {
    return null;
  }
  if (node.type === 'terminal') {
    const record = state.terminals.get(node.terminalId);
    if (!record || record.status === 'closed') {
      return null;
    }
    const pane = document.createElement('div');
    pane.className = 'split-pane';
    pane.dataset.terminalId = node.terminalId;
    const card = renderTerminalCard(record);
    pane.appendChild(card);
    return pane;
  }
  const wrap = document.createElement('div');
  wrap.className = `split-node split-node--${node.direction}`;
  wrap.dataset.nodeId = node.id;
  for (const child of node.children) {
    const childElement = renderLayoutNode(child);
    if (childElement) {
      wrap.appendChild(childElement);
    }
  }
  return wrap;
}

function renderTerminal(record) {
  let card = document.getElementById(`card-${record.id}`);
  if (!card) {
    card = document.createElement("section");
    card.id = `card-${record.id}`;
    card.className = "wall-card";
  }

  card.className = `wall-card status-${record.status}`;
  card.innerHTML = `
    <div class="wall-card-header">
      <div class="wall-card-title-row">
        <h2 class="wall-card-title" ${state.editingTitleTerminalId === record.id ? 'hidden' : ''}>${escapeHtml(record.name)}</h2>
        <input class="wall-card-title-input" type="text" value="${escapeHtml(record.name)}" ${state.editingTitleTerminalId === record.id ? '' : 'hidden'} />
      </div>
      <div class="wall-card-tools">
        <span class="badge status-${record.status}">${statusLabel(record.status)}</span>
        <span class="marker">${escapeHtml(record.updatedAt || "-")}</span>
        <button data-action="refresh" class="secondary">刷新</button>
        <button data-action="hide" class="secondary">回监控模式</button>
        <button type="button" class="secondary wall-card-input-toggle">命令</button>
        <details class="wall-card-details">
          <summary>更多信息</summary>
        </details>
      </div>
      <div class="wall-card-details-panel ${record.lastError || record.summary || (record.markers && record.markers.length) ? '' : 'is-empty'}" hidden>
        <div class="wall-card-meta">session ${escapeHtml(record.sessionId || "-")} · window ${escapeHtml(record.windowId || "-")}</div>
        <div class="wall-card-summary">${escapeHtml(record.summary || "暂无摘要")}</div>
        ${record.lastError ? `<div class="wall-card-error">错误：${escapeHtml(record.lastError)}</div>` : ""}
        <div class="wall-card-marker-list">${(record.markers || []).map((item) => `<span class="marker">${escapeHtml(item)}</span>`).join("")}</div>
      </div>
    </div>
    <div class="wall-card-terminal"></div>
    <div class="wall-card-input-wrap">
      <div class="wall-card-input" hidden>
        <input type="text" placeholder="快速发命令，例如：echo done" />
        <button type="button" class="secondary">发送</button>
      </div>
    </div>
  `;

  updateTerminalSnapshot(record, card.querySelector(".wall-card-terminal"));
  bindCardActions(card, record);
  restoreInputFocus(card, record);
  return card;
}

function renderEmptyState() {
  grid.innerHTML = `
    <section class="empty-state">
      <h2>还没有监控任务</h2>
      <p>启动 1 个任务时显示单屏，2 个任务自动左右布局，3-4 个自动四宫格，5-6 个自动 2×3。</p>
    </section>
  `;
}

function renderToolbarExtras(pageInfo) {
  const nextAttention = getNextAttentionTerminal();
  wallControls.innerHTML = `
    <div class="panel-title">布局 / 筛选 / 翻页</div>
    <div class="wall-control-actions">
      <button data-engine="grid" class="secondary ${state.layoutEngineMode === "grid" ? "is-active" : ""}">网格布局</button>
      <button data-engine="split" class="secondary ${state.layoutEngineMode === "split" ? "is-active" : ""}">Split（Beta）</button>
      <button id="reset-grid" class="ghost">重置为网格</button>
    </div>
    <div class="wall-control-actions">
      <button data-layout="1" class="secondary ${state.layoutMode === 1 ? "is-active" : ""}" ${state.layoutEngineMode === "split" ? "disabled" : ""}>每行 1 个</button>
      <button data-layout="2" class="secondary ${state.layoutMode === 2 ? "is-active" : ""}" ${state.layoutEngineMode === "split" ? "disabled" : ""}>每行 2 个</button>
      <button id="toggle-fit-mode" class="secondary ${state.fitMode ? "is-active" : ""}" ${state.layoutEngineMode === "split" ? "disabled" : ""}>四终端铺满</button>
    </div>
    <div class="wall-control-actions">
      <button data-filter="active" class="secondary ${state.filter === "active" ? "is-active" : ""}">活跃</button>
      <button data-filter="attention" class="secondary ${state.filter === "attention" ? "is-active" : ""}">待处理</button>
      <button data-filter="done" class="secondary ${state.filter === "done" ? "is-active" : ""}">已完成</button>
      <button data-filter="all" class="secondary ${state.filter === "all" ? "is-active" : ""}">全部</button>
      <button id="prev-page" class="ghost" ${shouldPaginateCurrentFilter() ? "" : "disabled"}>上一页</button>
      <button id="next-page" class="ghost" ${shouldPaginateCurrentFilter() ? "" : "disabled"}>下一页</button>
      <button id="focus-attention" class="secondary">接管下一个待处理</button>
      <span class="wall-page-text">当前 ${pageInfo.totalItems} 个 · 第 ${state.page}/${pageInfo.totalPages} 页</span>
      ${nextAttention ? `<span class="marker marker-alert">待处理：${escapeHtml(nextAttention.name)}</span>` : `<span class="marker">当前没有待处理任务</span>`}
    </div>
  `;

  wallControls.querySelectorAll("[data-engine]").forEach((button) => {
    button.onclick = () => {
      state.layoutEngineMode = button.dataset.engine;
      if (state.layoutEngineMode === 'split') {
        state.splitLayoutTree = buildInitialSplitTree(getActiveTerminalRecords());
      }
      saveViewState();
      refreshWall();
    };
  });

  wallControls.querySelector("#reset-grid").onclick = () => {
    state.layoutEngineMode = 'grid';
    state.splitLayoutTree = null;
    clearSplitDropPreview();
    saveViewState();
    refreshWall();
  };

  wallControls.querySelectorAll("[data-layout]").forEach((button) => {
    button.onclick = () => {
      state.layoutMode = Number(button.dataset.layout || 2);
      saveViewState();
      refreshWall();
    };
  });

  wallControls.querySelector("#toggle-fit-mode").onclick = () => {
    state.fitMode = !state.fitMode;
    saveViewState();
    refreshWall();
  };

  wallControls.querySelectorAll("[data-filter]").forEach((button) => {
    button.onclick = () => {
      state.filter = button.dataset.filter;
      state.page = 1;
      saveViewState();
      refreshWall();
    };
  });

  wallControls.querySelector("#prev-page").onclick = () => {
    state.page = Math.max(1, state.page - 1);
    saveViewState();
    refreshWall();
  };

  wallControls.querySelector("#next-page").onclick = () => {
    state.page = Math.min(pageInfo.totalPages, state.page + 1);
    saveViewState();
    refreshWall();
  };

  wallControls.querySelector("#focus-attention").onclick = async () => {
    const target = getNextAttentionTerminal();
    if (!target) {
      setMessage("当前没有等待中或异常的任务");
      return;
    }
    try {
      await focusTerminal(target.id, target.name);
    } catch (error) {
      setMessage(error.message, true);
    }
  };
}

function refreshWall(layout = null) {
  applyLayout(layout);
  const pageInfo = getPagedTerminals();
  grid.innerHTML = "";
  if (pageInfo.items.length === 0) {
    renderEmptyState();
  } else if (state.layoutEngineMode === 'split' && state.splitLayoutTree) {
    const treeElement = renderLayoutNode(state.splitLayoutTree);
    if (treeElement) {
      grid.appendChild(treeElement);
    } else {
      renderEmptyState();
    }
  } else {
    for (const record of pageInfo.items) {
      grid.appendChild(renderTerminal(record));
    }
  }
  renderToolbarExtras(pageInfo);
  renderStats();
}

function applySnapshot(terminals, layout = null) {
  state.terminals.clear();
  for (const record of terminals) {
    state.terminals.set(record.id, record);
  }
  syncTerminalOrder(terminals);
  syncSplitTree();
  refreshWall(layout);
}

async function loadInitialState() {
  loadViewState();
  applySidebarState();
  const [terminalsData, healthData] = await Promise.all([request("/api/terminals"), request("/api/health")]);
  applySnapshot(terminalsData.items || [], terminalsData.layout || null);
  if (buildVersion && healthData.version) {
    buildVersion.textContent = `v${healthData.version}`;
  }
  saveViewState();
}

function connectWebSocket() {
  setWebSocketStatus("connecting");
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
  socket.onopen = () => { setWebSocketStatus("connected"); clearTransientErrorMessage(); socket.send("ready"); };
  socket.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "snapshot") {
      applySnapshot(payload.terminals || [], payload.layout || null);
      return;
    }
    if (payload.type === "terminal-updated") {
      state.terminals.set(payload.terminal.id, payload.terminal);
      if (!state.orderedTerminalIds.includes(payload.terminal.id)) {
        state.orderedTerminalIds.push(payload.terminal.id);
      }
      syncSplitTree();
      refreshWall(payload.layout || null);
      return;
    }
    if (payload.type === "monitor-layout" || payload.type === "workspace-mode") {
      refreshWall(payload.layout || null);
    }
  };
  socket.onerror = () => {
    setWebSocketStatus("disconnected", "WebSocket 异常");
  };
  socket.onclose = () => {
    setWebSocketStatus("reconnecting", "WebSocket 重连中");
    setMessage("WebSocket 已断开，3 秒后重连", true);
    window.setTimeout(connectWebSocket, 3000);
  };
}

createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = document.getElementById("name").value.trim();
  const command = "";
  try {
    const result = await request("/api/terminals", { method: "POST", body: JSON.stringify({ name: name || null, command: command || null }) });
    createForm.reset();
    setMessage(`已启动 ${result.item.name}，真实 iTerm 窗口已被纳入监控墙`);
  } catch (error) {
    setMessage(error.message, true);
  }
});

createDemoButton.onclick = async () => {
  try {
    await request("/api/terminals/demo", { method: "POST", body: JSON.stringify({ count: 4 }) });
    setMessage("已创建 4 个示例任务，并切回监控模式");
  } catch (error) {
    setMessage(error.message, true);
  }
};

monitorModeButton.onclick = async () => {
  try {
    await request("/api/workspace/monitor-mode", { method: "POST" });
    setMessage("已回到监控模式，真实 iTerm 退到后台");
  } catch (error) {
    setMessage(error.message, true);
  }
};

refreshAllButton.onclick = async () => {
  try {
    const terminals = [...state.terminals.values()].filter((record) => record.status !== "closed");
    await Promise.all(terminals.map((record) => request(`/api/terminals/${record.id}/refresh`, { method: "POST" })));
    setMessage("已刷新全部监控卡片");
  } catch (error) {
    setMessage(error.message, true);
  }
};

closeAllButton.onclick = async () => {
  try {
    await request("/api/terminals/close-all", { method: "POST" });
    setMessage("已关闭全部真实窗口，并清空监控墙");
  } catch (error) {
    setMessage(error.message, true);
  }
};

loadInitialState().then(connectWebSocket).catch((error) => {
  setMessage(error.message, true);
  connectWebSocket();
});

if (sidebarToggle) {
  sidebarToggle.onclick = () => {
    dashboardSidebar?.classList.toggle("is-collapsed");
    applySidebarState();
    saveViewState();
  };
  applySidebarState();
}
