const state = {
  terminals: new Map(),
  orderedTerminalIds: [],
  views: new Map(),
  layout: { count: 0, columns: 1, rows: 1 },
  nextFitMode: false,
  gridTrackRatios: {},
  layoutTree: null,
  draggedTerminalId: null,
  hoverTargetPaneId: null,
  hoverDropZone: null,
  activeGridResize: null,
  activeSplitResize: null,
  activeCardDrag: null,
  editingTitleTerminalId: null,
  filter: "default",
  page: 1,
  pageSize: 6,
  focusedInputTerminalId: null,
  uiSettings: null,
  defaultUiSettings: null,
  hiddenTerminalIds: new Set(),   // 用户手动隐藏的终端 ID 集合，持久化到 localStorage
  mutedTerminalIds: new Set(),    // 用户手动静默的终端 ID 集合，静默终端不进入队列
  attentionSnapshot: null,        // 进入"待处理"筛选时快照的 ID 集合，避免处理后立即消失
  _rafPending: false,             // rAF 是否已调度
  _needFullRefresh: false,        // 是否需要全量刷新
  _pendingLayout: null,           // 待应用的 layout
  _incrementalIds: new Set(),     // 需要增量更新的终端 ID 集合
  queue: [],                       // 队列: [{ id, name, status }]
  queueDismissed: new Map(),       // 用户手动移除的终端: Map<id, status> — 状态变化后自动清除
  allTags: [],                     // 全局标签列表，从后端同步
  selectedTag: null,               // 当前选中的标签筛选
  appMonitors: new Map(),          // App 监控数据: Map<appId, monitor>
  orderedAppMonitorIds: [],        // App 监控有序 ID 列表
};

const VIEW_STATE_STORAGE_KEY = "mitm-monitor-view-state";
const MUTE_BELL_ICON_SRC = "/assets/icons/bell-glow.png";

function saveViewState() {
  try {
    const payload = {
      orderedTerminalIds: state.orderedTerminalIds,
      gridTrackRatios: state.gridTrackRatios,
      layoutTree: state.layoutTree,
      hiddenTerminalIds: [...state.hiddenTerminalIds],
      mutedTerminalIds: [...state.mutedTerminalIds],
      selectedTag: state.selectedTag,
    };
    window.localStorage.setItem(VIEW_STATE_STORAGE_KEY, JSON.stringify(payload));
  } catch {
  }
  // 同时保存当前标签的布局快照
  saveTagLayout();
}

function loadViewState() {
  try {
    const raw = window.localStorage.getItem(VIEW_STATE_STORAGE_KEY);
    if (!raw) return;
    const payload = JSON.parse(raw);
    if (Array.isArray(payload.orderedTerminalIds)) {
      state.orderedTerminalIds = payload.orderedTerminalIds;
    }
    if (payload.gridTrackRatios && typeof payload.gridTrackRatios === "object") {
      state.gridTrackRatios = payload.gridTrackRatios;
    }
    if (payload.layoutTree && typeof payload.layoutTree === "object") {
      state.layoutTree = normalizeLayoutTree(payload.layoutTree);
    }
    if (Array.isArray(payload.hiddenTerminalIds)) {
      state.hiddenTerminalIds = new Set(payload.hiddenTerminalIds);
    }
    if (Array.isArray(payload.mutedTerminalIds)) {
      state.mutedTerminalIds = new Set(payload.mutedTerminalIds);
    }
    if (payload.selectedTag) {
      state.selectedTag = payload.selectedTag;
    }
  } catch {
  }
}

function getMuteButtonTitle(isMuted) {
  return isMuted ? "取消静默" : "静默（不进入队列）";
}

function renderMuteButtonContent(isMuted) {
  return `
    <span class="wall-card-mute-icon-shell${isMuted ? " is-muted" : ""}" aria-hidden="true">
      <img src="${MUTE_BELL_ICON_SRC}" alt="" class="wall-card-mute-icon" />
      ${isMuted ? '<span class="wall-card-mute-slash"></span>' : ""}
    </span>
  `;
}

function syncMuteButton(button, isMuted) {
  if (!button) {
    return;
  }
  const title = getMuteButtonTitle(isMuted);
  button.title = title;
  button.setAttribute("aria-label", title);
  button.innerHTML = renderMuteButtonContent(isMuted);
}

// ── 按标签独立保存布局 ──────────────────────────────────────────────────────

const TAG_LAYOUTS_STORAGE_KEY = "mitm-tag-layouts";

/** 获取当前标签对应的存储 key（null 标签用 __all__ 表示） */
function getTagLayoutKey() {
  return state.selectedTag || "__all__";
}

/** 保存当前标签的布局（orderedTerminalIds / gridTrackRatios / layoutTree）到 localStorage */
function saveTagLayout() {
  try {
    const stored = JSON.parse(localStorage.getItem(TAG_LAYOUTS_STORAGE_KEY) || "{}");
    stored[getTagLayoutKey()] = {
      orderedTerminalIds: state.orderedTerminalIds ? [...state.orderedTerminalIds] : [],
      gridTrackRatios: state.gridTrackRatios ? JSON.parse(JSON.stringify(state.gridTrackRatios)) : {},
      layoutTree: state.layoutTree ? JSON.parse(JSON.stringify(state.layoutTree)) : null,
    };
    localStorage.setItem(TAG_LAYOUTS_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // 存储失败时静默忽略
  }
}

/** 恢复当前标签的布局；若该标签没有保存过布局则清空以便自然排列 */
function loadTagLayout() {
  try {
    const stored = JSON.parse(localStorage.getItem(TAG_LAYOUTS_STORAGE_KEY) || "{}");
    const layout = stored[getTagLayoutKey()];
    if (layout) {
      if (layout.orderedTerminalIds) state.orderedTerminalIds = layout.orderedTerminalIds;
      state.gridTrackRatios = layout.gridTrackRatios || {};
      state.layoutTree = layout.layoutTree ? normalizeLayoutTree(layout.layoutTree) : null;
    } else {
      // 该标签没有保存过布局，清空让 syncTerminalOrder 自然排列
      state.orderedTerminalIds = [];
      state.gridTrackRatios = {};
      state.layoutTree = null;
    }
  } catch {
    // 读取失败时静默忽略
  }
}

// ────────────────────────────────────────────────────────────────────────────

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
const dashboardLayout = document.querySelector(".dashboard-layout");
const uiSettingsForm = document.getElementById("ui-settings-form");
const uiSettingsResetButton = document.getElementById("ui-settings-reset");
const uiSettingsPath = document.getElementById("ui-settings-path");
const topbarFilters = document.getElementById("topbar-filters");
const tagFilterTabs = document.getElementById("tag-filter-tabs");

const DEFAULT_UI_SETTINGS = {
  dashboard_padding_px: 4,
  monitor_stage_padding_px: 12,
  dashboard_gap_px: 6,
  monitor_grid_gap_px: 6,
  wall_card_padding_px: 10,
  wall_card_border_width_px: 1,
  wall_card_terminal_border_width_px: 1,
  split_resizer_hit_area_px: 14,
  split_resizer_line_width_px: 2,
  grid_resizer_hit_area_px: 16,
  grid_resizer_line_width_px: 2,
  filter_tab_slide_duration_ms: 420,
};

const MIN_GRID_TRACK_RATIO = 0.18;
const MIN_SPLIT_TRACK_RATIO = 0.12;
const CARD_DRAG_START_THRESHOLD_PX = 6;

function getUiSetting(key) {
  return state.uiSettings?.[key] ?? DEFAULT_UI_SETTINGS[key];
}

function getGridGapPx() {
  return getUiSetting("monitor_grid_gap_px");
}

function getGridResizerSizePx() {
  return getUiSetting("grid_resizer_hit_area_px");
}

function getSplitResizerSizePx() {
  return getUiSetting("split_resizer_hit_area_px");
}

function normalizeUiSettings(raw = {}) {
  const next = {};
  for (const [key, fallback] of Object.entries(DEFAULT_UI_SETTINGS)) {
    const incoming = Number(raw[key]);
    next[key] = Number.isFinite(incoming) ? incoming : fallback;
  }
  return next;
}

function syncUiSettingsForm() {
  if (!uiSettingsForm || !state.uiSettings) {
    return;
  }
  Object.entries(state.uiSettings).forEach(([key, value]) => {
    const field = uiSettingsForm.elements.namedItem(key);
    if (field) {
      field.value = String(value);
    }
  });
}

function applyUiSettings(raw, options = {}) {
  state.uiSettings = normalizeUiSettings(raw);
  if (options.defaults) {
    state.defaultUiSettings = normalizeUiSettings(options.defaults);
  }
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty("--dashboard-padding-px", `${getUiSetting("dashboard_padding_px")}px`);
  rootStyle.setProperty("--monitor-stage-padding-px", `${getUiSetting("monitor_stage_padding_px")}px`);
  rootStyle.setProperty("--dashboard-gap-px", `${getUiSetting("dashboard_gap_px")}px`);
  rootStyle.setProperty("--monitor-grid-gap-px", `${getUiSetting("monitor_grid_gap_px")}px`);
  rootStyle.setProperty("--wall-card-padding-px", `${getUiSetting("wall_card_padding_px")}px`);
  rootStyle.setProperty("--wall-card-border-width-px", `${getUiSetting("wall_card_border_width_px")}px`);
  rootStyle.setProperty("--wall-card-terminal-border-width-px", `${getUiSetting("wall_card_terminal_border_width_px")}px`);
  rootStyle.setProperty("--split-resizer-hit-area-px", `${getUiSetting("split_resizer_hit_area_px")}px`);
  rootStyle.setProperty("--split-resizer-line-width-px", `${getUiSetting("split_resizer_line_width_px")}px`);
  rootStyle.setProperty("--grid-resizer-hit-area-px", `${getUiSetting("grid_resizer_hit_area_px")}px`);
  rootStyle.setProperty("--grid-resizer-line-width-px", `${getUiSetting("grid_resizer_line_width_px")}px`);
  rootStyle.setProperty("--filter-tab-slide-duration-ms", `${getUiSetting("filter_tab_slide_duration_ms")}ms`);
  syncUiSettingsForm();
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

  const fillMap = {
    connected: "100%",
    reconnecting: "58%",
    disconnected: "18%",
    connecting: "36%",
  };
  const colorMap = {
    connected: "#55e36f",
    reconnecting: "#f7c948",
    disconnected: "#ff7d7d",
    connecting: "#68d2ff",
  };
  wsStatus.style.setProperty("--statusbar-fill", fillMap[status] || "0%");
  wsStatus.style.setProperty("--statusbar-fill-color", colorMap[status] || "#68d2ff");
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
    done: "空闲",
    error: "异常",
    waiting: "等待中",
    closed: "已关闭",
  }[status] || status;
}

function filterLabel(filter) {
  return {
    all: "全部",
    default: "默认",
    active: "活跃",
    attention: "待处理",
    done: "空闲",
    hidden: "已隐藏",
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
    sizes: createEqualRatios(children.length),
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function createEqualRatios(count) {
  if (count <= 0) return [];
  return Array.from({ length: count }, () => 1 / count);
}

function normalizeRatios(raw, count) {
  if (count <= 0) return [];
  if (!Array.isArray(raw) || raw.length !== count) {
    return createEqualRatios(count);
  }
  const sanitized = raw.map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0);
  if (sanitized.length !== count) {
    return createEqualRatios(count);
  }
  const sum = sanitized.reduce((acc, item) => acc + item, 0);
  if (!sum) {
    return createEqualRatios(count);
  }
  return sanitized.map((item) => item / sum);
}

function normalizeNodeSizes(raw, count) {
  return normalizeRatios(raw, count);
}

function normalizeLayoutTree(node) {
  if (!node) return null;
  if (node.type === "terminal") {
    return node;
  }
  const nextChildren = (node.children || []).map((child) => normalizeLayoutTree(child)).filter(Boolean);
  if (nextChildren.length === 0) {
    return null;
  }
  if (nextChildren.length === 1) {
    return nextChildren[0];
  }
  return {
    ...node,
    children: nextChildren,
    sizes: normalizeNodeSizes(node.sizes, nextChildren.length),
  };
}

function findNodeById(node, nodeId) {
  if (!node) return null;
  if (node.id === nodeId) return node;
  if (node.type === "terminal") return null;
  for (const child of node.children) {
    const match = findNodeById(child, nodeId);
    if (match) return match;
  }
  return null;
}

function updateNodeInTree(node, nodeId, updater) {
  if (!node) return null;
  if (node.id === nodeId) {
    return updater(node);
  }
  if (node.type === "terminal") {
    return node;
  }
  return {
    ...node,
    children: node.children.map((child) => updateNodeInTree(child, nodeId, updater)),
    sizes: normalizeNodeSizes(node.sizes, node.children.length),
  };
}

function getGridRatioKey(layout = state.layout) {
  return `${layout.columns || 1}x${layout.rows || 1}`;
}

function ensureGridTrackRatios(layout = state.layout) {
  const key = getGridRatioKey(layout);
  const current = state.gridTrackRatios[key] || {};
  const next = {};
  if ((layout.columns || 1) > 1) {
    next.columns = normalizeRatios(current.columns, layout.columns);
  }
  if ((layout.rows || 1) > 1) {
    next.rows = normalizeRatios(current.rows, layout.rows);
  }
  state.gridTrackRatios[key] = next;
  return next;
}

function applyGridTrackStyles() {
  if (!grid) return;
  const layout = state.layout;
  const ratios = ensureGridTrackRatios(layout);
  if ((layout.columns || 1) > 1 && ratios.columns?.length === layout.columns) {
    grid.style.gridTemplateColumns = ratios.columns.map((item) => `minmax(0, ${item}fr)`).join(" ");
  } else {
    grid.style.removeProperty("grid-template-columns");
  }
  if ((layout.rows || 1) > 1 && ratios.rows?.length === layout.rows) {
    grid.style.gridTemplateRows = ratios.rows.map((item) => `minmax(0, ${item}fr)`).join(" ");
  } else {
    grid.style.removeProperty("grid-template-rows");
  }
}

function getVisibleTerminalIds() {
  return getPagedTerminals().items.map((record) => record.id);
}

function mergeVisibleIds(nextVisibleIds, visibleIds) {
  const visibleSet = new Set(visibleIds);
  const nextOrderedIds = [];
  let consumed = false;
  for (const id of state.orderedTerminalIds) {
    if (!visibleSet.has(id)) {
      nextOrderedIds.push(id);
      continue;
    }
    if (!consumed) {
      nextOrderedIds.push(...nextVisibleIds);
      consumed = true;
    }
  }
  if (!consumed) {
    nextOrderedIds.push(...nextVisibleIds);
  }
  state.orderedTerminalIds = nextOrderedIds;
}

function buildInitialLayoutTree(terminals, columns = Math.max(1, state.layout.columns || 2)) {
  const items = terminals.filter((record) => record.status !== "closed");
  if (items.length === 0) return null;
  const normalizedColumns = Math.max(1, Math.min(columns, items.length));
  const rowNodes = [];
  for (let index = 0; index < items.length; index += normalizedColumns) {
    const chunk = items.slice(index, index + normalizedColumns).map((record) => createTerminalLayoutNode(record.id));
    rowNodes.push(chunk.length === 1 ? chunk[0] : createSplitLayoutNode("row", chunk));
  }
  if (rowNodes.length === 1) {
    return rowNodes[0];
  }
  return createSplitLayoutNode("column", rowNodes);
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
  const baseSizes = normalizeNodeSizes(node.sizes, node.children.length);
  const nextChildren = [];
  const nextSizes = [];
  node.children.forEach((child, index) => {
    const nextChild = removeTerminalFromTree(child, terminalId);
    if (nextChild) {
      nextChildren.push(nextChild);
      nextSizes.push(baseSizes[index]);
    }
  });
  if (nextChildren.length === 0) return null;
  if (nextChildren.length === 1) return nextChildren[0];
  return { ...node, children: nextChildren, sizes: normalizeNodeSizes(nextSizes, nextChildren.length) };
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
    const nextSizes = [...normalizeNodeSizes(node.sizes, node.children.length)];
    const targetSize = nextSizes[targetChildIndex] || (1 / Math.max(1, node.children.length));
    const insertIndex = (zone === "left" || zone === "top") ? targetChildIndex : targetChildIndex + 1;
    nextChildren.splice(insertIndex, 0, draggedNode);
    nextSizes[targetChildIndex] = targetSize / 2;
    nextSizes.splice(insertIndex, 0, targetSize / 2);
    return { ...node, children: nextChildren, sizes: normalizeNodeSizes(nextSizes, nextChildren.length) };
  }
  return {
    ...node,
    children: node.children.map((child) => insertTerminalBySplit(child, targetTerminalId, draggedNode, zone)),
    sizes: normalizeNodeSizes(node.sizes, node.children.length),
  };
}

function appendTerminalToLayoutTree(root, terminalId) {
  const node = createTerminalLayoutNode(terminalId);
  if (!root) return node;
  if (root.type === "split" && root.direction === "row") {
    const nextChildren = [...root.children, node];
    return { ...root, children: nextChildren, sizes: createEqualRatios(nextChildren.length) };
  }
  return createSplitLayoutNode("row", [root, node]);
}

function syncLayoutTree() {
  if (!state.layoutTree) {
    return;
  }
  const active = getActiveTerminalRecords();
  const activeIds = active.map((record) => record.id);
  let nextTree = state.layoutTree;
  for (const treeId of getTerminalIdsFromTree(nextTree)) {
    if (!activeIds.includes(treeId)) {
      nextTree = removeTerminalFromTree(nextTree, treeId);
    }
  }
  const nextIds = getTerminalIdsFromTree(nextTree);
  for (const record of active) {
    if (!nextIds.includes(record.id)) {
      nextTree = appendTerminalToLayoutTree(nextTree, record.id);
    }
  }
  state.layoutTree = normalizeLayoutTree(nextTree);
  mergeVisibleIds(getTerminalIdsFromTree(nextTree).filter((id) => activeIds.includes(id)), activeIds);
}

function applySplitSlotFlex(slot, ratio) {
  if (!slot) return;
  slot.style.flex = `${ratio} 1 0`;
}

function stopSplitResize() {
  if (!state.activeSplitResize) return;
  window.removeEventListener("pointermove", handleSplitResizeMove);
  window.removeEventListener("pointerup", stopSplitResize);
  window.removeEventListener("pointercancel", stopSplitResize);
  document.body.classList.remove("is-resizing-split");
  saveViewState();
  state.activeSplitResize = null;
}

function handleSplitResizeMove(event) {
  const session = state.activeSplitResize;
  if (!session) return;
  const splitResizerSizePx = getSplitResizerSizePx();
  const contentSize = session.direction === "row"
    ? session.rect.width - splitResizerSizePx * Math.max(0, session.slotCount - 1)
    : session.rect.height - splitResizerSizePx * Math.max(0, session.slotCount - 1);
  const totalBefore = session.sizes.slice(0, session.index).reduce((acc, item) => acc + item, 0);
  const pairTotal = session.sizes[session.index] + session.sizes[session.index + 1];
  const pointer = session.direction === "row"
    ? event.clientX - session.rect.left - splitResizerSizePx * session.index - splitResizerSizePx / 2
    : event.clientY - session.rect.top - splitResizerSizePx * session.index - splitResizerSizePx / 2;
  const ratioPosition = clamp(
    pointer / Math.max(contentSize, 1),
    totalBefore + MIN_SPLIT_TRACK_RATIO,
    totalBefore + pairTotal - MIN_SPLIT_TRACK_RATIO,
  );
  const nextSizes = [...session.sizes];
  nextSizes[session.index] = ratioPosition - totalBefore;
  nextSizes[session.index + 1] = pairTotal - nextSizes[session.index];
  session.sizes = nextSizes;
  applySplitSlotFlex(session.slotElements[session.index], nextSizes[session.index]);
  applySplitSlotFlex(session.slotElements[session.index + 1], nextSizes[session.index + 1]);
  state.layoutTree = updateNodeInTree(state.layoutTree, session.nodeId, (node) => ({
    ...node,
    sizes: normalizeNodeSizes(nextSizes, node.children.length),
  }));
}

function startSplitResize(event, nodeId, index, direction, container, slotElements) {
  event.preventDefault();
  event.stopPropagation();
  const node = findNodeById(state.layoutTree, nodeId);
  if (!node || node.type !== "split") {
    return;
  }
  state.activeSplitResize = {
    nodeId,
    index,
    direction,
    rect: container.getBoundingClientRect(),
    slotCount: slotElements.length,
    slotElements,
    sizes: [...normalizeNodeSizes(node.sizes, slotElements.length)],
  };
  document.body.classList.add("is-resizing-split");
  window.addEventListener("pointermove", handleSplitResizeMove);
  window.addEventListener("pointerup", stopSplitResize);
  window.addEventListener("pointercancel", stopSplitResize);
}

function reorderTerminalsByZone(sourceId, targetId, zone) {
  if (!sourceId || !targetId || sourceId === targetId) {
    return;
  }
  // 用当前可见（筛选后）的终端构建初始布局树，避免不可见终端撑多行
  const filtered = getFilteredTerminals();
  const filteredIds = filtered.map((record) => record.id);
  if (!filteredIds.includes(sourceId) || !filteredIds.includes(targetId)) {
    reorderTerminals(sourceId, targetId);
    return;
  }
  const baseTree = state.layoutTree || buildInitialLayoutTree(filtered, Math.max(1, state.layout.columns || 2));
  const draggedNode = createTerminalLayoutNode(sourceId);
  const removed = removeTerminalFromTree(baseTree, sourceId);
  state.layoutTree = insertTerminalBySplit(removed, targetId, draggedNode, zone || "right");
  const allActiveIds = getActiveTerminalRecords().map((record) => record.id);
  mergeVisibleIds(getTerminalIdsFromTree(state.layoutTree).filter((id) => allActiveIds.includes(id)), allActiveIds);
  saveViewState();
  refreshWall();
}

function updateGridResizerPositions() {
  const overlay = grid.querySelector(".grid-resizer-overlay");
  if (!overlay) return;
  const layout = state.layout;
  const gridGapPx = getGridGapPx();
  const ratios = ensureGridTrackRatios(layout);
  const rect = grid.getBoundingClientRect();
  const contentWidth = rect.width - gridGapPx * Math.max(0, (layout.columns || 1) - 1);
  const contentHeight = rect.height - gridGapPx * Math.max(0, (layout.rows || 1) - 1);

  overlay.querySelectorAll(".grid-resizer--vertical").forEach((handle, i) => {
    let total = 0;
    for (let j = 0; j <= i; j++) total += ratios.columns[j];
    handle.style.left = `${total * contentWidth + gridGapPx * i + gridGapPx / 2}px`;
  });
  overlay.querySelectorAll(".grid-resizer--horizontal").forEach((handle, i) => {
    let total = 0;
    for (let j = 0; j <= i; j++) total += ratios.rows[j];
    handle.style.top = `${total * contentHeight + gridGapPx * i + gridGapPx / 2}px`;
  });
}

function removeGridResizers() {
  grid.querySelector(".grid-resizer-overlay")?.remove();
}

function renderGridResizers() {
  removeGridResizers();
  if (!grid || state.layout.count <= 1 || state.layoutTree) return;
  const layout = state.layout;
  const gridGapPx = getGridGapPx();
  const ratios = ensureGridTrackRatios(layout);
  if ((layout.columns || 1) <= 1 && (layout.rows || 1) <= 1) return;

  const overlay = document.createElement("div");
  overlay.className = "grid-resizer-overlay";
  const rect = grid.getBoundingClientRect();
  const contentWidth = rect.width - gridGapPx * Math.max(0, (layout.columns || 1) - 1);
  const contentHeight = rect.height - gridGapPx * Math.max(0, (layout.rows || 1) - 1);

  if ((layout.columns || 1) > 1) {
    let total = 0;
    ratios.columns.forEach((ratio, index) => {
      total += ratio;
      if (index === ratios.columns.length - 1) return;
      const handle = document.createElement("button");
      handle.type = "button";
      handle.className = "grid-resizer grid-resizer--vertical";
      handle.style.left = `${total * contentWidth + gridGapPx * index + gridGapPx / 2}px`;
      handle.onpointerdown = (event) => startGridResize(event, "columns", index);
      overlay.appendChild(handle);
    });
  }

  if ((layout.rows || 1) > 1) {
    let total = 0;
    ratios.rows.forEach((ratio, index) => {
      total += ratio;
      if (index === ratios.rows.length - 1) return;
      const handle = document.createElement("button");
      handle.type = "button";
      handle.className = "grid-resizer grid-resizer--horizontal";
      handle.style.top = `${total * contentHeight + gridGapPx * index + gridGapPx / 2}px`;
      handle.onpointerdown = (event) => startGridResize(event, "rows", index);
      overlay.appendChild(handle);
    });
  }

  grid.appendChild(overlay);
}

function stopGridResize() {
  if (!state.activeGridResize) return;
  window.removeEventListener("pointermove", handleGridResizeMove);
  window.removeEventListener("pointerup", stopGridResize);
  window.removeEventListener("pointercancel", stopGridResize);
  document.body.classList.remove("is-resizing-grid");
  state.activeGridResize = null;
  saveViewState();
  renderGridResizers();
}

function handleGridResizeMove(event) {
  const session = state.activeGridResize;
  if (!session) return;
  const layout = state.layout;
  const gridGapPx = getGridGapPx();
  const key = getGridRatioKey(layout);
  if (session.key !== key) {
    stopGridResize();
    return;
  }
  const trackKey = session.axis;
  const ratios = [...ensureGridTrackRatios(layout)[trackKey]];
  const totalBefore = ratios.slice(0, session.index).reduce((acc, item) => acc + item, 0);
  const pairTotal = ratios[session.index] + ratios[session.index + 1];
  const contentSize = session.axis === "columns"
    ? session.rect.width - gridGapPx * Math.max(0, layout.columns - 1)
    : session.rect.height - gridGapPx * Math.max(0, layout.rows - 1);
  const pointer = session.axis === "columns"
    ? event.clientX - session.rect.left - gridGapPx * session.index - gridGapPx / 2
    : event.clientY - session.rect.top - gridGapPx * session.index - gridGapPx / 2;
  const ratioPosition = clamp(pointer / Math.max(contentSize, 1), totalBefore + MIN_GRID_TRACK_RATIO, totalBefore + pairTotal - MIN_GRID_TRACK_RATIO);
  const firstRatio = ratioPosition - totalBefore;
  ratios[session.index] = firstRatio;
  ratios[session.index + 1] = pairTotal - firstRatio;
  state.gridTrackRatios[key] = {
    ...ensureGridTrackRatios(layout),
    [trackKey]: normalizeRatios(ratios, ratios.length),
  };
  applyGridTrackStyles();
  updateGridResizerPositions();
}

function startGridResize(event, axis, index) {
  event.preventDefault();
  event.stopPropagation();
  state.activeGridResize = {
    axis,
    index,
    key: getGridRatioKey(state.layout),
    rect: grid.getBoundingClientRect(),
  };
  document.body.classList.add("is-resizing-grid");
  window.addEventListener("pointermove", handleGridResizeMove);
  window.addEventListener("pointerup", stopGridResize);
  window.addEventListener("pointercancel", stopGridResize);
}

function getActiveTerminalRecords() {
  return state.orderedTerminalIds
    .map((id) => state.terminals.get(id))
    .filter((record) => record && record.status !== "closed");
}

function getDropZoneAtPoint(clientX, clientY, element) {
  const rect = element.getBoundingClientRect();
  const localX = clientX - rect.left;
  const localY = clientY - rect.top;
  const width = rect.width;
  const height = rect.height;
  const centerX = width / 2;
  const centerY = height / 2;

  const horizontalBand = Math.max(48, Math.min(180, width * 0.34));
  const verticalBand = Math.max(48, Math.min(180, height * 0.34));
  const outerHorizontalMargin = Math.max(40, Math.min(180, width * 0.22));
  const outerVerticalMargin = Math.max(40, Math.min(180, height * 0.22));

  const withinExpandedX = clientX >= rect.left - outerHorizontalMargin && clientX <= rect.right + outerHorizontalMargin;
  const withinExpandedY = clientY >= rect.top - outerVerticalMargin && clientY <= rect.bottom + outerVerticalMargin;
  if (!withinExpandedX || !withinExpandedY) {
    return null;
  }

  if (localY < 0 && clientX >= rect.left - horizontalBand && clientX <= rect.right + horizontalBand) {
    return { zone: 'top', score: Math.abs(localY) };
  }
  if (localY > height && clientX >= rect.left - horizontalBand && clientX <= rect.right + horizontalBand) {
    return { zone: 'bottom', score: Math.abs(localY - height) };
  }
  if (localX < 0 && clientY >= rect.top - verticalBand && clientY <= rect.bottom + verticalBand) {
    return { zone: 'left', score: Math.abs(localX) };
  }
  if (localX > width && clientY >= rect.top - verticalBand && clientY <= rect.bottom + verticalBand) {
    return { zone: 'right', score: Math.abs(localX - width) };
  }

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
    const offsetX = (localX - centerX) / Math.max(centerX, 1);
    const offsetY = (localY - centerY) / Math.max(centerY, 1);
    const absOffsetX = Math.abs(offsetX);
    const absOffsetY = Math.abs(offsetY);
    const centerDeadZone = 0.18;
    const axisBias = 1.12;

    if (absOffsetX < centerDeadZone && absOffsetY < centerDeadZone) {
      return null;
    }

    if (absOffsetX >= absOffsetY * axisBias) {
      return {
        zone: offsetX < 0 ? 'left' : 'right',
        score: 100 + (1 - absOffsetX),
      };
    }

    if (absOffsetY >= absOffsetX * axisBias) {
      return {
        zone: offsetY < 0 ? 'top' : 'bottom',
        score: 100 + (1 - absOffsetY),
      };
    }

    return {
      zone: absOffsetX >= absOffsetY
        ? (offsetX < 0 ? 'left' : 'right')
        : (offsetY < 0 ? 'top' : 'bottom'),
      score: 120,
    };
  }

  candidates.sort((a, b) => a.value - b.value);
  return { zone: candidates[0].zone, score: candidates[0].value };
}

function getDropTargetAtPoint(clientX, clientY) {
  if (!state.draggedTerminalId) {
    return null;
  }
  let bestTarget = null;
  document.querySelectorAll('.wall-card').forEach((card) => {
    const terminalId = card.id.replace(/^card-/, '');
    if (!terminalId || terminalId === state.draggedTerminalId) {
      return;
    }
    const hit = getDropZoneAtPoint(clientX, clientY, card);
    if (!hit) {
      return;
    }
    if (!bestTarget || hit.score < bestTarget.score) {
      bestTarget = {
        card,
        terminalId,
        zone: hit.zone,
        score: hit.score,
      };
    }
  });
  return bestTarget;
}

function stopCardPointerDrag() {
  const session = state.activeCardDrag;
  if (!session) {
    return;
  }
  if (_cardDragRafId) {
    cancelAnimationFrame(_cardDragRafId);
    _cardDragRafId = 0;
  }
  window.removeEventListener('pointermove', handleCardPointerMove);
  window.removeEventListener('pointerup', handleCardPointerUp);
  window.removeEventListener('pointercancel', handleCardPointerUp);
  try {
    session.handle.releasePointerCapture?.(session.pointerId);
  } catch {
  }
  session.card.classList.remove('is-dragging');
  document.body.classList.remove('is-dragging-card');
  state.activeCardDrag = null;
  state.draggedTerminalId = null;
  clearSplitDropPreview();
}

function commitCardPointerDrag(clientX, clientY) {
  const target = getDropTargetAtPoint(clientX, clientY);
  if (!target || !state.draggedTerminalId) {
    return;
  }
  reorderTerminalsByZone(state.draggedTerminalId, target.terminalId, target.zone || 'right');
}

let _cardDragRafId = 0;

function handleCardPointerMove(event) {
  const session = state.activeCardDrag;
  if (!session || event.pointerId !== session.pointerId) {
    return;
  }
  const moveX = event.clientX - session.startX;
  const moveY = event.clientY - session.startY;
  const movedEnough = Math.hypot(moveX, moveY) >= CARD_DRAG_START_THRESHOLD_PX;
  if (!session.started && !movedEnough) {
    return;
  }
  if (!session.started) {
    session.started = true;
    state.draggedTerminalId = session.terminalId;
    session.card.classList.add('is-dragging');
    document.body.classList.add('is-dragging-card');
  }
  event.preventDefault();
  const cx = event.clientX;
  const cy = event.clientY;
  if (_cardDragRafId) return;
  _cardDragRafId = requestAnimationFrame(() => {
    _cardDragRafId = 0;
    const target = getDropTargetAtPoint(cx, cy);
    if (target) {
      applySplitDropPreview(target.card, target.terminalId, target.zone);
    } else {
      clearSplitDropPreview();
    }
  });
}

function handleCardPointerUp(event) {
  const session = state.activeCardDrag;
  if (!session || event.pointerId !== session.pointerId) {
    return;
  }
  const shouldCommit = session.started;
  if (shouldCommit) {
    event.preventDefault();
    commitCardPointerDrag(event.clientX, event.clientY);
  }
  stopCardPointerDrag();
}

function beginCardPointerDrag(card, record, event) {
  if (event.button !== 0 || shouldIgnoreDragStart(event.target) || record.status === 'closed' || state.activeGridResize || state.activeSplitResize) {
    return;
  }
  const handle = event.currentTarget;
  state.activeCardDrag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    started: false,
    terminalId: record.id,
    card,
    handle,
  };
  handle.setPointerCapture?.(event.pointerId);
  window.addEventListener('pointermove', handleCardPointerMove);
  window.addEventListener('pointerup', handleCardPointerUp);
  window.addEventListener('pointercancel', handleCardPointerUp);
}

function clearSplitDropPreview() {
  const prevId = state.hoverTargetPaneId;
  state.hoverTargetPaneId = null;
  state.hoverDropZone = null;
  const previewClasses = ['split-preview-left', 'split-preview-right', 'split-preview-top', 'split-preview-bottom'];
  // 尝试精确定位上一个 preview card
  if (prevId) {
    const prevCard = document.querySelector(`.wall-card[data-terminal-id="${prevId}"]`);
    if (prevCard) {
      prevCard.classList.remove(...previewClasses);
      return;
    }
  }
  // fallback: 全局遍历
  document.querySelectorAll('.wall-card').forEach((card) => {
    card.classList.remove(...previewClasses);
  });
}

function applySplitDropPreview(card, terminalId, zone) {
  clearSplitDropPreview();
  if (!card || !zone) return;
  state.hoverTargetPaneId = terminalId;
  state.hoverDropZone = zone;
  card.classList.add(`split-preview-${zone}`);
}

// 等待状态音效通知 - 当终端需要人类参与时发出提示音（单例 AudioContext 避免资源泄漏）
let _audioCtx = null;
function playWaitingAlert() {
  try {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = _audioCtx.createOscillator();
    const gain = _audioCtx.createGain();
    osc.connect(gain);
    gain.connect(_audioCtx.destination);
    osc.frequency.value = 880;
    osc.type = "sine";
    gain.gain.value = 0.3;
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.01, _audioCtx.currentTime + 0.3);
    osc.stop(_audioCtx.currentTime + 0.3);
  } catch (e) {
    // 静默失败，不影响正常功能
  }
}

function escapeHtml(text) {
  return (text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** 生成卡片显示标题：终端名 · 文件夹名 */
function displayTitle(record) {
  const name = record.name || "";
  if (!record.cwd) return name;
  const parts = record.cwd.replace(/\/+$/, "").split("/");
  const folder = parts[parts.length - 1] || "";
  if (!folder) return name;
  return `${name} · ${folder}`;
}

// screenHtml 大小上限（100KB），超过时截断，防止极端情况内存暴涨
const SCREEN_HTML_MAX_SIZE = 100 * 1024;

function updateTerminalSnapshot(record, mount) {
  if (!mount) {
    return;
  }
  const text = record.screenText && record.screenText.trim() ? record.screenText : "暂无输出";
  let newHtml = record.screenHtml || `<pre class="terminal-mirror">${escapeHtml(text)}</pre>`;
  // 超过 100KB 时截断 screenHtml，防止内存暴涨
  if (newHtml.length > SCREEN_HTML_MAX_SIZE) {
    newHtml = newHtml.slice(0, SCREEN_HTML_MAX_SIZE) + '<pre class="terminal-mirror" style="color:#f59e0b">⚠ 输出过大，已截断显示</pre>';
    // 同时截断 record 上缓存的原始数据，释放内存
    if (record.screenHtml) {
      record.screenHtml = newHtml;
    }
  }
  mount.innerHTML = newHtml;
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
  if (count <= 0) return { count: 0, columns: 1, rows: 1, fitMode: false };
  // 默认两列布局
  const columns = Math.max(1, Math.min(2, count));
  const fitMode = Boolean(state.nextFitMode && count === 4 && columns === 2);
  return { count, columns, rows: Math.max(1, Math.ceil(count / columns)), fitMode };
}

function applyLayout(_layoutFromServer = null) {
  const filtered = getFilteredTerminals();
  const layout = inferLayout(filtered);
  state.layout = layout;
  const cols = layout.columns || 1;
  grid.dataset.columns = String(cols);
  grid.dataset.rows = String(layout.rows || 1);
  grid.dataset.fitMode = layout.fitMode ? "true" : "false";
  // split 引擎只在默认过滤器下生效；其他过滤器用简单卡片循环渲染，必须保持 grid 布局
  const useSplitEngine = Boolean(state.layoutTree) && state.filter === "default";
  grid.dataset.engine = useSplitEngine ? "split" : "grid";
  if (useSplitEngine) {
    grid.style.removeProperty("grid-template-columns");
    grid.style.removeProperty("grid-template-rows");
  } else {
    applyGridTrackStyles();
  }
  state.nextFitMode = false;
}

function getFilteredTerminals() {
  const all = state.orderedTerminalIds
    .map((id) => state.terminals.get(id))
    .filter(Boolean);
  // 标签预过滤
  let pool = all;
  if (state.selectedTag === "__untagged__") {
    pool = pool.filter(r => !Array.isArray(r.tags) || r.tags.length === 0);
  } else if (state.selectedTag) {
    pool = pool.filter(r => Array.isArray(r.tags) && r.tags.includes(state.selectedTag));
  }
  if (state.filter === "all") return pool.filter((record) => record.status !== "closed");
  if (state.filter === "hidden") return pool.filter((record) => state.hiddenTerminalIds.has(record.id));
  if (state.filter === "done") return pool.filter((record) => record.status === "done" && !state.hiddenTerminalIds.has(record.id));
  if (state.filter === "running") return pool.filter((record) => record.status === "running" && !state.hiddenTerminalIds.has(record.id));
  if (state.filter === "attention") {
    // 进入"待处理"时会生成快照，快照期间不随状态变化自动删除终端
    if (state.attentionSnapshot) {
      return pool.filter((record) => state.attentionSnapshot.has(record.id));
    }
    return pool.filter((record) => ["error", "waiting"].includes(record.status) && !state.hiddenTerminalIds.has(record.id));
  }
  // default：不显示已隐藏和已关闭的终端
  return pool.filter((record) => record.status !== "closed" && !state.hiddenTerminalIds.has(record.id));
}

function shouldPaginateCurrentFilter() {
  return state.filter === "all" || state.filter === "hidden" || state.filter === "done" || state.filter === "running";
}

function syncFilterTabs() {
  // 更新 tab 激活状态
  document.querySelectorAll("#topbar-filters .filter-tab").forEach((tab) => {
    tab.classList.toggle("is-active", tab.dataset.filter === state.filter);
  });
  syncFilterTabSlider();
  // 单次遍历计算所有 badge 数量（先应用标签筛选）
  let attentionCount = 0;
  let hiddenCount = 0;
  let doneCount = 0;
  let runningCount = 0;
  for (const id of state.orderedTerminalIds) {
    const r = state.terminals.get(id);
    if (!r) continue;
    // 标签预过滤：选中标签时只统计匹配的终端
    if (state.selectedTag === "__untagged__" && Array.isArray(r.tags) && r.tags.length > 0) continue;
    if (state.selectedTag && state.selectedTag !== "__untagged__" && !(Array.isArray(r.tags) && r.tags.includes(state.selectedTag))) continue;
    const isHidden = state.hiddenTerminalIds.has(r.id);
    if (isHidden) { hiddenCount++; continue; }
    if (r.status === "error" || r.status === "waiting") attentionCount++;
    else if (r.status === "done") doneCount++;
    else if (r.status === "running") runningCount++;
  }
  const attentionBadge = document.getElementById("filter-attention-badge");
  if (attentionBadge) {
    const newText = attentionCount > 0 ? String(attentionCount) : "";
    if (attentionBadge.textContent !== newText) {
      attentionBadge.textContent = newText;
    }
    attentionBadge.hidden = attentionCount === 0;
  }
  const hiddenBadge = document.getElementById("filter-hidden-badge");
  if (hiddenBadge) {
    const newText = hiddenCount > 0 ? String(hiddenCount) : "";
    if (hiddenBadge.textContent !== newText) {
      hiddenBadge.textContent = newText;
    }
    hiddenBadge.hidden = hiddenCount === 0;
  }
  const doneBadge = document.getElementById("filter-done-badge");
  if (doneBadge) {
    const newText = doneCount > 0 ? String(doneCount) : "";
    if (doneBadge.textContent !== newText) {
      doneBadge.textContent = newText;
    }
    doneBadge.hidden = doneCount === 0;
  }
  const runningBadge = document.getElementById("filter-running-badge");
  if (runningBadge) {
    const newText = runningCount > 0 ? String(runningCount) : "";
    if (runningBadge.textContent !== newText) {
      runningBadge.textContent = newText;
    }
    runningBadge.hidden = runningCount === 0;
  }
}

function ensureFilterTabSlider() {
  if (!topbarFilters) {
    return null;
  }
  let slider = topbarFilters.querySelector(".filter-tab-slider");
  if (!slider) {
    slider = document.createElement("span");
    slider.className = "filter-tab-slider";
    topbarFilters.prepend(slider);
  }
  return slider;
}

function syncFilterTabSlider() {
  const slider = ensureFilterTabSlider();
  if (!slider) {
    return;
  }
  const activeTab = topbarFilters?.querySelector(".filter-tab.is-active");
  if (!activeTab) {
    slider.classList.remove("is-visible");
    return;
  }
  slider.classList.add("is-visible");
  const newWidth = `${activeTab.offsetWidth}px`;
  const newTransform = `translateX(${activeTab.offsetLeft}px)`;
  // 只在值真正变化时才更新样式，避免中断正在进行的 CSS transition
  if (slider.style.width !== newWidth) {
    slider.style.width = newWidth;
  }
  if (slider.style.transform !== newTransform) {
    slider.style.transform = newTransform;
  }
}

// 上次同步的标签快照，用于跳过无变化的重建（避免下拉框展开时被 DOM 重建关闭）
let _lastSyncedTagsKey = "";

// 同步标签筛选 Tab 按钮组
function syncTagFilterSelect() {
  if (!tagFilterTabs) return;
  // 只有标签列表真正变化时才重建 DOM
  const tagsKey = state.allTags.join(",");
  if (tagsKey !== _lastSyncedTagsKey) {
    _lastSyncedTagsKey = tagsKey;
    tagFilterTabs.innerHTML = "";
    // "全部标签" 按钮
    const allBtn = document.createElement("button");
    allBtn.className = "tag-tab";
    allBtn.dataset.tag = "";
    allBtn.textContent = "全部标签";
    tagFilterTabs.appendChild(allBtn);
    // "无标签" 按钮
    const untaggedBtn = document.createElement("button");
    untaggedBtn.className = "tag-tab";
    untaggedBtn.dataset.tag = "__untagged__";
    untaggedBtn.textContent = "无标签";
    tagFilterTabs.appendChild(untaggedBtn);
    // 各标签按钮
    for (const tag of state.allTags) {
      const btn = document.createElement("button");
      btn.className = "tag-tab";
      btn.dataset.tag = tag;
      btn.textContent = tag;
      tagFilterTabs.appendChild(btn);
    }
    // 绑定点击事件（事件委托）
    tagFilterTabs.onclick = (e) => {
      const btn = e.target.closest(".tag-tab");
      if (!btn) return;
      const tagValue = btn.dataset.tag;
      // 先保存当前标签的布局快照
      saveTagLayout();
      // 切换到新标签
      state.selectedTag = tagValue || null;
      state.page = 1;
      // 立即更新标签按钮激活状态
      const activeTag = state.selectedTag || "";
      tagFilterTabs.querySelectorAll(".tag-tab").forEach((b) => {
        b.classList.toggle("is-active", b.dataset.tag === activeTag);
      });
      // 恢复新标签的布局（没有保存过则清空）
      loadTagLayout();
      // loadTagLayout 可能清空 orderedTerminalIds，需从 state.terminals 重建
      syncTerminalOrder([...state.terminals.values()]);
      saveViewState();
      refreshWall();
    };
  }
  // 更新激活状态
  const activeTag = state.selectedTag || "";
  tagFilterTabs.querySelectorAll(".tag-tab").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.tag === activeTag);
  });
  // 如果选中的标签已不存在，回退到全部
  if (state.selectedTag && state.selectedTag !== "__untagged__" && !state.allTags.includes(state.selectedTag)) {
    state.selectedTag = null;
    tagFilterTabs.querySelectorAll(".tag-tab").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.tag === "");
    });
  }
}

function getPagedTerminals() {
  const filtered = getFilteredTerminals();
  if (!shouldPaginateCurrentFilter()) {
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
  if (target.closest('.wall-card-drag-handle')) {
    return false;
  }
  return Boolean(target.closest('.wall-card-terminal, button, input, textarea, details, summary, .wall-card-input, .wall-card-details-panel, .wall-card-details, .wall-card-title-input'));
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

function renderLayoutNode(node, visibleSet = null) {
  if (!node) {
    return null;
  }
  if (node.type === "terminal") {
    if (visibleSet && !visibleSet.has(node.terminalId)) {
      return null;
    }
    const record = state.terminals.get(node.terminalId);
    if (!record || record.status === "closed") {
      return null;
    }
    const pane = document.createElement("div");
    pane.className = "split-pane";
    pane.dataset.terminalId = node.terminalId;
    pane.appendChild(renderTerminal(record));
    return pane;
  }
  const childElements = node.children
    .map((child) => renderLayoutNode(child, visibleSet))
    .filter(Boolean);
  if (childElements.length === 0) {
    return null;
  }
  if (childElements.length === 1) {
    return childElements[0];
  }
  const wrap = document.createElement("div");
  wrap.className = `split-node split-node--${node.direction}`;
  wrap.dataset.nodeId = node.id;
  const slotElements = [];
  const sizes = normalizeNodeSizes(node.sizes, childElements.length);
  childElements.forEach((childElement, index) => {
    const slot = document.createElement("div");
    slot.className = `split-slot split-slot--${node.direction}`;
    applySplitSlotFlex(slot, sizes[index]);
    slot.appendChild(childElement);
    wrap.appendChild(slot);
    slotElements.push(slot);
    if (index < childElements.length - 1) {
      const resizer = document.createElement("button");
      resizer.type = "button";
      resizer.className = `split-resizer split-resizer--${node.direction}`;
      resizer.onpointerdown = (event) => startSplitResize(event, node.id, index, node.direction, wrap, slotElements);
      wrap.appendChild(resizer);
    }
  });
  if (node.direction === "column") {
    for (const slot of slotElements) {
      slot.style.width = "100%";
    }
  } else {
    for (const slot of slotElements) {
      slot.style.height = "100%";
    }
  }
  return wrap;
}

function renderStats() {
  const counts = { running: 0, done: 0, waiting: 0, error: 0, closed: 0, idle: 0 };
  for (const record of state.terminals.values()) {
    if (state.hiddenTerminalIds.has(record.id)) continue;
    counts[record.status] = (counts[record.status] || 0) + 1;
  }
  const page = getPagedTerminals();
  if (!stats) return;
  stats.innerHTML = [
    `<span class="stat-chip status-running">活跃 ${state.layout.count}</span>`,
    `<span class="stat-chip status-running">布局 ${state.layout.columns} × ${state.layout.rows}</span>`,
    `<span class="stat-chip status-running">筛选 ${filterLabel(state.filter)}</span>`,
    `<span class="stat-chip status-running">页码 ${state.page}/${page.totalPages}</span>`,
    `<span class="stat-chip status-running">运行中 ${counts.running}</span>`,
    `<span class="stat-chip status-done">空闲 ${counts.done}</span>`,
    `<span class="stat-chip status-waiting">等待中 ${counts.waiting}</span>`,
    `<span class="stat-chip status-error">异常 ${counts.error}</span>`,
  ].join("");
}

async function focusTerminal(id, name) {
  await request(`/api/terminals/${id}/focus`, {
    method: "POST",
    body: JSON.stringify({
      browser_x: window.screenX,
      browser_y: window.screenY
    })
  });
  // 点击队列项聚焦时，自动从队列移除
  state.queue = state.queue.filter((q) => q.id !== id);
  _lastQueueKey = "__force__";
  renderQueue();
  setMessage(`已切到 ${name}，已从队列移除`);
}

/* ---- 顶部队列 ---- */
const ATTENTION_STATUSES = new Set(["waiting", "error"]);

function updateQueue(terminalId, oldStatus, newStatus) {
  // 隐藏的终端不入队
  if (state.hiddenTerminalIds.has(terminalId)) {
    state.queue = state.queue.filter((q) => q.id !== terminalId);
    return;
  }

  // 静默的终端不入队
  if (state.mutedTerminalIds.has(terminalId)) {
    state.queue = state.queue.filter((q) => q.id !== terminalId);
    return;
  }

  // 用户手动移除过的终端：状态真正变化后才解除屏蔽
  const dismissedStatus = state.queueDismissed.get(terminalId);
  if (dismissedStatus !== undefined) {
    if (newStatus !== dismissedStatus) {
      state.queueDismissed.delete(terminalId); // 状态变了，解除屏蔽
    } else {
      return; // 状态没变，继续屏蔽
    }
  }

  const terminal = state.terminals.get(terminalId);
  if (!terminal) return;
  const name = terminal.name || terminalId;
  const inQueue = state.queue.findIndex((q) => q.id === terminalId);

  // running → done：追加到队列末尾
  if (oldStatus === "running" && newStatus === "done") {
    if (inQueue === -1) {
      state.queue.push({ id: terminalId, name, status: newStatus });
    } else {
      state.queue[inQueue].status = newStatus;
    }
    return;
  }

  // done → running：从队列移除
  if (oldStatus === "done" && newStatus === "running") {
    if (inQueue !== -1) state.queue.splice(inQueue, 1);
    return;
  }

  // 任意 → waiting/error：插到队列最前面
  if (ATTENTION_STATUSES.has(newStatus)) {
    if (inQueue !== -1) state.queue.splice(inQueue, 1);
    state.queue.unshift({ id: terminalId, name, status: newStatus });
    return;
  }

  // waiting/error → 其他非 attention 状态：从队列移除
  if (ATTENTION_STATUSES.has(oldStatus) && !ATTENTION_STATUSES.has(newStatus)) {
    if (inQueue !== -1) state.queue.splice(inQueue, 1);
    return;
  }

  // closed：移除
  if (newStatus === "closed") {
    if (inQueue !== -1) state.queue.splice(inQueue, 1);
    return;
  }
}

// 缓存上次队列快照，避免无变化时重建 DOM 导致 hover 闪烁
let _lastQueueKey = "";

function renderQueue() {
  const container = document.getElementById("topbar-queue");
  if (!container) return;
  // 生成当前队列的指纹，无变化则跳过
  const key = state.queue.map(q => `${q.id}:${q.name}:${q.status}`).join("|");
  if (key === _lastQueueKey) return;
  _lastQueueKey = key;
  container.innerHTML = "";
  for (const item of state.queue) {
    const pill = document.createElement("span");
    const isAttention = ATTENTION_STATUSES.has(item.status);
    pill.className = "queue-pill" + (isAttention ? " queue-pill--attention" : item.status === "done" ? " queue-pill--done" : "");
    pill.textContent = item.name;
    pill.title = `${item.name} — ${item.status}（右键移除）`;
    pill.onclick = () => focusTerminal(item.id, item.name);
    pill.oncontextmenu = (e) => {
      e.preventDefault();
      state.queueDismissed.set(item.id, item.status); // 记录移除时的状态
      state.queue = state.queue.filter((q) => q.id !== item.id);
      _lastQueueKey = "__force__";
      renderQueue();
      setMessage(`已将 ${item.name} 移出队列`);
    };
    container.appendChild(pill);
  }
}

function initQueueFromSnapshot() {
  state.queue = [];
  const attentionItems = [];
  const doneItems = [];
  for (const [id, terminal] of state.terminals) {
    if (state.hiddenTerminalIds.has(id)) continue;
    if (state.mutedTerminalIds.has(id)) continue;
    const name = terminal.name || id;
    if (ATTENTION_STATUSES.has(terminal.status)) {
      attentionItems.push({ id, name, status: terminal.status });
    } else if (terminal.status === "done") {
      doneItems.push({ id, name, status: terminal.status });
    }
    // running/idle 不入队
  }
  state.queue = [...attentionItems, ...doneItems];
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
  card.draggable = false;
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
    if (state.editingTitleTerminalId !== record.id) return;
    const nextName = titleInput.value.trim();
    titleInput.hidden = true;
    title.hidden = false;
    if (!commit || !nextName || nextName === record.name) {
      state.editingTitleTerminalId = null;
      refreshWall();
      return;
    }
    try {
      await renameTerminal(record.id, nextName);
      state.editingTitleTerminalId = null;
      // 同步更新本地 state 中的名称
      const terminal = state.terminals.get(record.id);
      if (terminal) {
        terminal.name = nextName;
      }
      // 同步更新队列中的名称
      const qItem = state.queue.find((q) => q.id === record.id);
      if (qItem) {
        qItem.name = nextName;
        _lastQueueKey = "__force__";
        renderQueue();
      }
      // 刷新 UI 以退出编辑状态
      refreshWall();
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
  const dragHandle = card.querySelector(".wall-card-drag-handle");
  const detailsToggle = card.querySelector(".wall-card-more-button");
  const title = card.querySelector(".wall-card-title");
  const titleInput = card.querySelector(".wall-card-title-input");
  const detailsPanel = card.querySelector(".wall-card-details-panel");

  if (detailsPanel) {
    detailsPanel.onclick = (event) => event.stopPropagation();
  }
  if (title) {
    title.ondblclick = (event) => {
      event.stopPropagation();
      event.preventDefault(); // 阻止浏览器默认双击选中文字，避免焦点被意外转移
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
  if (dragHandle) {
    dragHandle.onclick = (event) => {
      event.stopPropagation();
      event.preventDefault();
    };
    dragHandle.onpointerdown = (event) => {
      event.stopPropagation();
      beginCardPointerDrag(card, record, event);
    };
  }
  if (detailsToggle) {
    detailsToggle.onclick = (event) => {
      event.stopPropagation();
      event.preventDefault();
      if (!detailsPanel) return;
      const expanded = !detailsPanel.hidden;
      detailsPanel.hidden = expanded;
      detailsToggle.classList.toggle('is-active', !expanded);
      card.classList.toggle("has-open-details", !expanded);
    };
  }

  terminalArea.onclick = async (event) => {
    // 点击终端区域时主动关闭所有已展开的顶部菜单（因 stopPropagation 会阻止冒泡）
    document.querySelectorAll(".topbar-menu[open]").forEach((d) => d.removeAttribute("open"));
    event.stopPropagation();
    if (state.activeCardDrag || state.draggedTerminalId) return;
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

  card.querySelector("[data-action='monitor-mode']").onclick = async (event) => {
    event.stopPropagation();
    try {
      await request("/api/workspace/monitor-mode", { method: "POST" });
      setMessage("真实 iTerm 已退到后台，回到监控模式");
    } catch (error) {
      setMessage(error.message, true);
    }
  };

  const setDefaultFrameBtn = card.querySelector("[data-action='set-default-frame']");
  if (setDefaultFrameBtn) {
    setDefaultFrameBtn.onclick = async (event) => {
      event.stopPropagation();
      try {
        // 先获取终端的实时位置
        const frameData = await request(`/api/terminals/${record.id}/frame`);
        await request("/api/default-frame", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(frameData),
        });
        setMessage(`已将 ${record.name} 的位置设为默认模板`);
      } catch (error) {
        setMessage(error.message, true);
      }
    };
  }

  const applyDefaultFrameAllBtn = card.querySelector("[data-action='apply-default-frame-all']");
  if (applyDefaultFrameAllBtn) {
    applyDefaultFrameAllBtn.onclick = async (event) => {
      event.stopPropagation();
      try {
        const result = await request("/api/default-frame/apply-all", { method: "POST" });
        setMessage(`已将 ${result.applied} 个终端对齐到默认位置`);
      } catch (error) {
        setMessage(error.message, true);
      }
    };
  }

  const toggleHideBtn = card.querySelector("[data-action='toggle-hide']");
  if (toggleHideBtn) {
    toggleHideBtn.onclick = async (event) => {
      event.stopPropagation();
      const nowHidden = !state.hiddenTerminalIds.has(record.id);
      if (nowHidden) {
        state.hiddenTerminalIds.add(record.id);
        setMessage(`已隐藏 ${record.name}，可在"已隐藏"筛选中找到`);
        // 隐藏时从队列移除
        state.queue = state.queue.filter((q) => q.id !== record.id);
      } else {
        state.hiddenTerminalIds.delete(record.id);
        setMessage(`已取消隐藏 ${record.name}`);
        // 取消隐藏时，检查状态决定是否入队（先去重）
        const terminal = state.terminals.get(record.id);
        if (terminal && !state.queue.some((q) => q.id === record.id)) {
          if (ATTENTION_STATUSES.has(terminal.status)) {
            state.queue.unshift({ id: record.id, name: terminal.name || record.id, status: terminal.status });
          } else if (terminal.status === "done") {
            state.queue.push({ id: record.id, name: terminal.name || record.id, status: terminal.status });
          }
        }
      }
      saveViewState();
      refreshWall();
      // 同步隐藏状态到后端（写入 iTerm2 变量，重启后可恢复）
      try {
        await request(`/api/terminals/${record.id}/hidden`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hidden: nowHidden }),
        });
      } catch (e) {
        console.warn("同步隐藏状态到后端失败:", e);
      }
    };
  }

  const toggleMuteBtn = card.querySelector("[data-action='toggle-mute']");
  if (toggleMuteBtn) {
    toggleMuteBtn.onclick = (event) => {
      event.stopPropagation();
      const nowMuted = !state.mutedTerminalIds.has(record.id);
      if (nowMuted) {
        state.mutedTerminalIds.add(record.id);
        // 静默时从队列移除
        state.queue = state.queue.filter((q) => q.id !== record.id);
        setMessage(`已静默 ${record.name}，状态变更不再进入队列`);
      } else {
        state.mutedTerminalIds.delete(record.id);
        setMessage(`已取消静默 ${record.name}`);
      }
      // 更新按钮显示
      syncMuteButton(toggleMuteBtn, nowMuted);
      saveViewState();
      renderQueue();
      // 同步到后端持久化
      fetch(`/api/terminals/${record.id}/muted`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ muted: nowMuted }),
      }).catch(() => {});
    };
  }

  const detachBtn = card.querySelector("[data-action='detach']");
  if (detachBtn) {
    detachBtn.onclick = async (event) => {
      event.stopPropagation();
      try {
        await request(`/api/terminals/${record.id}/detach`, { method: "POST" });
        setMessage("终端已解绑");
      } catch (error) {
        setMessage(error.message, true);
      }
    };
  }

  // 标签添加/移除事件绑定
  const tagAddBtn = card.querySelector(".wall-card-tag-add");
  const tagInput = card.querySelector(".wall-card-tag-input");
  const addTagFromInput = async () => {
    if (!tagInput || !tagInput.value.trim()) return;
    const newTag = tagInput.value.trim();
    const currentTags = Array.isArray(record.tags) ? [...record.tags] : [];
    if (currentTags.includes(newTag)) {
      tagInput.value = "";
      return;
    }
    currentTags.push(newTag);
    try {
      const res = await request(`/api/terminals/${record.id}/tags`, {
        method: "POST",
        body: JSON.stringify({ tags: currentTags }),
      });
      tagInput.value = "";
      // 同步后端返回的 allTags
      if (res.allTags) {
        state.allTags = res.allTags;
        syncTagFilterSelect();
      }
      if (res.item) {
        state.terminals.set(res.item.id, res.item);
      }
      refreshWall();
    } catch (error) {
      setMessage(error.message, true);
    }
  };
  if (tagAddBtn) {
    tagAddBtn.onclick = (event) => {
      event.stopPropagation();
      addTagFromInput();
    };
  }
  if (tagInput) {
    tagInput.onclick = (event) => event.stopPropagation();
    tagInput.onkeydown = (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        addTagFromInput();
      }
    };
  }
  // 候选标签快速添加
  card.querySelectorAll(".wall-card-tag-candidate").forEach((btn) => {
    btn.onclick = async (event) => {
      event.stopPropagation();
      const tagToAdd = btn.dataset.tag;
      const currentTags = Array.isArray(record.tags) ? [...record.tags] : [];
      if (currentTags.includes(tagToAdd)) return;
      currentTags.push(tagToAdd);
      try {
        const res = await request(`/api/terminals/${record.id}/tags`, {
          method: "POST",
          body: JSON.stringify({ tags: currentTags }),
        });
        if (res.allTags) {
          state.allTags = res.allTags;
          syncTagFilterSelect();
        }
        if (res.item) {
          state.terminals.set(res.item.id, res.item);
        }
        refreshWall();
      } catch (error) {
        setMessage(error.message, true);
      }
    };
  });
  // 标签移除按钮
  card.querySelectorAll(".wall-card-tag-remove").forEach((btn) => {
    btn.onclick = async (event) => {
      event.stopPropagation();
      const tagToRemove = btn.dataset.tag;
      const currentTags = Array.isArray(record.tags) ? record.tags.filter(t => t !== tagToRemove) : [];
      try {
        const res = await request(`/api/terminals/${record.id}/tags`, {
          method: "POST",
          body: JSON.stringify({ tags: currentTags }),
        });
        if (res.allTags) {
          state.allTags = res.allTags;
          syncTagFilterSelect();
        }
        if (res.item) {
          state.terminals.set(res.item.id, res.item);
        }
        refreshWall();
      } catch (error) {
        setMessage(error.message, true);
      }
    };
  });

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

function renderTerminal(record) {
  let card = document.getElementById(`card-${record.id}`);
  if (!card) {
    card = document.createElement("section");
    card.id = `card-${record.id}`;
    card.className = "wall-card";
  }

  // 正在编辑此卡片标题时，跳过全卡 innerHTML 替换
  // 否则 DOM 重建会销毁聚焦中的 input，触发 blur → finishRename，打断用户输入
  if (state.editingTitleTerminalId === record.id) {
    updateTerminalSnapshot(record, card.querySelector(".wall-card-terminal"));
    return card;
  }

  // 面板展开时跳过全卡 innerHTML 替换，避免面板被重建关闭
  const detailsOpen = card.querySelector(".wall-card-details-panel:not([hidden])") !== null;
  if (detailsOpen) {
    updateTerminalSnapshot(record, card.querySelector(".wall-card-terminal"));
    updateCardMeta(card, record);
    card.className = `wall-card status-${record.status} has-open-details`;
    return card;
  }

  card.className = `wall-card status-${record.status}`;
  card.innerHTML = `
    <div class="wall-card-header">
      <div class="wall-card-title-row">
        <button type="button" class="ghost wall-card-drag-handle" title="拖拽排序" aria-label="拖拽排序"><svg width="100%" height="100%" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 1l-3 3.5h6L12 1z"/><path d="M12 23l-3-3.5h6L12 23z"/><path d="M1 12l3.5-3v6L1 12z"/><path d="M23 12l-3.5-3v6L23 12z"/><rect x="11.25" y="4" width="1.5" height="16" rx=".75"/><rect x="4" y="11.25" width="16" height="1.5" rx=".75"/></svg></button>
        <h2 class="wall-card-title" ${state.editingTitleTerminalId === record.id ? 'hidden' : ''}>${escapeHtml(displayTitle(record))}</h2>
        <input class="wall-card-title-input" type="text" value="${escapeHtml(record.name)}" ${state.editingTitleTerminalId === record.id ? '' : 'hidden'} />
        <div class="wall-card-action-group">
          <button data-action="toggle-hide" class="ghost wall-card-hide-button" title="${state.hiddenTerminalIds.has(record.id) ? "取消隐藏" : "隐藏"}">${state.hiddenTerminalIds.has(record.id) ? "显" : "隐"}</button>
          <button data-action="toggle-mute" class="ghost wall-card-mute-button" title="${getMuteButtonTitle(state.mutedTerminalIds.has(record.id))}" aria-label="${getMuteButtonTitle(state.mutedTerminalIds.has(record.id))}">${renderMuteButtonContent(state.mutedTerminalIds.has(record.id))}</button>
          <button type="button" class="ghost wall-card-more-button" title="更多信息">⋯</button>
        </div>
      </div>
      <div class="wall-card-details-panel" hidden>
        <div class="wall-card-topline">
          <span class="badge status-${record.status}">${statusLabel(record.status)}</span>
        </div>
        <div class="wall-card-tools">
          <button data-action="refresh" class="secondary">刷新</button>
          <button data-action="monitor-mode" class="secondary">回监控模式</button>
          ${record.status !== "closed" ? '<button data-action="set-default-frame" class="secondary">设为默认位置</button>' : ''}
          ${record.status !== "closed" ? '<button data-action="apply-default-frame-all" class="secondary">全部对齐</button>' : ''}
          ${record.status !== "closed" ? '<button data-action="detach" class="secondary">解绑</button>' : ''}
          <button type="button" class="secondary wall-card-input-toggle">命令</button>
        </div>
        <div class="wall-card-tags">
          ${(Array.isArray(record.tags) ? record.tags : []).map(tag => `<span class="wall-card-tag">${escapeHtml(tag)}<button class="wall-card-tag-remove" data-tag="${escapeHtml(tag)}" title="移除标签">×</button></span>`).join("")}
        </div>
        <div class="wall-card-tags-candidates">
          ${state.allTags.filter(t => !(Array.isArray(record.tags) && record.tags.includes(t))).map(t => `<button class="wall-card-tag-candidate" data-tag="${escapeHtml(t)}" title="点击添加标签">+ ${escapeHtml(t)}</button>`).join("")}
        </div>
        <div class="wall-card-tags-input">
          <input type="text" class="wall-card-tag-input" placeholder="新标签名称" />
          <button type="button" class="secondary wall-card-tag-add">+</button>
        </div>
        ${record.lastError ? `<div class="wall-card-error">错误：${escapeHtml(record.lastError)}</div>` : ""}
        <div class="wall-card-input-wrap">
          <div class="wall-card-input" hidden>
            <input type="text" placeholder="快速发命令，例如：echo done" />
            <button type="button" class="secondary">发送</button>
          </div>
        </div>
      </div>
      </div>
    </div>
    <div class="wall-card-terminal"></div>
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
  if (!wallControls) return;
  const nextAttention = getNextAttentionTerminal();
  wallControls.innerHTML = `
    <div class="panel-title">布局 / 筛选 / 翻页</div>
    <div class="wall-control-actions">
      <span class="marker">统一网格模式：支持边界拖拽缩放与上下左右放置</span>
      <button id="reset-grid" class="ghost">重置网格比例</button>
    </div>
    <div class="wall-control-actions">
      <button id="prev-page" class="ghost" ${shouldPaginateCurrentFilter() ? "" : "disabled"}>上一页</button>
      <button id="next-page" class="ghost" ${shouldPaginateCurrentFilter() ? "" : "disabled"}>下一页</button>
      <button id="focus-attention" class="secondary">接管下一个待处理</button>
      <span class="wall-page-text">当前 ${pageInfo.totalItems} 个 · 第 ${state.page}/${pageInfo.totalPages} 页</span>
      ${nextAttention ? `<span class="marker marker-alert">待处理：${escapeHtml(nextAttention.name)}</span>` : `<span class="marker">当前没有待处理任务</span>`}
    </div>
  `;

  wallControls.querySelector("#reset-grid").onclick = () => {
    delete state.gridTrackRatios[getGridRatioKey(state.layout)];
    state.layoutTree = null;
    clearSplitDropPreview();
    saveViewState();
    refreshWall();
  };

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

// rAF 批处理渲染调度：合并高频 WebSocket 消息，统一在下一帧渲染
function scheduleRender(layout = null) {
  if (layout !== null) {
    state._pendingLayout = layout;
  }
  if (state._rafPending) return;
  state._rafPending = true;
  window.requestAnimationFrame(() => {
    state._rafPending = false;
    const layout = state._pendingLayout;
    state._pendingLayout = null;
    if (state._needFullRefresh) {
      state._needFullRefresh = false;
      state._incrementalIds.clear();
      refreshWall(layout);
    } else if (state._incrementalIds.size > 0) {
      const ids = new Set(state._incrementalIds);
      state._incrementalIds.clear();
      incrementalUpdate(layout, ids);
    } else {
      refreshWall(layout);
    }
  });
}

// 增量 DOM 更新：只更新变化的卡片，避免全量重建
function incrementalUpdate(layout = null, changedIds) {
  applyLayout(layout);
  // 获取当前过滤后可见的终端 ID 集合
  const visibleIds = new Set(getFilteredTerminals().map(r => r.id));
  // 检查是否有新的可见终端（在过滤结果中但无对应卡片），回退到全量刷新
  let needFullRefresh = false;
  for (const id of changedIds) {
    if (!visibleIds.has(id)) continue; // 不在当前过滤结果中，跳过
    const existing = document.getElementById(`card-${id}`);
    if (!existing) {
      needFullRefresh = true;
      break;
    }
  }
  if (needFullRefresh) {
    refreshWall(layout);
    return;
  }
  // 增量更新每张变化的卡片
  for (const id of changedIds) {
    const record = state.terminals.get(id);
    if (!record) continue;
    const card = document.getElementById(`card-${id}`);
    if (!card) continue;
    // 更新卡片状态样式（保留拖拽和 preview 相关 class）
    const preserveClasses = [];
    if (card.classList.contains('is-dragging')) preserveClasses.push('is-dragging');
    for (const cls of card.classList) {
      if (cls.startsWith('split-preview-')) preserveClasses.push(cls);
    }
    card.className = `wall-card status-${record.status}${preserveClasses.length ? ' ' + preserveClasses.join(' ') : ''}`;
    // 更新终端输出区域
    updateTerminalSnapshot(record, card.querySelector(".wall-card-terminal"));
    // 更新卡片元信息（标题、状态 badge 等）
    updateCardMeta(card, record);
  }
  // 更新统计和筛选
  syncFilterTabs();
  renderStats();
  renderQueue();
}

// 轻量更新卡片元信息：标题、状态 badge、摘要等（不重建 DOM）
function updateCardMeta(card, record) {
  // 正在编辑标题时跳过
  if (state.editingTitleTerminalId === record.id) return;
  // 更新标题
  const title = card.querySelector(".wall-card-title");
  if (title) title.textContent = displayTitle(record);
  // 更新状态 badge
  const badge = card.querySelector(".badge");
  if (badge) {
    badge.className = `badge status-${record.status}`;
    badge.textContent = statusLabel(record.status);
  }
  // 更新时间戳（已移除）
  // 更新摘要（已移除）
  // 更新错误信息
  const errorEl = card.querySelector(".wall-card-error");
  if (record.lastError) {
    if (errorEl) {
      errorEl.textContent = `错误：${record.lastError}`;
      errorEl.hidden = false;
    }
  } else if (errorEl) {
    errorEl.hidden = true;
  }
  syncMuteButton(
    card.querySelector("[data-action='toggle-mute']"),
    state.mutedTerminalIds.has(record.id),
  );
}

function refreshWall(layout = null) {
  applyLayout(layout);
  const pageInfo = getPagedTerminals();
  grid.innerHTML = "";
  let treeElement = null;
  if (pageInfo.items.length === 0 && state.orderedAppMonitorIds.length === 0) {
    renderEmptyState();
  } else if (state.layoutTree && state.filter === "default") {
    syncLayoutTree();
    treeElement = renderLayoutNode(state.layoutTree, new Set(pageInfo.items.map((record) => record.id)));
    if (treeElement) {
      grid.appendChild(treeElement);
    } else {
      renderEmptyState();
    }
  } else {
    for (const record of pageInfo.items) {
      grid.appendChild(renderTerminal(record));
    }
    renderGridResizers();
  }
  // App 监控卡片渲染到独立容器（不参与终端 grid 布局）
  const appWall = document.getElementById("app-monitor-wall");
  appWall.innerHTML = "";
  for (const appId of state.orderedAppMonitorIds) {
    const monitor = state.appMonitors.get(appId);
    if (monitor) {
      appWall.appendChild(renderAppCard(monitor));
    }
  }
  renderToolbarExtras(pageInfo);
  syncFilterTabs();
  renderStats();
  renderQueue();
}

function applySnapshot(terminals, layout = null, allTags = null) {
  state.terminals.clear();
  for (const record of terminals) {
    state.terminals.set(record.id, record);
  }
  // 从后端数据恢复隐藏状态（优先级高于 localStorage）
  for (const record of terminals) {
    if (record.hidden) {
      state.hiddenTerminalIds.add(record.id);
    }
  }
  // 从后端数据恢复静默状态（优先级高于 localStorage）
  for (const record of terminals) {
    if (record.muted) {
      state.mutedTerminalIds.add(record.id);
    } else {
      state.mutedTerminalIds.delete(record.id);
    }
  }
  // 清理 hiddenTerminalIds 中不再存在的旧 ID
  for (const id of state.hiddenTerminalIds) {
    if (!state.terminals.has(id)) {
      state.hiddenTerminalIds.delete(id);
    }
  }
  // 清理 mutedTerminalIds 中不再存在的旧 ID
  for (const id of state.mutedTerminalIds) {
    if (!state.terminals.has(id)) {
      state.mutedTerminalIds.delete(id);
    }
  }
  syncTerminalOrder(terminals);
  syncLayoutTree();
  initQueueFromSnapshot();
  // 同步全局标签列表
  if (allTags) {
    state.allTags = allTags;
    syncTagFilterSelect();
  }
  refreshWall(layout);
  if (window._refreshCaptureTerminalList) window._refreshCaptureTerminalList();
}

/** 处理 App 监控全量快照（从 snapshot 事件的 appMonitors 字段） */
function applyAppMonitorSnapshot(monitors) {
  state.appMonitors.clear();
  state.orderedAppMonitorIds = [];
  const items = Array.isArray(monitors) ? monitors : [];
  for (const m of items) {
    state.appMonitors.set(m.id, m);
    state.orderedAppMonitorIds.push(m.id);
  }
}

/* ---- App 监控 ---- */

/** 打开 App 监控弹窗，加载可用窗口列表 */
async function openAppMonitorDialog() {
  const dialog = document.getElementById("app-monitor-dialog");
  if (!dialog) return;
  dialog.showModal();
  const listEl = document.getElementById("app-monitor-window-list");
  listEl.innerHTML = '<div style="color:var(--muted);font-size:0.84rem;padding:8px 0;">加载中...</div>';
  try {
    const data = await request("/api/app-monitor/windows");
    const windows = dedupeAppMonitorWindows(data.items || []);
    if (windows.length === 0) {
      listEl.innerHTML = '<div style="color:var(--muted);font-size:0.84rem;padding:8px 0;">未发现可监控的窗口</div>';
      return;
    }
    const monitoredMap = new Map(
      [...state.appMonitors.values()].map(m => [getAppMonitorLogicalKey(m), m.id])
    );
    listEl.innerHTML = windows.map((w) => {
      const appId = monitoredMap.get(getAppMonitorLogicalKey(w));
      const isMonitored = !!appId;
      return `
        <div class="app-monitor-window-item${isMonitored ? " is-monitored" : ""}"
             data-pid="${w.pid}" data-window-number="${w.windowNumber}"
             data-app-name="${escapeHtml(w.appName || "")}" data-window-title="${escapeHtml(w.windowTitle || "")}"
             data-bundle-id="${escapeHtml(w.bundleId || "")}" data-owner-name="${escapeHtml(w.ownerName || "")}"
             data-app-id="${appId || ""}">
          <span class="app-monitor-window-name">${escapeHtml(w.appName || w.bundleId || "未知")}</span>
          <span class="app-monitor-window-title">${escapeHtml(w.windowTitle || "")}</span>
          ${isMonitored
            ? '<button class="app-monitor-remove-list-btn">取消监控</button>'
            : '<button class="secondary app-monitor-add-btn">添加监控</button>'}
        </div>`;
    }).join("");
  } catch (error) {
    listEl.innerHTML = `<div style="color:var(--error);font-size:0.84rem;padding:8px 0;">加载失败：${escapeHtml(error.message)}</div>`;
  }
}

// 事件委托：处理窗口列表的添加/取消按钮点击
document.getElementById("app-monitor-window-list").addEventListener("click", async (e) => {
  const addBtn = e.target.closest(".app-monitor-add-btn");
  const removeBtn = e.target.closest(".app-monitor-remove-list-btn");
  const item = e.target.closest(".app-monitor-window-item");
  if (!item) return;

  if (addBtn) {
    addBtn.disabled = true;
    addBtn.textContent = "添加中...";
    try {
      await addAppMonitor({
        pid: Number(item.dataset.pid),
        windowNumber: Number(item.dataset.windowNumber),
        appName: item.dataset.appName,
        windowTitle: item.dataset.windowTitle,
        bundleId: item.dataset.bundleId,
        ownerName: item.dataset.ownerName,
      });
      // 切换为取消按钮
      const newBtn = document.createElement("button");
      newBtn.className = "app-monitor-remove-list-btn";
      newBtn.textContent = "取消监控";
      const added = [...state.appMonitors.values()].find((m) => (
        getAppMonitorLogicalKey(m) === getAppMonitorLogicalKey({
          pid: Number(item.dataset.pid),
          bundleId: item.dataset.bundleId,
          ownerName: item.dataset.ownerName,
          appName: item.dataset.appName,
          windowTitle: item.dataset.windowTitle,
        })
      ));
      if (added) newBtn.dataset.appId = added.id;
      item.dataset.appId = added ? added.id : "";
      item.classList.add("is-monitored");
      addBtn.replaceWith(newBtn);
    } catch (error) {
      addBtn.disabled = false;
      addBtn.textContent = "添加监控";
      setMessage(error.message, true);
    }
    return;
  }

  if (removeBtn) {
    removeBtn.disabled = true;
    removeBtn.textContent = "移除中...";
    const appId = item.dataset.appId;
    const ok = await removeAppMonitor(appId);
    if (ok) {
      // 切换为添加按钮
      const newBtn = document.createElement("button");
      newBtn.className = "secondary app-monitor-add-btn";
      newBtn.textContent = "添加监控";
      removeBtn.replaceWith(newBtn);
      item.classList.remove("is-monitored");
      item.dataset.appId = "";
    } else {
      removeBtn.disabled = false;
      removeBtn.textContent = "取消监控";
    }
  }
});

/** 关闭 App 监控弹窗 */
function closeAppMonitorDialog() {
  const dialog = document.getElementById("app-monitor-dialog");
  if (dialog) dialog.close();
}

/** 添加 App 监控 */
async function addAppMonitor(windowInfo) {
  // 前端去重：同一逻辑窗口（同一进程同一标题）不重复添加
  const logicalKey = getAppMonitorLogicalKey(windowInfo);
  const dup = [...state.appMonitors.values()].find(
    (m) => getAppMonitorLogicalKey(m) === logicalKey
  );
  if (dup) {
    setMessage(`${windowInfo.appName} 已在监控列表中`);
    return;
  }
  const res = await request("/api/app-monitor/monitors", {
    method: "POST",
    body: JSON.stringify(windowInfo),
  });
  if (res.item) {
    state.appMonitors.set(res.item.id, res.item);
    if (!state.orderedAppMonitorIds.includes(res.item.id)) {
      state.orderedAppMonitorIds.push(res.item.id);
    }
    refreshWall();
    setMessage(`已添加监控：${res.item.appName}`);
  }
}

/** 移除 App 监控 */
async function removeAppMonitor(appId) {
  try {
    await request(`/api/app-monitor/monitors/${appId}`, { method: "DELETE" });
    state.appMonitors.delete(appId);
    state.orderedAppMonitorIds = state.orderedAppMonitorIds.filter((id) => id !== appId);
    refreshWall();
    setMessage("已移除 App 监控");
    return true;
  } catch (error) {
    setMessage(`移除失败：${error.message}`, true);
    return false;
  }
}

/** 唤醒（聚焦）App 窗口 */
async function focusApp(appId) {
  await request(`/api/app-monitor/monitors/${appId}/focus`, { method: "POST" });
  setMessage("已唤醒 App 窗口");
}

/** 渲染 App 监控卡片 */
function renderAppCard(monitor) {
  let card = document.getElementById(`app-card-${monitor.id}`);
  if (card) {
    updateAppCard(monitor);
    return card;
  }

  card = document.createElement("section");
  card.id = `app-card-${monitor.id}`;
  card.className = "wall-card app-card";
  card.style.cssText = "width:320px;overflow:hidden;";
  card.dataset.appId = monitor.id;

  const statusClass = monitor.status === "active" ? "app-status-active"
    : monitor.status === "error" ? "app-status-error"
    : "app-status-gone";

  card.innerHTML = `
    <div class="wall-card-header">
      <div class="wall-card-title-row">
        <h2 class="wall-card-title">${escapeHtml(monitor.appName || monitor.bundleId || "App")}</h2>
        <span class="app-monitor-status-badge ${statusClass}">${monitor.status === "active" ? "活跃" : monitor.status === "error" ? "异常" : "已退出"}</span>
        <button type="button" class="app-card-remove-btn" title="移除监控">✕</button>
      </div>
      <div class="app-card-subtitle">${escapeHtml(monitor.windowTitle || "")}</div>
    </div>
    <div class="app-card-screenshot-area">
      <img class="app-card-screenshot" alt="" />
      <div class="app-card-focus-overlay">
        <span>点击唤醒</span>
      </div>
    </div>
    ${monitor.lastError ? `<div class="wall-card-error">错误：${escapeHtml(monitor.lastError)}</div>` : ""}
  `;

  // 更新截图
  if (monitor.screenshotB64) {
    const img = card.querySelector(".app-card-screenshot");
    img.src = `data:image/jpeg;base64,${monitor.screenshotB64}`;
  }

  // 点击截图区域唤醒 App
  const screenshotArea = card.querySelector(".app-card-screenshot-area");
  screenshotArea.onclick = async (event) => {
    event.stopPropagation();
    document.querySelectorAll(".topbar-menu[open]").forEach((d) => d.removeAttribute("open"));
    try {
      await focusApp(monitor.id);
    } catch (error) {
      setMessage(error.message, true);
    }
  };

  // 移除按钮
  const removeBtn = card.querySelector(".app-card-remove-btn");
  removeBtn.onclick = async (event) => {
    event.stopPropagation();
    try {
      await removeAppMonitor(monitor.id);
    } catch (error) {
      setMessage(error.message, true);
    }
  };

  return card;
}

/** 增量更新 App 卡片（截图 + 状态） */
function updateAppCard(monitor) {
  const card = document.getElementById(`app-card-${monitor.id}`);
  if (!card) return;

  // 更新状态 badge
  const badge = card.querySelector(".app-monitor-status-badge");
  if (badge) {
    const statusClass = monitor.status === "active" ? "app-status-active"
      : monitor.status === "error" ? "app-status-error"
      : "app-status-gone";
    badge.className = `app-monitor-status-badge ${statusClass}`;
    badge.textContent = monitor.status === "active" ? "活跃" : monitor.status === "error" ? "异常" : "已退出";
  }

  // 更新错误信息
  const errorEl = card.querySelector(".wall-card-error");
  if (monitor.lastError) {
    if (errorEl) {
      errorEl.textContent = `错误：${monitor.lastError}`;
      errorEl.hidden = false;
    }
  } else if (errorEl) {
    errorEl.hidden = true;
  }

  // 更新截图（带淡入效果）
  if (monitor.screenshotB64) {
    const img = card.querySelector(".app-card-screenshot");
    if (img) {
      const newSrc = `data:image/jpeg;base64,${monitor.screenshotB64}`;
      if (img.src !== newSrc) {
        img.style.opacity = "0";
        // 使用 onload 确保图片加载完成后再淡入
        img.onload = () => { img.style.opacity = "1"; };
        img.src = newSrc;
      }
    }
  }
}

function getAppMonitorLogicalKey(item) {
  const pid = Number(item?.pid || 0);
  const scope = String(item?.bundleId || item?.ownerName || item?.appName || "").trim().toLowerCase();
  const title = String(item?.windowTitle || "").trim();
  return `${pid}::${scope}::${title}`;
}

function getAppMonitorFrameArea(frame) {
  if (!frame || typeof frame !== "object") {
    return 0;
  }
  return Number(frame.width || 0) * Number(frame.height || 0);
}

function dedupeAppMonitorWindows(windows) {
  const grouped = new Map();
  const order = [];
  for (const item of Array.isArray(windows) ? windows : []) {
    const key = getAppMonitorLogicalKey(item);
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, item);
      order.push(key);
      continue;
    }
    if (getAppMonitorFrameArea(item.frame) > getAppMonitorFrameArea(existing.frame)) {
      grouped.set(key, item);
    }
  }
  return order.map((key) => grouped.get(key)).filter(Boolean);
}

async function loadUiSettings() {
  const data = await request("/api/ui-settings");
  applyUiSettings(data.settings || DEFAULT_UI_SETTINGS, { defaults: data.defaults || DEFAULT_UI_SETTINGS });
  if (uiSettingsPath && data.file) {
    uiSettingsPath.textContent = `配置文件：${data.file}`;
  }
  return data;
}

async function loadInitialState() {
  loadViewState();
  // loadViewState 恢复了 selectedTag，需要同步加载该标签的独立布局
  loadTagLayout();
  const [terminalsData, healthData] = await Promise.all([request("/api/terminals"), request("/api/health"), loadUiSettings()]);
  applySnapshot(terminalsData.items || [], terminalsData.layout || null, terminalsData.allTags || null);
  if (buildVersion && healthData.version) {
    buildVersion.textContent = `v${healthData.version}`;
  }
  saveViewState();
  // 加载屏幕选择器数据（不阻塞主流程）
  loadScreenSelector();
}

function connectWebSocket() {
  setWebSocketStatus("connecting");
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
  // 每个终端 ID 的限速状态：{ timer, lastTime, pending }
  const _termThrottle = new Map();
  const THROTTLE_MS = 200;

  // 处理一条 terminal-updated 消息（限速后实际执行）
  function _applyTerminalUpdate(payload) {
    const oldRecord = state.terminals.get(payload.terminal.id);
    const oldStatus = oldRecord ? oldRecord.status : null;
    if (payload.terminal.status === "waiting" && oldStatus !== "waiting") {
      playWaitingAlert();
    }
    state.terminals.set(payload.terminal.id, payload.terminal);
    // 从后端同步隐藏状态（接管时恢复）
    if (payload.terminal.hidden) {
      state.hiddenTerminalIds.add(payload.terminal.id);
      saveViewState();
    }
    if (payload.terminal.muted) {
      state.mutedTerminalIds.add(payload.terminal.id);
      saveViewState();
    } else {
      state.mutedTerminalIds.delete(payload.terminal.id);
      saveViewState();
    }
    // 同步全局标签列表
    if (payload.allTags) {
      state.allTags = payload.allTags;
      syncTagFilterSelect();
    }
    if (!state.orderedTerminalIds.includes(payload.terminal.id)) {
      state.orderedTerminalIds.push(payload.terminal.id);
    }
    syncLayoutTree();
    updateQueue(payload.terminal.id, oldStatus, payload.terminal.status);
    if (payload.terminal.status === "closed") {
      state.terminals.delete(payload.terminal.id);
      state.orderedTerminalIds = state.orderedTerminalIds.filter((id) => id !== payload.terminal.id);
      state._needFullRefresh = true;
      // 终端关闭后清理限速状态
      const th = _termThrottle.get(payload.terminal.id);
      if (th && th.timer) clearTimeout(th.timer);
      _termThrottle.delete(payload.terminal.id);
    } else {
      state._incrementalIds.add(payload.terminal.id);
    }
    scheduleRender(payload.layout || null);
    if (window._refreshCaptureTerminalList) window._refreshCaptureTerminalList();
  }

  socket.onopen = () => { setWebSocketStatus("connected"); clearTransientErrorMessage(); socket.send("ready"); };
  socket.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "snapshot") {
      // 先恢复 App 监控状态，再调用 applySnapshot（内部会调用 refreshWall）
      if (payload.appMonitors) {
        applyAppMonitorSnapshot(payload.appMonitors);
      }
      applySnapshot(payload.terminals || [], payload.layout || null, payload.allTags || null);
      return;
    }
    if (payload.type === "terminal-updated") {
      const termId = payload.terminal.id;
      const now = Date.now();
      // 状态变更类消息（closed/waiting）不限速，立即处理
      const oldRecord = state.terminals.get(termId);
      const oldStatus = oldRecord ? oldRecord.status : null;
      const isStatusChange = payload.terminal.status !== oldStatus;
      if (isStatusChange) {
        _applyTerminalUpdate(payload);
        const th = _termThrottle.get(termId);
        if (th) { th.lastTime = now; }
        return;
      }
      // 对同一终端的高频 terminal-updated 做限速
      let th = _termThrottle.get(termId);
      if (!th) {
        th = { timer: null, lastTime: 0, pending: null };
        _termThrottle.set(termId, th);
      }
      const elapsed = now - th.lastTime;
      if (elapsed >= THROTTLE_MS) {
        // 距离上次处理已超过阈值，立即处理
        th.lastTime = now;
        th.pending = null;
        _applyTerminalUpdate(payload);
      } else {
        // 距离上次处理不足阈值，暂存并延迟处理（保证最终一致性）
        th.pending = payload;
        if (!th.timer) {
          th.timer = setTimeout(() => {
            th.timer = null;
            if (th.pending) {
              th.lastTime = Date.now();
              const p = th.pending;
              th.pending = null;
              _applyTerminalUpdate(p);
            }
          }, THROTTLE_MS - elapsed);
        }
      }
      return;
    }
    if (payload.type === "monitor-layout" || payload.type === "workspace-mode") {
      state._needFullRefresh = true;
      scheduleRender(payload.layout || null);
      return;
    }
    if (payload.type === "ui-settings-updated") {
      // 保存操作触发的广播不回填表单，避免服务器返回值不完整导致覆盖用户输入
      if (window._uiSettingsSaving && window._uiSettingsSaving()) {
        // 只更新文件路径，不回填表单
        if (uiSettingsPath && payload.file) {
          uiSettingsPath.textContent = `配置文件：${payload.file}`;
        }
      } else {
        applyUiSettings(payload.settings || DEFAULT_UI_SETTINGS);
        if (uiSettingsPath && payload.file) {
          uiSettingsPath.textContent = `配置文件：${payload.file}`;
        }
      }
      state._needFullRefresh = true;
      scheduleRender();
    }
    // App 监控增量事件：只更新对应的监控卡片，不触发全量渲染
    if (payload.type === "app-monitor-updated" && payload.monitor) {
      state.appMonitors.set(payload.monitor.id, payload.monitor);
      if (!state.orderedAppMonitorIds.includes(payload.monitor.id)) {
        state.orderedAppMonitorIds.push(payload.monitor.id);
        // 新增的监控卡片需要全量渲染以插入 DOM
        state._needFullRefresh = true;
        scheduleRender();
      } else {
        // 已有的监控卡片，增量更新截图和状态
        updateAppCard(payload.monitor);
      }
      return;
    }
    if (payload.type === "app-monitor-removed") {
      state.appMonitors.delete(payload.appId);
      state.orderedAppMonitorIds = state.orderedAppMonitorIds.filter(id => id !== payload.appId);
      // 移除对应的 DOM 卡片，不触发全量渲染
      const card = document.getElementById(`app-card-${payload.appId}`);
      if (card) card.remove();
      // 如果监控墙已空，显示空状态
      const appWall = document.getElementById("app-monitor-wall");
      if (appWall && appWall.children.length === 0 && state.orderedAppMonitorIds.length === 0) {
        refreshWall();
      }
      return;
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
    const result = await request("/api/terminals", { method: "POST", body: JSON.stringify({ name: name || null, command: command || null, ...(state.selectedTag && state.selectedTag !== "__untagged__" ? { tags: [state.selectedTag] } : {}), browser_x: window.screenX, browser_y: window.screenY }) });
    createForm.reset();
    setMessage(`已启动 ${result.item.name}，真实 iTerm 窗口已被纳入监控墙`);
  } catch (error) {
    setMessage(error.message, true);
  }
});

document.getElementById("quick-create").onclick = async () => {
  try {
    // 如果当前选中了标签（且不是"无标签"），自动赋予该标签
    const body = { name: null, command: null };
    if (state.selectedTag && state.selectedTag !== "__untagged__") {
      body.tags = [state.selectedTag];
    }
    const result = await request("/api/terminals", { method: "POST", body: JSON.stringify({ ...body, browser_x: window.screenX, browser_y: window.screenY }) });
    setMessage(`已创建 ${result.item.name}，已纳入监控墙`);
  } catch (error) {
    setMessage(error.message, true);
  }
};

// 顶部栏一键接管按钮
document.getElementById("quick-adopt-all").onclick = async () => {
  const btn = document.getElementById("quick-adopt-all");
  btn.disabled = true;
  btn.textContent = "扫描中...";
  try {
    const data = await request("/api/iterm2/sessions");
    const sessions = data.items || [];
    if (sessions.length === 0) {
      setMessage("没有发现可接管的终端");
      return;
    }
    btn.textContent = `接管中 0/${sessions.length}`;
    let count = 0;
    for (const s of sessions) {
      try {
        await request("/api/terminals/adopt", {
          method: "POST",
          body: JSON.stringify({ session_id: s.session_id }),
        });
        count++;
        btn.textContent = `接管中 ${count}/${sessions.length}`;
      } catch (_e) {
        // 单个失败不阻断其余
      }
    }
    setMessage(`已接管 ${count} 个终端`);
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "一键接管";
  }
};

// 顶部栏 App 监控按钮
document.getElementById("app-monitor-btn").onclick = () => openAppMonitorDialog();
document.getElementById("app-monitor-dialog-close").onclick = () => closeAppMonitorDialog();
document.getElementById("app-monitor-dialog").onclick = (e) => {
  if (e.target === e.currentTarget) closeAppMonitorDialog();
};

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

const adoptSessionList = document.getElementById("adopt-session-list");

async function doScanSessions() {
  const scanBtn = adoptSessionList.querySelector("#scan-sessions");
  if (scanBtn) {
    scanBtn.disabled = true;
    scanBtn.textContent = "扫描中...";
  }
  try {
    const data = await request("/api/iterm2/sessions");
    const sessions = data.items || [];
    if (sessions.length === 0) {
      adoptSessionList.innerHTML = `
        <span class="adopt-empty">未发现可接管的终端</span>
        <button id="scan-sessions" class="secondary">重新扫描</button>
      `;
    } else {
      adoptSessionList.innerHTML = sessions.map((s) => `
        <div class="adopt-session-item">
          <span class="adopt-session-name">${escapeHtml(s.name || s.session_id)}</span>
          ${s.title ? `<span class="adopt-session-title">${escapeHtml(s.title)}</span>` : ''}
          <button class="secondary adopt-btn" data-session-id="${escapeHtml(s.session_id)}">接管</button>
        </div>
      `).join('') + '<button id="scan-sessions" class="secondary">重新扫描</button>';
    }
    // 绑定重建后的扫描按钮
    const newScanBtn = adoptSessionList.querySelector("#scan-sessions");
    if (newScanBtn) {
      newScanBtn.onclick = () => doScanSessions();
    }
    // 绑定接管按钮
    adoptSessionList.querySelectorAll(".adopt-btn").forEach((btn) => {
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = "接管中...";
        try {
          await request("/api/terminals/adopt", {
            method: "POST",
            body: JSON.stringify({ session_id: btn.dataset.sessionId }),
          });
          setMessage("终端已接管");
          doScanSessions();
        } catch (error) {
          btn.disabled = false;
          btn.textContent = "接管";
          setMessage(error.message, true);
        }
      };
    });
  } catch (error) {
    setMessage(error.message, true);
    // 出错时恢复按钮状态
    const scanBtn2 = adoptSessionList.querySelector("#scan-sessions");
    if (scanBtn2) {
      scanBtn2.disabled = false;
      scanBtn2.textContent = "扫描可用终端";
    }
  }
}

document.getElementById("scan-sessions").onclick = () => doScanSessions();

document.getElementById("adopt-all-sessions").onclick = async () => {
  const btn = document.getElementById("adopt-all-sessions");
  btn.disabled = true;
  btn.textContent = "扫描中...";
  try {
    const data = await request("/api/iterm2/sessions");
    const sessions = data.items || [];
    if (sessions.length === 0) {
      setMessage("没有发现可接管的终端");
      return;
    }
    btn.textContent = `接管中 0/${sessions.length}`;
    let count = 0;
    for (const s of sessions) {
      try {
        await request("/api/terminals/adopt", {
          method: "POST",
          body: JSON.stringify({ session_id: s.session_id }),
        });
        count++;
        btn.textContent = `接管中 ${count}/${sessions.length}`;
      } catch (_e) {
        // 单个失败不阻断其余
      }
    }
    setMessage(`已接管 ${count} 个终端`);
    // 刷新扫描列表
    doScanSessions();
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "一键接管";
  }
};

closeAllButton.onclick = async () => {
  try {
    await request("/api/terminals/close-all", { method: "POST" });
    // 主动从服务器获取最新状态，避免依赖 WebSocket 事件
    const terminalsData = await request("/api/terminals");
    applySnapshot(terminalsData.items || [], terminalsData.layout || null, terminalsData.allTags || null);
    saveViewState();
    setMessage("已关闭全部真实窗口，并清空监控墙");
  } catch (error) {
    setMessage(error.message, true);
  }
};

if (uiSettingsForm) {
  // 自动保存：input 变更后防抖提交
  let _uiSaveTimer = null;
  // 标记正在保存，防止 WebSocket 广播的 ui-settings-updated 覆盖刚保存的值
  let _uiSaving = false;
  const autoSaveUiSettings = () => {
    clearTimeout(_uiSaveTimer);
    _uiSaveTimer = setTimeout(async () => {
      const payload = Object.fromEntries(
        Object.keys(DEFAULT_UI_SETTINGS).map((key) => {
          const field = uiSettingsForm.elements.namedItem(key);
          return [key, Number(field?.value ?? DEFAULT_UI_SETTINGS[key])];
        })
      );
      _uiSaving = true;
      try {
        const result = await request("/api/ui-settings", {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        // 使用 payload（用户实际输入的值）而非 result.settings 更新 UI，
        // 因为服务器返回值可能因版本差异等原因缺少部分字段，
        // 导致 normalizeUiSettings 用默认值覆盖用户输入。
        applyUiSettings(payload);
        if (uiSettingsPath && result.file) {
          uiSettingsPath.textContent = `配置文件：${result.file}`;
        }
        refreshWall();
        setMessage("界面调优配置已保存");
      } catch (error) {
        setMessage(error.message, true);
      } finally {
        // 延迟重置标志，确保 WebSocket 广播到达时已经被正确忽略
        setTimeout(() => { _uiSaving = false; }, 200);
      }
    }, 400);
  };
  // 将 _uiSaving 暴露给 WebSocket 处理使用
  window._uiSettingsSaving = () => _uiSaving;
  uiSettingsForm.addEventListener("input", autoSaveUiSettings);
  uiSettingsForm.addEventListener("change", autoSaveUiSettings);
}

if (uiSettingsResetButton) {
  uiSettingsResetButton.onclick = async () => {
    const defaults = state.defaultUiSettings || DEFAULT_UI_SETTINGS;
    try {
      const result = await request("/api/ui-settings", {
        method: "PUT",
        body: JSON.stringify(defaults),
      });
      applyUiSettings(result.settings || defaults);
      if (uiSettingsPath && result.file) {
        uiSettingsPath.textContent = `配置文件：${result.file}`;
      }
      refreshWall();
      setMessage("已恢复默认界面配置");
    } catch (error) {
      setMessage(error.message, true);
    }
  };
}

// --- 屏幕选择设置 ---

/**
 * 在调优面板中动态注入屏幕选择 UI
 */
function injectScreenSelector() {
  const tuningPanel = document.querySelector(".topbar-menu--wide > .topbar-menu-panel");
  if (!tuningPanel) return;

  // 创建分隔线
  const divider = document.createElement("div");
  divider.className = "panel-divider";

  // 创建标题
  const title = document.createElement("div");
  title.className = "panel-title";
  title.style.display = "flex";
  title.style.justifyContent = "space-between";
  title.style.alignItems = "center";
  title.innerHTML = `<span>设置窗口弹出默认屏幕 <button type="button" id="refresh-screen-list" style="background:none;border:none;cursor:pointer;font-size:0.9rem;padding:2px 4px;color:var(--fg-muted);" title="刷新屏幕列表">&#x21bb;</button></span><span id="default-screen-hint" style="font-size:0.82rem;color:var(--fg-muted);font-weight:normal;"></span>`;

  // 创建表单
  const form = document.createElement("form");
  form.id = "screen-selector-form";
  form.className = "topbar-form ui-settings-form";
  form.style.gridTemplateColumns = "1fr"; // 单列布局
  form.innerHTML = `
    <label>
      <select id="target-screen-select" style="
        background: var(--surface);
        color: var(--fg);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 6px 8px;
        font-size: 0.92rem;
        width: 100%;
      ">
        <option value="-1">不指定（当前屏幕）</option>
      </select>
    </label>
  `;

  tuningPanel.appendChild(divider);
  tuningPanel.appendChild(title);
  tuningPanel.appendChild(form);

  const select = document.getElementById("target-screen-select");

  // 选择即保存：change 事件自动提交到后端并记为默认
  select.addEventListener("change", async () => {
    const screenIndex = Number(select.value);
    try {
      await request("/api/screens/target", {
        method: "PUT",
        body: JSON.stringify({ target_screen: screenIndex }),
      });
      if (screenIndex === -1) {
        localStorage.removeItem("defaultScreenName");
      } else {
        const screenName = select.options[select.selectedIndex].textContent;
        localStorage.setItem("defaultScreenName", screenName);
      }
      updateDefaultScreenHint();
      setMessage("已切换屏幕并应用默认布局");
      // 后端切换屏幕后已自动应用默认布局，刷新布局列表
      await loadScreenConfigs();
    } catch (error) {
      setMessage(error.message, true);
    }
  });
}

/**
 * 更新默认屏幕提示文字
 */
function updateDefaultScreenHint() {
  const hint = document.getElementById("default-screen-hint");
  if (!hint) return;
  const defaultName = localStorage.getItem("defaultScreenName");
  if (defaultName) {
    hint.textContent = `默认: ${defaultName}`;
  } else {
    hint.textContent = "";
  }
}

/**
 * 加载屏幕列表并填充下拉框，同时选中当前配置值
 */
async function loadScreenSelector() {
  const select = document.getElementById("target-screen-select");
  if (!select) return;

  try {
    // 从屏幕列表 API 获取屏幕信息和当前配置
    const screensData = await request("/api/screens");

    const screens = screensData.items || [];
    const currentTarget = screensData.targetScreen ?? -1;

    // 清空并重建选项
    select.innerHTML = '<option value="-1">不指定（当前屏幕）</option>';
    for (const screen of screens) {
      const option = document.createElement("option");
      option.value = String(screen.index);
      option.textContent = `${screen.name} (${screen.width}x${screen.height})`;
      select.appendChild(option);
    }

    // 如果有默认屏幕设置，尝试按名称匹配
    const defaultName = localStorage.getItem("defaultScreenName");
    let matched = false;
    if (defaultName) {
      for (const option of select.options) {
        if (option.textContent === defaultName) {
          select.value = option.value;
          matched = true;
          break;
        }
      }
    }
    if (!matched) {
      // 没有默认设置或匹配不到，使用后端当前值
      select.value = String(currentTarget);
    }

    // 更新默认屏幕提示
    updateDefaultScreenHint();
  } catch (error) {
    // 屏幕列表加载失败时静默处理，不影响主功能
    console.warn("加载屏幕列表失败:", error.message);
  }
}

// 初始化屏幕选择 UI
injectScreenSelector();

// --- 屏幕配置管理 UI ---

let __activeLayoutScreenName = "";
let __activeLayoutId = "";

function getActiveLayoutKey() {
  return `${__activeLayoutScreenName}::${__activeLayoutId}`;
}

/**
 * 在调优面板中动态注入屏幕配置管理 UI
 */
function injectScreenConfigPanel() {
  const tuningPanel = document.querySelector(".topbar-menu--wide > .topbar-menu-panel");
  if (!tuningPanel) return;

  // 创建分隔线
  const divider = document.createElement("div");
  divider.className = "panel-divider";

  // 创建标题
  const title = document.createElement("div");
  title.className = "panel-title";
  title.style.display = "flex";
  title.style.justifyContent = "space-between";
  title.style.alignItems = "center";
  title.innerHTML = `<span>屏幕配置</span><span id="screen-config-status" style="font-size:0.82rem;color:var(--fg-muted);font-weight:normal;"></span>`;

  // 创建内容区
  const container = document.createElement("div");
  container.id = "screen-config-container";
  container.innerHTML = `
    <div id="screen-config-current" style="margin-bottom:10px;padding:8px 10px;background:rgba(15,23,42,0.5);border-radius:8px;font-size:0.84rem;">
      <div style="color:var(--muted);">当前屏幕配置：<span id="current-screen-info" style="color:var(--text);">加载中...</span></div>
      <div style="color:var(--muted);margin-top:4px;">屏幕名称：<span id="current-screen-name" style="font-family:monospace;color:var(--accent);">--</span></div>
    </div>
    <div style="margin-bottom:8px;color:var(--muted);font-weight:700;font-size:0.84rem;">已保存的布局</div>
    <div id="screen-config-list" style="display:flex;flex-direction:column;gap:6px;max-height:180px;overflow-y:auto;">
      <div style="color:var(--muted);font-size:0.82rem;padding:4px 0;">暂无保存的布局</div>
    </div>
    <div style="margin-top:10px;display:flex;gap:8px;">
      <button id="save-screen-config" class="secondary" style="flex:1;">💾 保存为新布局</button>
      <button id="update-screen-config" class="secondary" style="flex:1;display:none;">✏️ 更新当前布局</button>
    </div>
  `;

  tuningPanel.appendChild(divider);
  tuningPanel.appendChild(title);
  tuningPanel.appendChild(container);

  // 暴露给全局，方便 loadScreenConfigs 中的 apply 按钮设置
  window.__setActiveLayout = (screenName, layoutId) => {
    __activeLayoutScreenName = screenName;
    __activeLayoutId = layoutId;
    const updateBtn = document.getElementById("update-screen-config");
    if (updateBtn) updateBtn.style.display = layoutId ? "block" : "none";
  };

  // 保存为新布局
  const saveBtn = document.getElementById("save-screen-config");
  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      const name = prompt("请输入布局名称（可选，留空则自动生成）");
      if (name === null) return;
      try {
        saveBtn.disabled = true;
        saveBtn.textContent = "⏳ 保存中...";
        const result = await request("/api/screen-configs/save", {
          method: "POST",
          body: JSON.stringify({ config_name: name || "" }),
        });
        // 保存后自动设为当前激活布局
        if (window.__setActiveLayout) window.__setActiveLayout(result.screenName, result.layoutId);
        setMessage("布局已保存");
        await loadScreenConfigs();
      } catch (error) {
        setMessage("保存失败: " + error.message, true);
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = "💾 保存为新布局";
      }
    });
  }

  // 更新当前布局
  const updateBtn = document.getElementById("update-screen-config");
  if (updateBtn) {
    updateBtn.addEventListener("click", async () => {
      if (!__activeLayoutId || !__activeLayoutScreenName) return;
      try {
        updateBtn.disabled = true;
        updateBtn.textContent = "⏳ 更新中...";
        await request(`/api/screen-configs/${encodeURIComponent(__activeLayoutScreenName)}/${encodeURIComponent(__activeLayoutId)}`, {
          method: "PUT",
        });
        setMessage("布局已更新");
        await loadScreenConfigs();
      } catch (error) {
        setMessage("更新失败: " + error.message, true);
      } finally {
        updateBtn.disabled = false;
        updateBtn.textContent = "✏️ 更新当前布局";
      }
    });
  }
}

/**
 * 加载屏幕配置数据并更新 UI
 * 适配新的嵌套数据结构：savedLayouts[screenName].layouts[layoutId]
 */
async function loadScreenConfigs() {
  const currentInfoEl = document.getElementById("current-screen-info");
  const screenNameEl = document.getElementById("current-screen-name");
  const listEl = document.getElementById("screen-config-list");
  const statusEl = document.getElementById("screen-config-status");

  if (!currentInfoEl || !screenNameEl || !listEl) return;

  try {
    const data = await request("/api/screen-configs");
    const current = data.current || {};
    const savedLayouts = data.savedLayouts || {};

    // 更新当前配置信息：使用目标弹出屏幕名称
    const primaryScreen = current.primaryScreen || "未知";
    const screenCount = (current.screens || []).length;
    const screenType = screenCount === 1 ? "单屏" : `${screenCount} 屏`;
    const targetScreenName = data.targetScreenName || primaryScreen;
    currentInfoEl.textContent = `${targetScreenName} (${screenType})`;

    // 更新屏幕名称显示
    screenNameEl.textContent = targetScreenName;

    // 获取目标屏幕对应的布局列表
    const screenLayouts = savedLayouts[targetScreenName];
    const layouts = screenLayouts ? screenLayouts.layouts || {} : {};
    const entries = Object.entries(layouts);
    const defaultEntry = entries.find(([, l]) => l.isDefault);
    const activeLayoutExists = entries.some(([layoutId]) => getActiveLayoutKey() === `${targetScreenName}::${layoutId}`);

    // 首次加载或激活布局已失效时，回退到默认布局。
    if (window.__setActiveLayout && (__activeLayoutScreenName !== targetScreenName || !activeLayoutExists)) {
      if (defaultEntry) {
        const [lid, ldata] = defaultEntry;
        if (!ldata.isPreset) {
          window.__setActiveLayout(targetScreenName, lid);
        } else {
          window.__setActiveLayout("", ""); // 预设布局，隐藏更新按钮
        }
      } else {
        window.__setActiveLayout("", "");
      }
    }

    // 检查当前屏幕是否已保存布局
    const hasLayouts = Object.keys(layouts).length > 0;
    if (statusEl) {
      if (hasLayouts) {
        statusEl.textContent = "✓";
        statusEl.style.color = "var(--done)";
      } else {
        statusEl.textContent = "新配置";
        statusEl.style.color = "var(--warn)";
      }
    }

    // 渲染已保存的布局列表
    if (entries.length === 0) {
      listEl.innerHTML = '<div style="color:var(--muted);font-size:0.82rem;padding:4px 0;">暂无保存的布局</div>';
    } else {
      const screenName = targetScreenName;
      listEl.innerHTML = entries.map(([layoutId, layout]) => {
        const name = layout.configName || layoutId;
        const isPreset = layout.isPreset === true;
        const isDefault = layout.isDefault === true;
        const isCurrent = getActiveLayoutKey() === `${screenName}::${layoutId}`;
        const icons = [];
        if (isDefault) icons.push("⭐");
        if (isPreset) icons.push("🔧");
        if (!isPreset && !isDefault) icons.push("📺");
        const iconStr = icons.join(" ");

        return `
          <div class="screen-config-item${isCurrent ? " is-current" : ""}" data-screen-name="${escapeHtml(screenName)}" data-layout-id="${escapeHtml(layoutId)}" style="
            display:flex;
            align-items:center;
            justify-content:space-between;
            gap:8px;
            padding:6px 10px;
            background:rgba(148,163,184,0.06);
            border:1px solid ${isCurrent ? "rgba(56,211,159,0.3)" : "rgba(148,163,184,0.1)"};
            border-radius:8px;
          ">
            <div style="flex:1;min-width:0;overflow:hidden;">
              <div style="font-size:0.84rem;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                ${iconStr} ${escapeHtml(name)}
              </div>
              <div style="font-size:0.72rem;color:var(--muted);font-family:monospace;">${escapeHtml(layoutId)}</div>
            </div>
            <div style="display:flex;gap:4px;flex-shrink:0;">
              ${isCurrent
                ? '<span style="padding:4px 8px;font-size:0.76rem;color:var(--done);background:rgba(56,211,159,0.1);border-radius:4px;">当前使用</span>'
                : `<button class="screen-config-apply" data-screen-name="${escapeHtml(screenName)}" data-layout-id="${escapeHtml(layoutId)}" style="padding:4px 8px;font-size:0.76rem;background:var(--accent);color:#fff;border:none;border-radius:4px;cursor:pointer;" title="应用此布局">应用</button>`
              }
              ${entries.length > 1 && !isDefault ? `<button class="screen-config-delete danger" data-screen-name="${escapeHtml(screenName)}" data-layout-id="${escapeHtml(layoutId)}" style="padding:4px 8px;font-size:0.76rem;" title="删除此布局">删除</button>` : ""}
              <button class="screen-config-set-default${isDefault ? " is-active" : ""}" data-screen-name="${escapeHtml(screenName)}" data-layout-id="${escapeHtml(layoutId)}" style="padding:4px 8px;font-size:0.76rem;border-radius:4px;cursor:pointer;" title="设为默认布局"${isDefault ? " disabled" : ""}>⭐ 设为默认</button>
            </div>
          </div>
        `;
      }).join("");

      // 绑定应用按钮事件
      listEl.querySelectorAll(".screen-config-apply").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const sName = btn.dataset.screenName;
          const lId = btn.dataset.layoutId;
          try {
            btn.disabled = true;
            btn.textContent = "应用中...";
            const result = await request(`/api/screen-configs/${encodeURIComponent(sName)}/${encodeURIComponent(lId)}/apply`, { method: "POST" });
            // 设置为当前激活布局
            if (window.__setActiveLayout) window.__setActiveLayout(sName, lId);
            await loadScreenConfigs();
            setMessage(`已应用布局，${result.applied} 个终端位置已更新`);
          } catch (error) {
            setMessage("应用布局失败: " + error.message, true);
          } finally {
            btn.disabled = false;
            btn.textContent = "应用";
          }
        });
      });

      // 绑定删除按钮事件
      listEl.querySelectorAll(".screen-config-delete").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const sName = btn.dataset.screenName;
          const lId = btn.dataset.layoutId;
          if (!confirm("确定要删除此布局配置吗？")) return;
          try {
            await request(`/api/screen-configs/${encodeURIComponent(sName)}/${encodeURIComponent(lId)}`, { method: "DELETE" });
            if (getActiveLayoutKey() === `${sName}::${lId}` && window.__setActiveLayout) {
              window.__setActiveLayout("", "");
            }
            setMessage("布局已删除");
            await loadScreenConfigs();
          } catch (error) {
            setMessage("删除失败: " + error.message, true);
          }
        });
      });

      // 绑定设为默认按钮事件
      listEl.querySelectorAll(".screen-config-set-default").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const sName = btn.dataset.screenName;
          const lId = btn.dataset.layoutId;
          try {
            btn.disabled = true;
            await request(`/api/screen-configs/${encodeURIComponent(sName)}/${encodeURIComponent(lId)}/set-default`, { method: "POST" });
            setMessage("已设为默认布局");
            await loadScreenConfigs();
          } catch (error) {
            setMessage("设为默认失败: " + error.message, true);
            btn.disabled = false;
          }
        });
      });
    }
  } catch (error) {
    console.warn("加载屏幕配置失败:", error.message);
    currentInfoEl.textContent = "加载失败";
    screenNameEl.textContent = "--";
  }
}

// 初始化屏幕配置管理 UI
injectScreenConfigPanel();

// 刷新屏幕列表按钮
const refreshScreenBtn = document.getElementById("refresh-screen-list");
if (refreshScreenBtn) {
  refreshScreenBtn.addEventListener("click", async () => {
    refreshScreenBtn.style.transform = "rotate(360deg)";
    refreshScreenBtn.style.transition = "transform 0.4s";
    await loadScreenSelector();
    setTimeout(() => { refreshScreenBtn.style.transform = ""; refreshScreenBtn.style.transition = ""; }, 400);
  });
}

// 监听调优面板展开事件，实时刷新屏幕列表（支持热插拔外接屏幕）
const tuningDetails = document.querySelector("details.topbar-menu--wide");
if (tuningDetails) {
  tuningDetails.addEventListener("toggle", () => {
    if (tuningDetails.open) {
      loadScreenSelector();
      loadScreenConfigs();
    }
  });
}

// 初始化顶部筛选 tab 点击事件
document.querySelectorAll("#topbar-filters .filter-tab").forEach((tab) => {
  tab.onclick = () => {
    const filter = tab.dataset.filter;
    if (filter === state.filter) {
      return;
    }
    if (filter === "attention" && state.filter !== "attention") {
      // 进入"待处理"时对当前待处理终端做快照，避免处理后立即消失
      state.attentionSnapshot = new Set(
        [...state.terminals.values()]
          .filter((r) => ["error", "waiting"].includes(r.status) && !state.hiddenTerminalIds.has(r.id))
          .map((r) => r.id)
      );
    } else if (filter !== "attention") {
      state.attentionSnapshot = null;
    }
    state.filter = filter;
    state.page = 1;
    refreshWall();
  };
});

// 标签筛选事件已在 syncTagFilterSelect 中通过事件委托绑定

window.addEventListener("resize", () => {
  if (state.layout.count > 0) {
    renderGridResizers();
  }
});

// 记录 mousedown 起始目标，防止从面板内拖选文字到外部松开时误关闭面板
let mousedownTarget = null;
document.addEventListener("mousedown", (e) => {
  mousedownTarget = e.target;
});

// 点击外部或按 Esc 关闭顶部菜单和卡片详情面板
document.addEventListener("click", (e) => {
  document.querySelectorAll(".topbar-menu[open]").forEach((d) => {
    if (!d.contains(e.target) && !d.contains(mousedownTarget)) d.removeAttribute("open");
  });
  document.querySelectorAll(".wall-card-details-panel:not([hidden])").forEach((panel) => {
    if (!panel.contains(e.target) && !panel.contains(mousedownTarget) && !e.target.closest(".wall-card-more-button")) {
      panel.hidden = true;
      const card = panel.closest(".wall-card");
      card?.classList.remove("has-open-details");
      const btn = card?.querySelector(".wall-card-more-button");
      if (btn) btn.classList.remove("is-active");
    }
  });
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    document.querySelectorAll(".topbar-menu[open]").forEach((d) => d.removeAttribute("open"));
    document.querySelectorAll(".wall-card-details-panel:not([hidden])").forEach((panel) => {
      panel.hidden = true;
      const card = panel.closest(".wall-card");
      card?.classList.remove("has-open-details");
      const btn = card?.querySelector(".wall-card-more-button");
      if (btn) btn.classList.remove("is-active");
    });
  }
});

/* --- 系统监控轮询 --- */
const statCpuEl = document.getElementById("stat-cpu");
const statMemEl = document.getElementById("stat-mem");
const statDiskEl = document.getElementById("stat-disk");
const statDiskFreeEl = document.getElementById("stat-disk-free");

function getStatLevel(percent) {
  if (percent >= 80) return "danger";
  if (percent >= 60) return "warning";
  return "normal";
}

function applyStatLevel(el, level) {
  el.classList.remove("stat-level-normal", "stat-level-warning", "stat-level-danger");
  el.classList.add(`stat-level-${level}`);
}

let _systemStatsTimer = null;

async function fetchSystemStats() {
  try {
    const data = await request("/api/system-stats");
    const diskFreePercent = data.disk_total_gb > 0
      ? (data.disk_free_gb / data.disk_total_gb) * 100
      : 0;
    const diskFreePressure = Math.max(0, 100 - diskFreePercent);

    setStatusbarLabel(statCpuEl, `CPU ${data.cpu_percent.toFixed(0)}%`);
    setStatusbarLabel(statMemEl, `MEM ${data.memory_percent.toFixed(0)}%`);
    setStatusbarLabel(statDiskEl, `占用 ${data.disk_percent.toFixed(0)}%`);
    setStatusbarLabel(statDiskFreeEl, `剩余 ${data.disk_free_gb}G`);

    applyStatLevel(statCpuEl, getStatLevel(data.cpu_percent));
    applyStatLevel(statMemEl, getStatLevel(data.memory_percent));
    applyStatLevel(statDiskEl, getStatLevel(data.disk_percent));
    // 剩余空间按“压力”显示：剩余越少，越接近 danger
    const diskFreeLevel = getStatLevel(diskFreePressure);
    applyStatLevel(statDiskFreeEl, diskFreeLevel);
    setStatusbarMetric(statCpuEl, data.cpu_percent, data.cpu_percent >= 85 ? "#ff7d7d" : data.cpu_percent >= 60 ? "#f7c948" : "#55e36f");
    setStatusbarMetric(statMemEl, data.memory_percent, data.memory_percent >= 85 ? "#ff7d7d" : data.memory_percent >= 60 ? "#f7c948" : "#55e36f");
    setStatusbarMetric(statDiskEl, data.disk_percent, data.disk_percent >= 85 ? "#ff7d7d" : data.disk_percent >= 60 ? "#f7c948" : "#55e36f");
    setStatusbarMetric(
      statDiskFreeEl,
      diskFreePressure,
      diskFreePressure >= 85 ? "#ff7d7d" : diskFreePressure >= 60 ? "#f7c948" : "#55e36f",
    );
  } catch {
    // 接口不可用时静默忽略，保持 "--%" 显示
  }
}

function startSystemStatsPolling() {
  fetchSystemStats();
  _systemStatsTimer = setInterval(fetchSystemStats, 5000);
}

function setStatusbarMetric(el, percent, color) {
  if (!el) {
    return;
  }
  const normalized = Math.max(0, Math.min(100, Number(percent) || 0));
  el.style.setProperty("--statusbar-fill-ratio", String(normalized / 100));
  el.style.setProperty("--statusbar-fill-color", color);
}

function setStatusbarLabel(el, text) {
  if (!el) {
    return;
  }
  const label = el.querySelector(".status-meter-label");
  if (label) {
    label.textContent = text;
  } else {
    el.textContent = text;
  }
}

loadInitialState().then(() => {
  connectWebSocket();
  startSystemStatsPolling();
}).catch((error) => {
  setMessage(error.message, true);
  connectWebSocket();
  startSystemStatsPolling();
});
