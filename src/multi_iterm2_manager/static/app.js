const state = {
  terminals: new Map(),
  orderedTerminalIds: [],
  views: new Map(),
  layout: { count: 0, columns: 1, rows: 1 },
  nextLayoutMode: null,
  nextFitMode: false,
  gridTrackRatios: {},
  layoutTree: null,
  draggedTerminalId: null,
  hoverTargetPaneId: null,
  hoverDropZone: null,
  activeGridResize: null,
  activeSplitResize: null,
  activeCardDrag: null,
  suppressClickUntil: 0,
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
      gridTrackRatios: state.gridTrackRatios,
      layoutTree: state.layoutTree,
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
    if (payload.gridTrackRatios && typeof payload.gridTrackRatios === "object") {
      state.gridTrackRatios = payload.gridTrackRatios;
    }
    if (payload.layoutTree && typeof payload.layoutTree === "object") {
      state.layoutTree = normalizeLayoutTree(payload.layoutTree);
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
const dashboardLayout = document.querySelector(".dashboard-layout");

const GRID_GAP_PX = 6;
const GRID_RESIZER_SIZE_PX = 16;
const MIN_GRID_TRACK_RATIO = 0.18;
const SPLIT_RESIZER_SIZE_PX = 14;
const MIN_SPLIT_TRACK_RATIO = 0.12;
const CARD_DRAG_START_THRESHOLD_PX = 6;




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

function buildInitialLayoutTree(terminals, columns = Math.max(1, state.layout.columns || state.nextLayoutMode || 2)) {
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
  const contentSize = session.direction === "row"
    ? session.rect.width - SPLIT_RESIZER_SIZE_PX * Math.max(0, session.slotCount - 1)
    : session.rect.height - SPLIT_RESIZER_SIZE_PX * Math.max(0, session.slotCount - 1);
  const totalBefore = session.sizes.slice(0, session.index).reduce((acc, item) => acc + item, 0);
  const pairTotal = session.sizes[session.index] + session.sizes[session.index + 1];
  const pointer = session.direction === "row"
    ? event.clientX - session.rect.left - SPLIT_RESIZER_SIZE_PX * session.index - SPLIT_RESIZER_SIZE_PX / 2
    : event.clientY - session.rect.top - SPLIT_RESIZER_SIZE_PX * session.index - SPLIT_RESIZER_SIZE_PX / 2;
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
  const active = getActiveTerminalRecords();
  const activeIds = active.map((record) => record.id);
  if (!activeIds.includes(sourceId) || !activeIds.includes(targetId)) {
    reorderTerminals(sourceId, targetId);
    return;
  }
  const baseTree = state.layoutTree || buildInitialLayoutTree(active, Math.max(1, state.layout.columns || 2));
  const draggedNode = createTerminalLayoutNode(sourceId);
  const removed = removeTerminalFromTree(baseTree, sourceId);
  state.layoutTree = insertTerminalBySplit(removed, targetId, draggedNode, zone || "right");
  mergeVisibleIds(getTerminalIdsFromTree(state.layoutTree).filter((id) => activeIds.includes(id)), activeIds);
  saveViewState();
  refreshWall();
}

function removeGridResizers() {
  grid.querySelector(".grid-resizer-overlay")?.remove();
}

function renderGridResizers() {
  removeGridResizers();
  if (!grid || state.layout.count <= 1 || state.layoutTree) return;
  const layout = state.layout;
  const ratios = ensureGridTrackRatios(layout);
  if ((layout.columns || 1) <= 1 && (layout.rows || 1) <= 1) return;

  const overlay = document.createElement("div");
  overlay.className = "grid-resizer-overlay";
  const rect = grid.getBoundingClientRect();
  const contentWidth = rect.width - GRID_GAP_PX * Math.max(0, (layout.columns || 1) - 1);
  const contentHeight = rect.height - GRID_GAP_PX * Math.max(0, (layout.rows || 1) - 1);

  if ((layout.columns || 1) > 1) {
    let total = 0;
    ratios.columns.forEach((ratio, index) => {
      total += ratio;
      if (index === ratios.columns.length - 1) return;
      const handle = document.createElement("button");
      handle.type = "button";
      handle.className = "grid-resizer grid-resizer--vertical";
      handle.style.left = `${total * contentWidth + GRID_GAP_PX * index + GRID_GAP_PX / 2}px`;
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
      handle.style.top = `${total * contentHeight + GRID_GAP_PX * index + GRID_GAP_PX / 2}px`;
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
    ? session.rect.width - GRID_GAP_PX * Math.max(0, layout.columns - 1)
    : session.rect.height - GRID_GAP_PX * Math.max(0, layout.rows - 1);
  const pointer = session.axis === "columns"
    ? event.clientX - session.rect.left - GRID_GAP_PX * session.index - GRID_GAP_PX / 2
    : event.clientY - session.rect.top - GRID_GAP_PX * session.index - GRID_GAP_PX / 2;
  const ratioPosition = clamp(pointer / Math.max(contentSize, 1), totalBefore + MIN_GRID_TRACK_RATIO, totalBefore + pairTotal - MIN_GRID_TRACK_RATIO);
  const firstRatio = ratioPosition - totalBefore;
  ratios[session.index] = firstRatio;
  ratios[session.index + 1] = pairTotal - firstRatio;
  state.gridTrackRatios[key] = {
    ...ensureGridTrackRatios(layout),
    [trackKey]: normalizeRatios(ratios, ratios.length),
  };
  applyGridTrackStyles();
  renderGridResizers();
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
    return null;
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
  try {
    session.card.releasePointerCapture?.(session.pointerId);
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
  const target = getDropTargetAtPoint(event.clientX, event.clientY);
  if (target) {
    applySplitDropPreview(target.card, target.terminalId, target.zone);
  } else {
    clearSplitDropPreview();
  }
}

function handleCardPointerUp(event) {
  const session = state.activeCardDrag;
  if (!session || event.pointerId !== session.pointerId) {
    return;
  }
  const shouldCommit = session.started;
  if (shouldCommit) {
    event.preventDefault();
    state.suppressClickUntil = Date.now() + 220;
    commitCardPointerDrag(event.clientX, event.clientY);
  }
  stopCardPointerDrag();
}

function beginCardPointerDrag(card, record, event) {
  if (event.button !== 0 || shouldIgnoreDragStart(event.target) || record.status === 'closed' || state.activeGridResize || state.activeSplitResize) {
    return;
  }
  state.activeCardDrag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    started: false,
    terminalId: record.id,
    card,
  };
  card.setPointerCapture?.(event.pointerId);
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
  if (count <= 0) return { count: 0, columns: 1, rows: 1, fitMode: false };
  const columns = Math.max(1, Math.min(2, state.nextLayoutMode || 2));
  const fitMode = Boolean(state.nextFitMode && count === 4 && columns === 2);
  return { count, columns, rows: Math.max(1, Math.ceil(count / columns)), fitMode };
}

function applyLayout(_layoutFromServer = null) {
  const active = getActiveTerminalRecords();
  const layout = inferLayout(active);
  state.layout = layout;
  grid.dataset.columns = String(Math.min(layout.columns || 1, 4));
  grid.dataset.rows = String(layout.rows || 1);
  grid.dataset.fitMode = layout.fitMode ? "true" : "false";
  grid.dataset.engine = state.layoutTree ? "split" : "grid";
  if (state.layoutTree) {
    grid.style.removeProperty("grid-template-columns");
    grid.style.removeProperty("grid-template-rows");
  } else {
    applyGridTrackStyles();
  }
  state.nextLayoutMode = null;
  state.nextFitMode = false;
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
  card.draggable = false;
  card.onpointerdown = (event) => beginCardPointerDrag(card, record, event);
  card.onpointermove = handleCardPointerMove;
  card.onpointerup = handleCardPointerUp;
  card.onpointercancel = handleCardPointerUp;
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
    state.editingTitleTerminalId = null;
    if (!commit || !nextName || nextName === record.name) {
      refreshWall();
      return;
    }
    try {
      await renameTerminal(record.id, nextName);
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
  if (detailsToggle) {
    detailsToggle.onclick = (event) => {
      event.stopPropagation();
      event.preventDefault();
      if (!detailsPanel) return;
      const expanded = !detailsPanel.hidden;
      detailsPanel.hidden = expanded;
      detailsToggle.classList.toggle('is-active', !expanded);
    };
  }

  terminalArea.onclick = async (event) => {
    event.stopPropagation();
    if (Date.now() < state.suppressClickUntil) return;
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

  const detachBtn = card.querySelector("[data-action='detach']");
  if (detachBtn) {
    detachBtn.onclick = async (event) => {
      event.stopPropagation();
      if (!confirm("确定要解绑此终端吗？解绑后终端将从监控墙消失，在 iTerm2 中显现。")) return;
      try {
        await request(`/api/terminals/${record.id}/detach`, { method: "POST" });
        setMessage("终端已解绑");
      } catch (error) {
        setMessage(error.message, true);
      }
    };
  }

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

  card.className = `wall-card status-${record.status}`;
  card.innerHTML = `
    <div class="wall-card-header">
      <div class="wall-card-title-row">
        <h2 class="wall-card-title" ${state.editingTitleTerminalId === record.id ? 'hidden' : ''}>${escapeHtml(record.name)}</h2>
        <input class="wall-card-title-input" type="text" value="${escapeHtml(record.name)}" ${state.editingTitleTerminalId === record.id ? '' : 'hidden'} />
        <button type="button" class="ghost wall-card-more-button" title="更多信息">⋯</button>
      </div>
      <div class="wall-card-details-panel" hidden>
        <div class="wall-card-topline">
          <span class="badge status-${record.status}">${statusLabel(record.status)}</span>
          <span class="marker">${escapeHtml(record.updatedAt || "-")}</span>
        </div>
        <div class="wall-card-tools">
          <button data-action="refresh" class="secondary">刷新</button>
          <button data-action="hide" class="secondary">回监控模式</button>
          ${record.status !== "closed" ? '<button data-action="detach" class="secondary">解绑</button>' : ''}
          <button type="button" class="secondary wall-card-input-toggle">命令</button>
        </div>
        <div class="wall-card-meta">session ${escapeHtml(record.sessionId || "-")} · window ${escapeHtml(record.windowId || "-")}</div>
        <div class="wall-card-summary">${escapeHtml(record.summary || "暂无摘要")}</div>
        ${record.lastError ? `<div class="wall-card-error">错误：${escapeHtml(record.lastError)}</div>` : ""}
        <div class="wall-card-marker-list">${(record.markers || []).map((item) => `<span class="marker">${escapeHtml(item)}</span>`).join("")}</div>
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
  const nextAttention = getNextAttentionTerminal();
  wallControls.innerHTML = `
    <div class="panel-title">布局 / 筛选 / 翻页</div>
    <div class="wall-control-actions">
      <span class="marker">统一网格模式：支持边界拖拽缩放与上下左右放置</span>
      <button id="reset-grid" class="ghost">重置网格比例</button>
    </div>
    <div class="wall-control-actions">
      <button data-layout="1" class="secondary">每行 1 个</button>
      <button data-layout="2" class="secondary">每行 2 个</button>
      <button id="toggle-fit-mode" class="secondary">四终端铺满</button>
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

  wallControls.querySelector("#reset-grid").onclick = () => {
    delete state.gridTrackRatios[getGridRatioKey(state.layout)];
    state.layoutTree = null;
    clearSplitDropPreview();
    saveViewState();
    refreshWall();
  };

  wallControls.querySelectorAll("[data-layout]").forEach((button) => {
    button.onclick = () => {
      state.layoutTree = null;
      state.nextLayoutMode = Number(button.dataset.layout || 2);
      state.nextFitMode = false;
      refreshWall();
    };
  });

  wallControls.querySelector("#toggle-fit-mode").onclick = () => {
    state.layoutTree = null;
    state.nextLayoutMode = 2;
    state.nextFitMode = true;
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
  } else if (state.layoutTree && state.filter === "active") {
    syncLayoutTree();
    const treeElement = renderLayoutNode(state.layoutTree, new Set(pageInfo.items.map((record) => record.id)));
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
  renderToolbarExtras(pageInfo);
  renderStats();
}

function applySnapshot(terminals, layout = null) {
  state.terminals.clear();
  for (const record of terminals) {
    state.terminals.set(record.id, record);
  }
  syncTerminalOrder(terminals);
  syncLayoutTree();
  refreshWall(layout);
}

async function loadInitialState() {
  loadViewState();
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
      syncLayoutTree();
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

closeAllButton.onclick = async () => {
  try {
    await request("/api/terminals/close-all", { method: "POST" });
    setMessage("已关闭全部真实窗口，并清空监控墙");
  } catch (error) {
    setMessage(error.message, true);
  }
};

window.addEventListener("resize", () => {
  if (state.layout.count > 0) {
    renderGridResizers();
  }
});

// 点击外部或按 Esc 关闭顶部菜单和卡片详情面板
document.addEventListener("click", (e) => {
  document.querySelectorAll(".topbar-menu[open]").forEach((d) => {
    if (!d.contains(e.target)) d.removeAttribute("open");
  });
  document.querySelectorAll(".wall-card-details-panel:not([hidden])").forEach((panel) => {
    if (!panel.contains(e.target) && !e.target.closest(".wall-card-more-button")) {
      panel.hidden = true;
      const btn = panel.closest(".wall-card")?.querySelector(".wall-card-more-button");
      if (btn) btn.classList.remove("is-active");
    }
  });
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    document.querySelectorAll(".topbar-menu[open]").forEach((d) => d.removeAttribute("open"));
    document.querySelectorAll(".wall-card-details-panel:not([hidden])").forEach((panel) => {
      panel.hidden = true;
      const btn = panel.closest(".wall-card")?.querySelector(".wall-card-more-button");
      if (btn) btn.classList.remove("is-active");
    });
  }
});

loadInitialState().then(connectWebSocket).catch((error) => {
  setMessage(error.message, true);
  connectWebSocket();
});
