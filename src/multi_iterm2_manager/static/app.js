const VIEW_MODE_STORAGE_KEY = "mitm-view-mode";
const VIEW_MODE_SEQUENCE = ["live", "brief"];
const SAVED_IDEAS_STORAGE_KEY = "mitm-saved-ideas";
const DEFAULT_IDEA_FOLDER_KEY = "__unfiled__";
const DEFAULT_IDEA_FOLDER_NAME = "未归属项目";
const CONNECTION_DIALOG_SHOW_DELAY_MS = 600;
const CONNECTION_RETRY_DELAY_MS = 3000;
const CONNECTION_LONG_WAIT_MS = 30000;
const CONNECTION_SUCCESS_HOLD_MS = 1000;

const state = {
  terminals: new Map(),
  orderedTerminalIds: [],
  views: new Map(),
  viewMode: localStorage.getItem(VIEW_MODE_STORAGE_KEY) === "brief" ? "brief" : "live",
  layout: { count: 0, columns: 1, rows: 1 },
  nextFitMode: false,
  gridTrackRatios: {},
  layoutTree: null,
  summaryCellAssignments: {},
  summaryGridRows: 1,
  summaryGridColumns: 1,
  draggedTerminalId: null,
  hoverTargetPaneId: null,
  hoverDropZone: null,
  hoverSummaryCellIndex: null,
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
  summaryConfig: {},               // 摘要配置缓存（含 activeInterval）
  queueDismissed: new Map(),       // 用户手动移除的终端: Map<id, status> — 状态变化后自动清除
  allTags: [],                     // 全局标签列表，从后端同步
  selectedTag: null,               // 当前选中的标签筛选
  appMonitors: new Map(),          // App 监控数据: Map<appId, monitor>
  orderedAppMonitorIds: [],        // App 监控有序 ID 列表
  savedIdeas: [],                  // 菜单内想法缓存区，持久化到 localStorage
  connectionDialog: {
    status: "connecting",
    attempt: 0,
    startedAt: 0,
    nextRetryAt: 0,
    showTimer: null,
    tickTimer: null,
    closeTimer: null,
  },
  ideaDialog: {
    selectedFolderKey: null,
    draft: "",
    editingId: null,
    editDraft: "",
    dragEnabledId: null,
    dragId: null,
    dragOverId: null,
    dropPlacement: "after",
  },
  contextMenu: {
    terminalId: null,
    anchorX: 0,
    anchorY: 0,
    tagDraft: "",
  },
};

const VIEW_STATE_STORAGE_KEY = "mitm-monitor-view-state";
const AGENT_PROGRAM_KEYS = new Set(["claude-code", "codex"]);

function isAgentProgram(program) {
  if (!program || typeof program !== "object") return false;
  if (program.isAgent === true) return true;
  return AGENT_PROGRAM_KEYS.has(program.key);
}

function syncAgentCardClass(card, record) {
  if (!card) return;
  card.classList.toggle("wall-card--non-agent", !isAgentProgram(record?.program));
}

function shouldTrackTerminalStatus(record) {
  return Boolean(record) && isAgentProgram(record.program);
}

function isTerminalHidden(recordOrId) {
  const terminalId = typeof recordOrId === "string" ? recordOrId : recordOrId?.id;
  return Boolean(terminalId) && state.hiddenTerminalIds.has(terminalId);
}

function getHideButtonLabel(recordOrId) {
  return isTerminalHidden(recordOrId) ? "取消隐藏" : "隐藏";
}

function getHideButtonTitle(recordOrId) {
  return getHideButtonLabel(recordOrId);
}

function saveViewState() {
  try {
    const payload = {
      orderedTerminalIds: state.orderedTerminalIds,
      gridTrackRatios: state.gridTrackRatios,
      layoutTree: state.layoutTree,
      summaryCellAssignments: state.summaryCellAssignments,
      hiddenTerminalIds: [...state.hiddenTerminalIds],
      mutedTerminalIds: [...state.mutedTerminalIds],
      queueDismissed: [...state.queueDismissed.entries()],
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
    if (payload.summaryCellAssignments && typeof payload.summaryCellAssignments === "object") {
      state.summaryCellAssignments = normalizeSummaryCellAssignments(payload.summaryCellAssignments);
    }
    if (Array.isArray(payload.hiddenTerminalIds)) {
      state.hiddenTerminalIds = new Set(payload.hiddenTerminalIds);
    }
    if (Array.isArray(payload.mutedTerminalIds)) {
      state.mutedTerminalIds = new Set(payload.mutedTerminalIds);
    }
    if (Array.isArray(payload.queueDismissed)) {
      state.queueDismissed = new Map(
        payload.queueDismissed.filter((entry) =>
          Array.isArray(entry)
          && entry.length === 2
          && typeof entry[0] === "string"
          && typeof entry[1] === "string"
        ),
      );
    }
    if (payload.selectedTag) {
      state.selectedTag = payload.selectedTag;
    }
  } catch {
  }
}

function dismissQueueItem(terminalId, status) {
  if (!terminalId || !status) {
    return;
  }
  state.queueDismissed.set(terminalId, status);
  saveViewState();
}

function clearDismissedQueueItem(terminalId) {
  if (!state.queueDismissed.has(terminalId)) {
    return;
  }
  state.queueDismissed.delete(terminalId);
  saveViewState();
}

function syncHideButton(button, recordOrId) {
  if (!button) {
    return;
  }
  const label = getHideButtonLabel(recordOrId);
  button.textContent = label;
  button.title = label;
  button.setAttribute("aria-label", label);
}

function getMuteButtonLabel(isMuted) {
  return isMuted ? "取消静默" : "静默（不进入队列）";
}

function getMuteButtonTitle(isMuted) {
  return getMuteButtonLabel(isMuted);
}

function syncMuteButton(button, isMuted) {
  if (!button) {
    return;
  }
  const label = getMuteButtonLabel(isMuted);
  button.title = label;
  button.setAttribute("aria-label", label);
  button.textContent = label;
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
      summaryCellAssignments: state.summaryCellAssignments ? JSON.parse(JSON.stringify(state.summaryCellAssignments)) : {},
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
      state.summaryCellAssignments = normalizeSummaryCellAssignments(layout.summaryCellAssignments || {});
    } else {
      // 该标签没有保存过布局，清空让 syncTerminalOrder 自然排列
      state.orderedTerminalIds = [];
      state.gridTrackRatios = {};
      state.layoutTree = null;
      state.summaryCellAssignments = {};
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
const terminalContextMenu = document.getElementById("terminal-context-menu");
const connectionDialog = document.getElementById("connection-dialog");
const connectionDialogTitle = document.getElementById("connection-dialog-title");
const connectionDialogState = document.getElementById("connection-dialog-state");
const connectionDialogDescription = document.getElementById("connection-dialog-description");
const connectionDialogDetail = document.getElementById("connection-dialog-detail");
const connectionDialogAttempt = document.getElementById("connection-dialog-attempt");
const connectionDialogRetry = document.getElementById("connection-dialog-retry");
const ideaDialog = document.getElementById("idea-dialog");
const ideaDialogContent = document.getElementById("idea-dialog-content");
const ideaDialogClose = document.getElementById("idea-dialog-close");
const viewModeButtons = [...document.querySelectorAll(".view-btn[data-view]")];
function getTopbarMenus() {
  return [...document.querySelectorAll(".topbar-menu")];
}

function getTopbarMenuTrigger(menu) {
  return menu?.querySelector(".topbar-menu-trigger");
}

function getTopbarMenuPanel(menu) {
  const trigger = getTopbarMenuTrigger(menu);
  const panelId = trigger?.getAttribute("aria-controls");
  if (panelId) {
    return document.getElementById(panelId);
  }
  return menu?.querySelector(".topbar-menu-panel");
}

function hasOpenTopbarMenu() {
  return getTopbarMenus().some((menu) => menu.classList.contains("is-open"));
}

function createDefaultContextMenuState() {
  return {
    terminalId: null,
    anchorX: 0,
    anchorY: 0,
    tagDraft: "",
    ideaDraft: "",
    ideaEditingId: null,
    ideaEditDraft: "",
    ideaDragEnabledId: null,
    ideaDragId: null,
    ideaDragOverId: null,
    ideaDropPlacement: "after",
  };
}

function getContextMenuState() {
  if (!state.contextMenu) {
    state.contextMenu = createDefaultContextMenuState();
  }
  return state.contextMenu;
}

function isContextMenuBoundToTerminal(terminalId) {
  return Boolean(terminalId) && getContextMenuState().terminalId === terminalId;
}

function getTerminalCardById(terminalId) {
  return terminalId ? document.getElementById(`card-${terminalId}`) : null;
}

function isContextMenuEditableTarget(target) {
  return Boolean(target?.closest("input, textarea, [contenteditable='true']"));
}

function isKeyboardShortcutEditableTarget(target) {
  return Boolean(target?.closest("input, textarea, select, button, a[href], summary, [contenteditable='true'], [role='button'], [tabindex]:not([tabindex='-1'])"));
}

function syncViewModeButtons() {
  viewModeButtons.forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.view === state.viewMode);
  });
}

function setViewMode(mode) {
  if (!VIEW_MODE_SEQUENCE.includes(mode) || mode === state.viewMode) {
    return false;
  }
  state.viewMode = mode;
  localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  syncViewModeButtons();
  state._needFullRefresh = true;
  scheduleRender();
  return true;
}

function toggleViewMode() {
  const nextMode = state.viewMode === "brief" ? "live" : "brief";
  return setViewMode(nextMode);
}

function getContextMenuHideLabel(record) {
  return isTerminalHidden(record) ? "取消隐藏" : "隐藏终端";
}

function getContextMenuMuteLabel(record) {
  return state.mutedTerminalIds.has(record?.id) ? "取消静默" : "静默队列";
}

function getContextMenuPrimaryLabel(record) {
  return record?.isPrimary ? "取消最重要任务" : "标记为最重要任务";
}

function getRecordTags(record) {
  return Array.isArray(record?.tags) ? record.tags : [];
}

function getCandidateTags(record) {
  const currentTags = new Set(getRecordTags(record));
  return state.allTags.filter((tag) => !currentTags.has(tag));
}

function normalizeIdeaText(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeIdeaFolderPath(folderPath) {
  return String(folderPath || "").trim().replace(/\/+$/, "");
}

function getIdeaFolderKey(folderPath) {
  const normalizedPath = normalizeIdeaFolderPath(folderPath);
  return normalizedPath || DEFAULT_IDEA_FOLDER_KEY;
}

function getIdeaFolderName(folderPath, fallbackName = "") {
  const normalizedPath = normalizeIdeaFolderPath(folderPath);
  if (normalizedPath) {
    return getSummaryFolderName(normalizedPath);
  }
  return normalizeIdeaText(fallbackName) || DEFAULT_IDEA_FOLDER_NAME;
}

function getIdeaFolderFromRecord(record) {
  const folderPath = getSummaryFolderPath(record);
  return {
    key: getIdeaFolderKey(folderPath),
    folderPath,
    folderName: getIdeaFolderName(folderPath),
  };
}

function normalizeSavedIdeas(items) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .filter((item) => item && typeof item === "object")
    .map((item, index) => {
      const text = normalizeIdeaText(item.text);
      if (!text) {
        return null;
      }
      const folderPath = normalizeIdeaFolderPath(item.folderPath);
      return {
        id: typeof item.id === "string" && item.id ? item.id : `idea-${index}`,
        text,
        folderPath,
        folderName: getIdeaFolderName(folderPath, item.folderName),
        createdAt: typeof item.createdAt === "string" && item.createdAt
          ? item.createdAt
          : new Date().toISOString(),
      };
    })
    .filter(Boolean);
}

function createSavedIdea(text, folder = {}) {
  const folderPath = normalizeIdeaFolderPath(folder.folderPath);
  return {
    id: `idea-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    text: normalizeIdeaText(text),
    folderPath,
    folderName: getIdeaFolderName(folderPath, folder.folderName),
    createdAt: new Date().toISOString(),
  };
}

function loadSavedIdeas() {
  try {
    const raw = window.localStorage.getItem(SAVED_IDEAS_STORAGE_KEY);
    state.savedIdeas = normalizeSavedIdeas(raw ? JSON.parse(raw) : []);
  } catch {
    state.savedIdeas = [];
  }
}

function persistSavedIdeas() {
  try {
    window.localStorage.setItem(SAVED_IDEAS_STORAGE_KEY, JSON.stringify(state.savedIdeas));
  } catch {
  }
}

function getSavedIdeaById(ideaId) {
  return state.savedIdeas.find((idea) => idea.id === ideaId) || null;
}

function getSavedIdeasForFolder(folderKey) {
  const key = folderKey || DEFAULT_IDEA_FOLDER_KEY;
  return state.savedIdeas.filter((idea) => getIdeaFolderKey(idea.folderPath) === key);
}

function countSavedIdeasForFolder(folderKey) {
  return getSavedIdeasForFolder(folderKey).length;
}

function getIdeaDialogState() {
  if (!state.ideaDialog) {
    state.ideaDialog = {
      selectedFolderKey: null,
      draft: "",
      editingId: null,
      editDraft: "",
      dragEnabledId: null,
      dragId: null,
      dragOverId: null,
      dropPlacement: "after",
    };
  }
  return state.ideaDialog;
}

function clearContextMenuIdeaEditState() {
  const contextMenuState = getContextMenuState();
  contextMenuState.ideaEditingId = null;
  contextMenuState.ideaEditDraft = "";
}

function beginIdeaEditing(ideaId) {
  const idea = getSavedIdeaById(ideaId);
  if (!idea) {
    return;
  }
  const contextMenuState = getContextMenuState();
  contextMenuState.ideaEditingId = idea.id;
  contextMenuState.ideaEditDraft = idea.text;
  renderOpenTerminalContextMenu();
  focusContextMenuField("idea-edit");
}

function addIdeaFolderToMap(foldersByKey, folderPath, options = {}) {
  const normalizedPath = normalizeIdeaFolderPath(folderPath);
  const key = getIdeaFolderKey(normalizedPath);
  const existing = foldersByKey.get(key);
  if (existing) {
    if (options.terminal) {
      existing.terminalCount += 1;
    }
    if (options.idea) {
      existing.ideaCount += 1;
    }
    return existing;
  }
  const folder = {
    key,
    folderPath: normalizedPath,
    folderName: getIdeaFolderName(normalizedPath, options.folderName),
    terminalCount: options.terminal ? 1 : 0,
    ideaCount: options.idea ? 1 : 0,
  };
  foldersByKey.set(key, folder);
  return folder;
}

function buildIdeaFolders() {
  const foldersByKey = new Map();
  for (const record of state.terminals.values()) {
    addIdeaFolderToMap(foldersByKey, getSummaryFolderPath(record), { terminal: true });
  }
  for (const idea of state.savedIdeas) {
    addIdeaFolderToMap(foldersByKey, idea.folderPath, {
      idea: true,
      folderName: idea.folderName,
    });
  }
  if (foldersByKey.size === 0) {
    addIdeaFolderToMap(foldersByKey, "");
  }
  return [...foldersByKey.values()].sort((a, b) => {
    const aUnfiled = a.key === DEFAULT_IDEA_FOLDER_KEY;
    const bUnfiled = b.key === DEFAULT_IDEA_FOLDER_KEY;
    if (aUnfiled !== bUnfiled) {
      return aUnfiled ? 1 : -1;
    }
    if (a.terminalCount !== b.terminalCount) {
      return b.terminalCount - a.terminalCount;
    }
    return a.folderName.localeCompare(b.folderName, "zh-Hans-CN", { numeric: true });
  });
}

function ensureIdeaDialogFolder(preferredFolderKey = null) {
  const dialogState = getIdeaDialogState();
  const folders = buildIdeaFolders();
  const requestedKey = preferredFolderKey || dialogState.selectedFolderKey;
  const selectedFolder = folders.find((folder) => folder.key === requestedKey) || folders[0];
  dialogState.selectedFolderKey = selectedFolder?.key || DEFAULT_IDEA_FOLDER_KEY;
  return {
    folders,
    selectedFolder: selectedFolder || {
      key: DEFAULT_IDEA_FOLDER_KEY,
      folderPath: "",
      folderName: DEFAULT_IDEA_FOLDER_NAME,
      terminalCount: 0,
      ideaCount: 0,
    },
  };
}

function formatIdeaCreatedAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function renderIdeaFolderButton(folder, selectedKey) {
  const isSelected = folder.key === selectedKey;
  const activeBadge = folder.terminalCount > 0
    ? `<span class="idea-folder-active">${folder.terminalCount} 个终端</span>`
    : "";
  return `
    <button
      type="button"
      class="idea-folder-item${isSelected ? " is-active" : ""}"
      data-idea-folder-key="${escapeHtml(folder.key)}"
      aria-pressed="${isSelected ? "true" : "false"}"
    >
      <span class="idea-folder-main">
        <span class="idea-folder-name">${escapeHtml(folder.folderName)}</span>
        <span class="idea-folder-count">${folder.ideaCount}</span>
      </span>
      <span class="idea-folder-path">${escapeHtml(folder.folderPath || "未归属项目")}</span>
      ${activeBadge}
    </button>
  `;
}

function renderIdeaDialogIdeaRow(idea, dialogState, options = {}) {
  const isEditing = idea.id === dialogState.editingId;
  const createdAt = formatIdeaCreatedAt(idea.createdAt);
  const isFirst = Boolean(options.isFirst);
  const isLast = Boolean(options.isLast);
  const moveUpDisabledAttr = isFirst ? " disabled" : "";
  const moveDownDisabledAttr = isLast ? " disabled" : "";
  return `
    <div class="idea-dialog-idea-row" data-idea-row data-idea-id="${escapeHtml(idea.id)}" draggable="false">
      <button
        type="button"
        class="idea-dialog-drag-handle"
        data-idea-drag-handle="${escapeHtml(idea.id)}"
        aria-label="拖拽排序 ${escapeHtml(idea.text)}"
        title="拖拽排序"
      >
        ≡
      </button>
      <div class="idea-dialog-idea-copy" title="${escapeHtml(idea.text)}">
        <div class="idea-dialog-idea-text">${escapeHtml(idea.text)}</div>
        ${createdAt ? `<div class="idea-dialog-idea-time">${escapeHtml(createdAt)}</div>` : ""}
      </div>
      <div class="idea-dialog-idea-actions">
        <button type="button" class="idea-dialog-button idea-dialog-icon-button" data-idea-move-up="${escapeHtml(idea.id)}" aria-label="上移这条想法" title="上移"${moveUpDisabledAttr}>↑</button>
        <button type="button" class="idea-dialog-button idea-dialog-icon-button" data-idea-move-down="${escapeHtml(idea.id)}" aria-label="下移这条想法" title="下移"${moveDownDisabledAttr}>↓</button>
        <button type="button" class="idea-dialog-button" data-idea-copy="${escapeHtml(idea.id)}">复制</button>
        <button type="button" class="idea-dialog-button${isEditing ? " is-active" : ""}" data-idea-edit="${escapeHtml(idea.id)}">编辑</button>
        <button type="button" class="idea-dialog-button is-destructive" data-idea-delete="${escapeHtml(idea.id)}">删除</button>
      </div>
    </div>
  `;
}

function renderIdeaDialog() {
  if (!ideaDialogContent) {
    return;
  }
  const dialogState = getIdeaDialogState();
  const { folders, selectedFolder } = ensureIdeaDialogFolder();
  const ideas = getSavedIdeasForFolder(selectedFolder.key);
  const createDisabledAttr = dialogState.editingId ? " disabled" : "";
  const sharedActionsMarkup = dialogState.editingId
    ? `
      <button type="button" class="idea-dialog-button is-primary" data-idea-save-shared-edit>保存编辑</button>
      <button type="button" class="idea-dialog-button" data-idea-shared-cancel>取消</button>
    `
    : "";
  const ideasMarkup = ideas.length > 0
    ? ideas.map((idea, index) => renderIdeaDialogIdeaRow(idea, dialogState, {
      isFirst: index === 0,
      isLast: index === ideas.length - 1,
    })).join("")
    : '<div class="idea-dialog-empty">这个项目还没有想法</div>';
  ideaDialogContent.innerHTML = `
    <div class="idea-dialog-layout">
      <aside class="idea-folder-pane" aria-label="项目列表">
        <div class="idea-pane-title">项目</div>
        <div class="idea-folder-list">
          ${folders.map((folder) => renderIdeaFolderButton(folder, selectedFolder.key)).join("")}
        </div>
      </aside>
      <section class="idea-list-pane" aria-label="想法列表">
        <div class="idea-list-header">
          <div class="idea-list-title-wrap">
            <div class="idea-list-kicker">想法</div>
            <h3 class="idea-list-title">${escapeHtml(selectedFolder.folderName)}</h3>
            <div class="idea-list-path">${escapeHtml(selectedFolder.folderPath || "未归属项目")}</div>
          </div>
          <span class="idea-list-count">${ideas.length} 条</span>
        </div>
        <form class="idea-dialog-form" data-idea-form="add">
          <label class="idea-dialog-field">
            <textarea
              class="idea-dialog-input"
              name="idea"
              data-idea-input="draft"
              rows="4"
              placeholder="输入想法，可换行记录"
            >${escapeHtml(dialogState.draft)}</textarea>
          </label>
          <div class="idea-dialog-form-actions">
            ${sharedActionsMarkup}
            <button type="submit" class="idea-dialog-submit"${createDisabledAttr}>创建想法</button>
          </div>
        </form>
        <div class="idea-dialog-ideas" data-idea-list>
          ${ideasMarkup}
        </div>
      </section>
    </div>
  `;
}

function flashPressedButton(button) {
  if (!button || button.disabled) {
    return;
  }
  button.classList.add("is-pressed");
  window.setTimeout(() => {
    button.classList.remove("is-pressed");
  }, 260);
}

function bindPressedButtonFeedback(root, selector) {
  if (!root) {
    return;
  }
  let pressedButton = null;
  const clearPressedButton = () => {
    if (!pressedButton) {
      return;
    }
    const button = pressedButton;
    pressedButton = null;
    window.setTimeout(() => {
      button.classList.remove("is-pressed");
    }, 120);
  };

  root.addEventListener("pointerdown", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest(selector);
    if (!button || button.disabled) {
      return;
    }
    pressedButton?.classList.remove("is-pressed");
    pressedButton = button;
    button.classList.add("is-pressed");
  });
  root.addEventListener("pointerup", clearPressedButton);
  root.addEventListener("pointercancel", clearPressedButton);
  root.addEventListener("pointerleave", clearPressedButton);
}

function isIdeaDialogOpen() {
  return Boolean(ideaDialog?.open);
}

function focusIdeaDialogField(kind = "draft") {
  const selector = kind === "edit"
    ? "[data-idea-input='edit']"
    : "[data-idea-input='draft']";
  window.requestAnimationFrame(() => {
    const field = ideaDialog?.querySelector(selector);
    if (!field) {
      return;
    }
    field.focus();
    if (typeof field.select === "function") {
      field.select();
    }
  });
}

function clearIdeaDialogEditState() {
  const dialogState = getIdeaDialogState();
  dialogState.editingId = null;
  dialogState.editDraft = "";
}

function clearIdeaDialogDropIndicator() {
  if (!ideaDialogContent) {
    return;
  }
  ideaDialogContent
    .querySelectorAll("[data-idea-row]")
    .forEach((row) => row.classList.remove("is-dragging", "is-drop-before", "is-drop-after"));
  ideaDialogContent
    .querySelector("[data-idea-list]")
    ?.classList.remove("is-drop-at-end");
}

function syncIdeaDialogDropIndicator(targetIdeaId = null, placement = "after") {
  clearIdeaDialogDropIndicator();
  const dialogState = getIdeaDialogState();
  dialogState.dragOverId = targetIdeaId;
  dialogState.dropPlacement = placement;
  if (!ideaDialogContent) {
    return;
  }
  if (!targetIdeaId) {
    if (state.savedIdeas.length > 0) {
      ideaDialogContent
        .querySelector("[data-idea-list]")
        ?.classList.add("is-drop-at-end");
    }
    return;
  }
  const targetRow = [...ideaDialogContent.querySelectorAll("[data-idea-row]")]
    .find((row) => row.dataset.ideaId === targetIdeaId);
  if (!targetRow) {
    return;
  }
  targetRow.classList.add(placement === "before" ? "is-drop-before" : "is-drop-after");
}

function clearIdeaDialogDragState() {
  const dialogState = getIdeaDialogState();
  dialogState.dragEnabledId = null;
  dialogState.dragId = null;
  dialogState.dragOverId = null;
  dialogState.dropPlacement = "after";
  if (!ideaDialogContent) {
    return;
  }
  ideaDialogContent
    .querySelectorAll("[data-idea-row]")
    .forEach((row) => row.setAttribute("draggable", "false"));
  clearIdeaDialogDropIndicator();
}

function clearIdeaDialogSelectionState(options = {}) {
  clearIdeaDialogEditState();
  clearIdeaDialogDragState();
  if (options.clearDraft) {
    getIdeaDialogState().draft = "";
  }
}

function openIdeaDialog(record = null, options = {}) {
  if (!ideaDialog) {
    return;
  }
  closeAllTopbarMenus();
  const dialogState = getIdeaDialogState();
  const folder = record ? getIdeaFolderFromRecord(record) : null;
  dialogState.selectedFolderKey = options.folderKey || folder?.key || dialogState.selectedFolderKey;
  dialogState.draft = "";
  clearIdeaDialogEditState();
  renderIdeaDialog();
  if (typeof ideaDialog.showModal === "function") {
    if (!ideaDialog.open) {
      ideaDialog.showModal();
    }
  } else {
    ideaDialog.setAttribute("open", "");
  }
  if (options.mode === "create") {
    focusIdeaDialogField("draft");
  }
}

function closeIdeaDialog() {
  if (!ideaDialog || !isIdeaDialogOpen()) {
    return;
  }
  if (typeof ideaDialog.close === "function") {
    ideaDialog.close();
  } else {
    ideaDialog.removeAttribute("open");
  }
}

function beginIdeaDialogEditing(ideaId) {
  const idea = getSavedIdeaById(ideaId);
  if (!idea) {
    return;
  }
  const dialogState = getIdeaDialogState();
  dialogState.editingId = idea.id;
  dialogState.editDraft = "";
  dialogState.draft = idea.text;
  renderIdeaDialog();
  focusIdeaDialogField("draft");
}

function moveSavedIdeaInFolder(ideaId, folderKey, direction) {
  const ideas = getSavedIdeasForFolder(folderKey);
  const currentIndex = ideas.findIndex((idea) => idea.id === ideaId);
  if (currentIndex === -1) {
    return false;
  }
  const targetIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
  const targetIdea = ideas[targetIndex];
  if (!targetIdea) {
    return false;
  }
  return reorderSavedIdeas(
    ideaId,
    targetIdea.id,
    direction === "up" ? "before" : "after",
  );
}

function bindIdeaDialog() {
  if (!ideaDialog || !ideaDialogContent) {
    return;
  }
  ideaDialogClose?.addEventListener("click", () => {
    closeIdeaDialog();
  });
  ideaDialog.addEventListener("click", (event) => {
    if (event.target === ideaDialog) {
      closeIdeaDialog();
    }
  });
  ideaDialog.addEventListener("close", () => {
    const dialogState = getIdeaDialogState();
    dialogState.draft = "";
    clearIdeaDialogSelectionState();
  });
  bindPressedButtonFeedback(ideaDialogContent, ".idea-dialog-button, .idea-dialog-submit");
  ideaDialogContent.addEventListener("click", async (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) {
      return;
    }
    const actionButton = target.closest(".idea-dialog-button");
    if (actionButton) {
      flashPressedButton(actionButton);
    }
    const folderButton = target.closest("[data-idea-folder-key]");
    if (folderButton) {
      const dialogState = getIdeaDialogState();
      dialogState.selectedFolderKey = folderButton.dataset.ideaFolderKey;
      dialogState.draft = "";
      clearIdeaDialogSelectionState();
      renderIdeaDialog();
      focusIdeaDialogField("draft");
      return;
    }
    const saveSharedEditButton = target.closest("[data-idea-save-shared-edit]");
    if (saveSharedEditButton) {
      const dialogState = getIdeaDialogState();
      const ideaId = dialogState.editingId;
      const nextText = normalizeIdeaText(dialogState.draft);
      if (!ideaId || !nextText) {
        focusIdeaDialogField("draft");
        return;
      }
      state.savedIdeas = state.savedIdeas.map((idea) => (
        idea.id === ideaId ? { ...idea, text: nextText } : idea
      ));
      clearIdeaDialogEditState();
      dialogState.draft = "";
      persistSavedIdeas();
      renderIdeaDialog();
      focusIdeaDialogField("draft");
      setMessage("想法已更新");
      return;
    }
    const cancelSharedButton = target.closest("[data-idea-shared-cancel]");
    if (cancelSharedButton) {
      clearIdeaDialogSelectionState({ clearDraft: true });
      renderIdeaDialog();
      focusIdeaDialogField("draft");
      return;
    }
    const copyButton = target.closest("[data-idea-copy]");
    if (copyButton) {
      const idea = getSavedIdeaById(copyButton.dataset.ideaCopy);
      if (!idea) {
        return;
      }
      try {
        await copyTextToClipboard(idea.text);
        setMessage("想法已复制，可直接发给 Codex");
      } catch (error) {
        setMessage(error.message, true);
      }
      return;
    }
    const moveUpButton = target.closest("[data-idea-move-up]");
    if (moveUpButton) {
      const dialogState = getIdeaDialogState();
      const changed = moveSavedIdeaInFolder(moveUpButton.dataset.ideaMoveUp, dialogState.selectedFolderKey, "up");
      if (changed) {
        clearIdeaDialogDragState();
        renderIdeaDialog();
        setMessage("想法顺序已更新");
      }
      return;
    }
    const moveDownButton = target.closest("[data-idea-move-down]");
    if (moveDownButton) {
      const dialogState = getIdeaDialogState();
      const changed = moveSavedIdeaInFolder(moveDownButton.dataset.ideaMoveDown, dialogState.selectedFolderKey, "down");
      if (changed) {
        clearIdeaDialogDragState();
        renderIdeaDialog();
        setMessage("想法顺序已更新");
      }
      return;
    }
    const editButton = target.closest("[data-idea-edit]");
    if (editButton) {
      beginIdeaDialogEditing(editButton.dataset.ideaEdit);
      return;
    }
    const deleteButton = target.closest("[data-idea-delete]");
    if (deleteButton) {
      const ideaId = deleteButton.dataset.ideaDelete;
      const nextIdeas = state.savedIdeas.filter((idea) => idea.id !== ideaId);
      if (nextIdeas.length === state.savedIdeas.length) {
        return;
      }
      const wasEditingSelection = getIdeaDialogState().editingId === ideaId;
      state.savedIdeas = nextIdeas;
      if (getIdeaDialogState().editingId === ideaId) {
        clearIdeaDialogEditState();
      }
      if (wasEditingSelection) {
        getIdeaDialogState().draft = "";
      }
      persistSavedIdeas();
      renderIdeaDialog();
      setMessage("想法已删除");
    }
  });
  ideaDialogContent.addEventListener("input", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const input = target?.closest("[data-idea-input]");
    if (!input) {
      return;
    }
    const dialogState = getIdeaDialogState();
    if (input.dataset.ideaInput === "draft") {
      dialogState.draft = input.value;
    }
    if (input.dataset.ideaInput === "edit") {
      dialogState.editingId = input.dataset.ideaId || dialogState.editingId;
      dialogState.editDraft = input.value;
    }
  });
  ideaDialogContent.addEventListener("submit", (event) => {
    event.preventDefault();
    const target = event.target instanceof Element ? event.target : null;
    const form = target?.closest("[data-idea-form]");
    if (!form) {
      return;
    }
    const submitButton = event.submitter instanceof HTMLButtonElement
      ? event.submitter
      : form.querySelector(".idea-dialog-submit");
    flashPressedButton(submitButton);
    const dialogState = getIdeaDialogState();
    if (form.dataset.ideaForm === "add") {
      if (dialogState.editingId) {
        focusIdeaDialogField("draft");
        return;
      }
      const nextText = normalizeIdeaText(dialogState.draft);
      if (!nextText) {
        focusIdeaDialogField("draft");
        return;
      }
      const { selectedFolder } = ensureIdeaDialogFolder();
      const newIdea = createSavedIdea(nextText, selectedFolder);
      state.savedIdeas.unshift(newIdea);
      dialogState.draft = "";
      persistSavedIdeas();
      renderIdeaDialog();
      focusIdeaDialogField("draft");
      setMessage("想法已保存");
      return;
    }
    if (form.dataset.ideaForm === "edit") {
      const ideaId = form.dataset.ideaId;
      const nextText = normalizeIdeaText(dialogState.editDraft);
      if (!nextText) {
        focusIdeaDialogField("edit");
        return;
      }
      state.savedIdeas = state.savedIdeas.map((idea) => (
        idea.id === ideaId ? { ...idea, text: nextText } : idea
      ));
      persistSavedIdeas();
      clearIdeaDialogEditState();
      dialogState.draft = "";
      renderIdeaDialog();
      focusIdeaDialogField("draft");
      setMessage("想法已更新");
    }
  });
  ideaDialogContent.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !getIdeaDialogState().editingId) {
      return;
    }
    event.preventDefault();
    clearIdeaDialogEditState();
    renderIdeaDialog();
    focusIdeaDialogField("draft");
  });
  ideaDialogContent.addEventListener("pointerdown", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const handle = target?.closest("[data-idea-drag-handle]");
    if (!handle) {
      return;
    }
    const row = handle.closest("[data-idea-row]");
    if (!row) {
      return;
    }
    const dialogState = getIdeaDialogState();
    dialogState.dragEnabledId = row.dataset.ideaId;
    row.setAttribute("draggable", "true");
  });
  ideaDialogContent.addEventListener("pointerup", () => {
    if (getIdeaDialogState().dragId) {
      return;
    }
    ideaDialogContent
      .querySelectorAll("[data-idea-row]")
      .forEach((row) => row.setAttribute("draggable", "false"));
    getIdeaDialogState().dragEnabledId = null;
  });
  ideaDialogContent.addEventListener("pointercancel", () => {
    if (getIdeaDialogState().dragId) {
      return;
    }
    ideaDialogContent
      .querySelectorAll("[data-idea-row]")
      .forEach((row) => row.setAttribute("draggable", "false"));
    getIdeaDialogState().dragEnabledId = null;
  });
  ideaDialogContent.addEventListener("dragstart", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const row = target?.closest("[data-idea-row]");
    if (!row) {
      return;
    }
    const dialogState = getIdeaDialogState();
    const ideaId = row.dataset.ideaId;
    if (!ideaId || dialogState.dragEnabledId !== ideaId) {
      event.preventDefault();
      return;
    }
    dialogState.dragId = ideaId;
    row.classList.add("is-dragging");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", ideaId);
    }
  });
  ideaDialogContent.addEventListener("dragover", (event) => {
    const dialogState = getIdeaDialogState();
    if (!dialogState.dragId) {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    const list = target?.closest("[data-idea-list]");
    if (!list) {
      return;
    }
    event.preventDefault();
    const row = target.closest("[data-idea-row]");
    if (!row) {
      syncIdeaDialogDropIndicator(null, "after");
      return;
    }
    if (row.dataset.ideaId === dialogState.dragId) {
      clearIdeaDialogDropIndicator();
      return;
    }
    const rect = row.getBoundingClientRect();
    const placement = event.clientY <= rect.top + rect.height / 2 ? "before" : "after";
    syncIdeaDialogDropIndicator(row.dataset.ideaId, placement);
  });
  ideaDialogContent.addEventListener("drop", (event) => {
    const dialogState = getIdeaDialogState();
    if (!dialogState.dragId) {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    const list = target?.closest("[data-idea-list]");
    if (!list) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const row = target.closest("[data-idea-row]");
    const targetIdeaId = row?.dataset.ideaId || null;
    if (targetIdeaId === dialogState.dragId) {
      clearIdeaDialogDragState();
      return;
    }
    const placement = targetIdeaId && targetIdeaId !== dialogState.dragId
      ? dialogState.dropPlacement || "after"
      : "after";
    const changed = reorderSavedIdeas(
      dialogState.dragId,
      targetIdeaId && targetIdeaId !== dialogState.dragId ? targetIdeaId : null,
      placement,
    );
    clearIdeaDialogDragState();
    if (changed) {
      renderIdeaDialog();
      setMessage("想法顺序已更新");
    }
  });
  ideaDialogContent.addEventListener("dragend", () => {
    clearIdeaDialogDragState();
  });
}

function clearIdeaDropIndicator() {
  if (!terminalContextMenu) {
    return;
  }
  terminalContextMenu
    .querySelectorAll("[data-context-idea-row]")
    .forEach((row) => row.classList.remove("is-dragging", "is-drop-before", "is-drop-after"));
  terminalContextMenu
    .querySelector("[data-context-idea-list]")
    ?.classList.remove("is-drop-at-end");
}

function syncIdeaDropIndicator(targetIdeaId = null, placement = "after") {
  clearIdeaDropIndicator();
  const contextMenuState = getContextMenuState();
  contextMenuState.ideaDragOverId = targetIdeaId;
  contextMenuState.ideaDropPlacement = placement;
  if (!terminalContextMenu) {
    return;
  }
  if (!targetIdeaId) {
    if (state.savedIdeas.length > 0) {
      terminalContextMenu
        .querySelector("[data-context-idea-list]")
        ?.classList.add("is-drop-at-end");
    }
    return;
  }
  const targetRow = [...terminalContextMenu.querySelectorAll("[data-context-idea-row]")]
    .find((row) => row.dataset.ideaId === targetIdeaId);
  if (!targetRow) {
    return;
  }
  targetRow.classList.add(placement === "before" ? "is-drop-before" : "is-drop-after");
}

function clearContextMenuIdeaDragState() {
  const contextMenuState = getContextMenuState();
  contextMenuState.ideaDragEnabledId = null;
  contextMenuState.ideaDragId = null;
  contextMenuState.ideaDragOverId = null;
  contextMenuState.ideaDropPlacement = "after";
  if (!terminalContextMenu) {
    return;
  }
  terminalContextMenu
    .querySelectorAll("[data-context-idea-row]")
    .forEach((row) => row.setAttribute("draggable", "false"));
  clearIdeaDropIndicator();
}

function reorderSavedIdeas(draggedIdeaId, targetIdeaId = null, placement = "after") {
  const fromIndex = state.savedIdeas.findIndex((idea) => idea.id === draggedIdeaId);
  if (fromIndex === -1) {
    return false;
  }
  const nextIdeas = [...state.savedIdeas];
  const [draggedIdea] = nextIdeas.splice(fromIndex, 1);
  let insertIndex = nextIdeas.length;
  if (targetIdeaId) {
    const targetIndex = nextIdeas.findIndex((idea) => idea.id === targetIdeaId);
    if (targetIndex !== -1) {
      insertIndex = placement === "before" ? targetIndex : targetIndex + 1;
    }
  }
  nextIdeas.splice(insertIndex, 0, draggedIdea);
  const changed = nextIdeas.some((idea, index) => idea.id !== state.savedIdeas[index]?.id);
  if (!changed) {
    return false;
  }
  state.savedIdeas = nextIdeas;
  persistSavedIdeas();
  return true;
}

async function copyTextToClipboard(text) {
  const value = String(text || "");
  if (!value) {
    return;
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const fallback = document.createElement("textarea");
  fallback.value = value;
  fallback.setAttribute("readonly", "true");
  fallback.style.position = "fixed";
  fallback.style.top = "-9999px";
  fallback.style.opacity = "0";
  document.body.appendChild(fallback);
  fallback.focus();
  fallback.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(fallback);
  if (!copied) {
    throw new Error("复制失败，请手动复制");
  }
}

function renderTerminalContextMenuIcon(action, record) {
  const isHidden = isTerminalHidden(record);
  const isMuted = state.mutedTerminalIds.has(record?.id);
  const isPrimary = Boolean(record?.isPrimary);
  const iconMap = {
    rename: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"/>',
    "split-vertical": '<path d="M12 4v16"/><rect x="4.5" y="6" width="6.5" height="12" rx="1.5"/><rect x="13" y="6" width="6.5" height="12" rx="1.5"/>',
    "split-horizontal": '<path d="M4 12h16"/><rect x="6" y="4.5" width="12" height="6.5" rx="1.5"/><rect x="6" y="13" width="12" height="6.5" rx="1.5"/>',
    "set-default-frame": '<path d="M9 4.5h6l-1 4 3 2.5H7l3-2.5-1-4Z"/><path d="M12 11v8.5"/>',
    "apply-default-frame-all": '<rect x="4" y="5" width="6.5" height="5.5" rx="1"/><rect x="13.5" y="5" width="6.5" height="5.5" rx="1"/><rect x="4" y="13.5" width="6.5" height="5.5" rx="1"/><rect x="13.5" y="13.5" width="6.5" height="5.5" rx="1"/>',
    "toggle-primary": isPrimary
      ? '<path d="M12 4.5 14.2 9l5 .7-3.6 3.5.85 5-4.45-2.35-4.45 2.35.85-5L4.8 9.7l5-.7L12 4.5Z"/><path d="M9.2 9.8h5.6"/><path d="M10.4 12.5h3.2"/>'
      : '<path d="M12 4.5 14.2 9l5 .7-3.6 3.5.85 5-4.45-2.35-4.45 2.35.85-5L4.8 9.7l5-.7L12 4.5Z"/>',
    "toggle-hide": isHidden
      ? '<path d="M3.5 12s3-5 8.5-5 8.5 5 8.5 5-3 5-8.5 5-8.5-5-8.5-5Z"/><path d="M4.5 4.5 19.5 19.5"/>'
      : '<path d="M3.5 12s3-5 8.5-5 8.5 5 8.5 5-3 5-8.5 5-8.5-5-8.5-5Z"/><circle cx="12" cy="12" r="2.5"/>',
    "toggle-mute": isMuted
      ? '<path d="M6.5 9H4v6h2.5l4 3V6l-4 3Z"/><path d="M14.5 9.5 19 14"/><path d="M19 9.5 14.5 14"/>'
      : '<path d="M6.5 9H4v6h2.5l4 3V6l-4 3Z"/><path d="M15 9.5a4 4 0 0 1 0 5"/><path d="M17.5 7a7 7 0 0 1 0 10"/>',
    "create-idea": '<path d="M12 5v14"/><path d="M5 12h14"/><rect x="4.5" y="4.5" width="15" height="15" rx="2.5"/>',
    "view-ideas": '<path d="M5.5 6.5h13"/><path d="M5.5 11.5h13"/><path d="M5.5 16.5h8"/><rect x="3.5" y="4" width="17" height="16" rx="2.5"/>',
    detach: '<path d="M9 8.5 6.5 11a3 3 0 1 0 4.2 4.2l2.3-2.3"/><path d="m15 15.5 2.5-2.5a3 3 0 0 0-4.2-4.2L11 11.1"/><path d="M4.5 19.5 19.5 4.5"/>',
    close: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/><rect x="4.5" y="4.5" width="15" height="15" rx="2"/>',
  };
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      ${iconMap[action] || '<circle cx="12" cy="12" r="8.5"/>'}
    </svg>
  `;
}

function renderTerminalContextMenuItem(action, options = {}) {
  const className = options.destructive
    ? "terminal-context-menu-item is-destructive"
    : "terminal-context-menu-item";
  const disabledAttr = options.disabled ? " disabled" : "";
  const detail = options.detail
    ? `<span class="terminal-context-menu-item-detail">${escapeHtml(options.detail)}</span>`
    : "";
  const hintClass = options.hintTone
    ? `terminal-context-menu-item-hint is-${options.hintTone}`
    : "terminal-context-menu-item-hint";
  const hint = options.hint
    ? `<span class="${hintClass}">${escapeHtml(options.hint)}</span>`
    : "";
  return `
    <button type="button" class="${className}" data-context-action="${action}" role="menuitem"${disabledAttr}>
      <span class="terminal-context-menu-item-icon" aria-hidden="true">${options.icon || ""}</span>
      <span class="terminal-context-menu-item-copy">
        <span class="terminal-context-menu-item-label">${escapeHtml(options.label || "")}</span>
        ${detail}
      </span>
      ${hint}
    </button>
  `;
}

function renderTerminalContextMenuError(record) {
  if (!record.lastError) {
    return "";
  }
  return `
    <section class="terminal-context-menu-section terminal-context-menu-section--error" aria-label="错误信息">
      <div class="terminal-context-menu-section-title">最近错误</div>
      <div class="terminal-context-menu-error-box">${escapeHtml(record.lastError)}</div>
    </section>
  `;
}

function renderTerminalContextMenuTags(record, contextMenuState) {
  const tags = getRecordTags(record);
  const candidateTags = getCandidateTags(record);
  const tagDraft = contextMenuState.tagDraft || "";
  return `
    <section class="terminal-context-menu-section" aria-label="标签管理">
      <div class="terminal-context-menu-section-title">标签</div>
      <div class="terminal-context-menu-tags">
        ${tags.length > 0
          ? tags.map((tag) => `
              <button type="button" class="terminal-context-menu-tag" data-context-tag-remove="${escapeHtml(tag)}" aria-label="移除标签 ${escapeHtml(tag)}">
                <span>${escapeHtml(tag)}</span>
                <span class="terminal-context-menu-tag-remove" aria-hidden="true">×</span>
              </button>
            `).join("")
          : '<div class="terminal-context-menu-empty">当前没有标签</div>'}
      </div>
      ${candidateTags.length > 0 ? `
        <div class="terminal-context-menu-tag-candidates">
          ${candidateTags.map((tag) => `
            <button type="button" class="terminal-context-menu-candidate" data-context-tag-add="${escapeHtml(tag)}">+ ${escapeHtml(tag)}</button>
          `).join("")}
        </div>
      ` : ""}
      <form class="terminal-context-menu-form" data-context-form="tag">
        <label class="terminal-context-menu-field">
          <input
            class="terminal-context-menu-input"
            type="text"
            name="tag"
            data-context-input="tag"
            aria-label="新标签"
            value="${escapeHtml(tagDraft)}"
            placeholder="输入标签名后回车"
          />
        </label>
        <button type="submit" class="terminal-context-menu-submit">添加</button>
      </form>
    </section>
  `;
}

function renderTerminalContextMenuIdeas(contextMenuState) {
  const ideaDraft = contextMenuState.ideaDraft || "";
  const editingIdeaId = contextMenuState.ideaEditingId || "";
  const ideaEditDraft = contextMenuState.ideaEditDraft || "";
  const ideasMarkup = state.savedIdeas.length > 0
    ? state.savedIdeas.map((idea) => {
      const isEditing = idea.id === editingIdeaId;
      if (isEditing) {
        return `
          <form
            class="terminal-context-menu-idea-row terminal-context-menu-idea-row--editing"
            data-context-form="idea-edit"
            data-context-idea-row
            data-idea-id="${escapeHtml(idea.id)}"
          >
            <label class="terminal-context-menu-field">
              <input
                class="terminal-context-menu-input"
                type="text"
                name="idea-edit"
                data-context-input="idea-edit"
                data-idea-id="${escapeHtml(idea.id)}"
                value="${escapeHtml(ideaEditDraft)}"
                placeholder="修改这条想法"
              />
            </label>
            <div class="terminal-context-menu-idea-actions">
              <button type="submit" class="terminal-context-menu-idea-button is-primary">保存</button>
              <button type="button" class="terminal-context-menu-idea-button" data-context-idea-cancel="${escapeHtml(idea.id)}">取消</button>
            </div>
          </form>
        `;
      }
      return `
        <div
          class="terminal-context-menu-idea-row"
          data-context-idea-row
          data-idea-id="${escapeHtml(idea.id)}"
          draggable="false"
        >
          <button
            type="button"
            class="terminal-context-menu-idea-handle"
            data-context-idea-handle="${escapeHtml(idea.id)}"
            aria-label="拖拽排序 ${escapeHtml(idea.text)}"
            title="拖拽排序"
          >
            ≡
          </button>
          <div class="terminal-context-menu-idea-copy" title="${escapeHtml(idea.text)}">
            <div class="terminal-context-menu-idea-text">${escapeHtml(idea.text)}</div>
          </div>
          <div class="terminal-context-menu-idea-actions">
            <button type="button" class="terminal-context-menu-idea-button" data-context-idea-copy="${escapeHtml(idea.id)}">复制</button>
            <button type="button" class="terminal-context-menu-idea-button" data-context-idea-edit="${escapeHtml(idea.id)}">编辑</button>
            <button type="button" class="terminal-context-menu-idea-button is-destructive" data-context-idea-delete="${escapeHtml(idea.id)}">删除</button>
          </div>
        </div>
      `;
    }).join("")
    : '<div class="terminal-context-menu-empty">还没有记录想法</div>';

  return `
    <section class="terminal-context-menu-section" aria-label="想法列表">
      <div class="terminal-context-menu-section-title">想法</div>
      <form class="terminal-context-menu-form" data-context-form="idea-add">
        <label class="terminal-context-menu-field">
          <input
            class="terminal-context-menu-input"
            type="text"
            name="idea"
            data-context-input="idea"
            aria-label="想法"
            value="${escapeHtml(ideaDraft)}"
            placeholder="输入一个临时想法，回车即可保存"
          />
        </label>
        <button type="submit" class="terminal-context-menu-submit">保存</button>
      </form>
      <div class="terminal-context-menu-ideas" data-context-idea-list>
        ${ideasMarkup}
      </div>
      <div class="terminal-context-menu-footnote">拖到第一条，等会直接复制发给 Codex。</div>
    </section>
  `;
}

function buildTerminalContextMenuActions(record) {
  const isClosed = record.status === "closed";
  const isHidden = isTerminalHidden(record);
  const isMuted = state.mutedTerminalIds.has(record.id);
  const isPrimary = Boolean(record.isPrimary);
  const ideaFolder = getIdeaFolderFromRecord(record);
  const ideaCount = countSavedIdeasForFolder(ideaFolder.key);
  const actions = {
    rename: {
      label: "重命名",
      detail: "修改这个终端在监控墙和摘要里的显示名称",
    },
    "create-idea": {
      label: "创建想法",
      detail: `保存到 ${ideaFolder.folderName}`,
    },
    "view-ideas": {
      label: "查看想法",
      detail: ideaCount > 0 ? `查看 ${ideaFolder.folderName} 的想法` : `打开 ${ideaFolder.folderName} 的想法页`,
      hint: ideaCount > 0 ? `${ideaCount} 条` : "",
      hintTone: "neutral",
    },
    "split-vertical": {
      label: "垂直拆分",
      detail: "在右侧新增 pane，并继承当前目录",
      disabled: isClosed,
    },
    "split-horizontal": {
      label: "水平拆分",
      detail: "在下方新增 pane，并继承当前目录",
      disabled: isClosed,
    },
    "set-default-frame": {
      label: "记住当前位置",
      detail: "把这个 iTerm2 的窗口位置设为默认模板",
      disabled: isClosed,
    },
    "apply-default-frame-all": {
      label: "全部对齐",
      detail: "让所有终端对齐到当前默认窗口位置",
      disabled: isClosed,
    },
    "toggle-primary": {
      label: getContextMenuPrimaryLabel(record),
      detail: isPrimary ? "取消当前唯一主任务标记" : "设为当前唯一主任务，其他主任务会自动取消",
      hint: isPrimary ? "当前主任务" : "",
      hintTone: "neutral",
      disabled: isClosed,
    },
    "toggle-hide": {
      label: getContextMenuHideLabel(record),
      detail: isHidden ? "重新回到默认监控视图" : "从默认监控墙中暂时收起",
      hint: isHidden ? "已隐藏" : "",
      hintTone: "neutral",
    },
    "toggle-mute": {
      label: getContextMenuMuteLabel(record),
      detail: isMuted ? "恢复队列提醒与待处理提示" : "状态变化不再进入顶部队列",
      hint: isMuted ? "静默中" : "",
      hintTone: "neutral",
    },
    detach: {
      label: "解绑终端",
      detail: "从监控墙移除，但不关闭真实 iTerm2",
      disabled: isClosed,
      destructive: true,
    },
    close: {
      label: "关闭终端",
      detail: "关闭真实 iTerm2 窗口并从监控墙移除",
      disabled: isClosed,
      destructive: true,
    },
  };

  return Object.fromEntries(
    Object.entries(actions).map(([action, meta]) => [
      action,
      {
        ...meta,
        icon: renderTerminalContextMenuIcon(action, record),
      },
    ]),
  );
}

function renderTerminalContextMenuGroup(actions, actionMap) {
  return `
    <div class="terminal-context-menu-group">
      ${actions.map((action) => renderTerminalContextMenuItem(action, actionMap[action])).join("")}
    </div>
  `;
}

function buildTerminalContextMenuMarkup(record) {
  const program = getProgramInfo(record);
  const title = displayTitle(record);
  const actionMap = buildTerminalContextMenuActions(record);
  const contextMenuState = getContextMenuState();
  const groups = [
    ["rename", "create-idea", "view-ideas"],
    ["split-vertical", "split-horizontal"],
    ["set-default-frame", "apply-default-frame-all"],
    ["toggle-primary", "toggle-hide", "toggle-mute"],
    ["detach", "close"],
  ];

  return `
    <div class="terminal-context-menu-header">
      <div class="terminal-context-menu-identity">
        <span class="terminal-context-menu-status-dot" aria-hidden="true"></span>
        <div class="terminal-context-menu-header-copy">
          <div class="terminal-context-menu-title">${escapeHtml(title)}</div>
          <div class="terminal-context-menu-subtitle">${escapeHtml(program.label)}</div>
        </div>
        <span class="terminal-context-menu-status">${escapeHtml(statusLabel(record.status))}</span>
      </div>
    </div>
    ${groups.map((group, index) => `
      ${index > 0 ? '<div class="terminal-context-menu-divider"></div>' : ""}
      ${renderTerminalContextMenuGroup(group, actionMap)}
    `).join("")}
    <div class="terminal-context-menu-divider"></div>
    ${renderTerminalContextMenuError(record)}
    ${renderTerminalContextMenuTags(record, contextMenuState)}
  `;
}

function getContextMenuButtons() {
  if (!terminalContextMenu) {
    return [];
  }
  return [...terminalContextMenu.querySelectorAll(".terminal-context-menu-item:not([disabled])")];
}

function isTerminalContextMenuOpen() {
  return Boolean(terminalContextMenu) && !terminalContextMenu.hidden && Boolean(getContextMenuState().terminalId);
}

function closeTerminalContextMenu() {
  if (!terminalContextMenu || terminalContextMenu.hidden) {
    return;
  }
  state.contextMenu = createDefaultContextMenuState();
  terminalContextMenu.hidden = true;
  terminalContextMenu.innerHTML = "";
  terminalContextMenu.setAttribute("aria-hidden", "true");
  terminalContextMenu.removeAttribute("data-terminal-id");
  terminalContextMenu.removeAttribute("data-status");
  terminalContextMenu.style.left = "0px";
  terminalContextMenu.style.top = "0px";
  terminalContextMenu.style.visibility = "";
}

function focusContextMenuField(kind) {
  const selectorMap = {
    tag: "[data-context-input='tag']",
    idea: "[data-context-input='idea']",
    "idea-edit": "[data-context-input='idea-edit']",
  };
  const selector = selectorMap[kind] || null;
  if (!selector) {
    return;
  }
  window.requestAnimationFrame(() => {
    const field = terminalContextMenu?.querySelector(selector);
    if (!field) {
      return;
    }
    field.focus();
    if (typeof field.select === "function") {
      field.select();
    }
  });
}

function renderOpenTerminalContextMenu() {
  if (!terminalContextMenu) {
    return;
  }
  const contextMenuState = getContextMenuState();
  if (!contextMenuState.terminalId) {
    closeTerminalContextMenu();
    return;
  }
  const record = state.terminals.get(contextMenuState.terminalId);
  if (!record) {
    closeTerminalContextMenu();
    return;
  }
  terminalContextMenu.dataset.terminalId = record.id;
  terminalContextMenu.dataset.status = record.status;
  terminalContextMenu.innerHTML = buildTerminalContextMenuMarkup(record);
  terminalContextMenu.hidden = false;
  terminalContextMenu.setAttribute("aria-hidden", "false");
  terminalContextMenu.style.visibility = "hidden";
  positionTerminalContextMenu(contextMenuState.anchorX, contextMenuState.anchorY);
  terminalContextMenu.style.visibility = "";
}

function positionTerminalContextMenu(clientX, clientY) {
  if (!terminalContextMenu) {
    return;
  }
  const margin = 12;
  const { width, height } = terminalContextMenu.getBoundingClientRect();
  const maxX = Math.max(margin, window.innerWidth - width - margin);
  const maxY = Math.max(margin, window.innerHeight - height - margin);
  terminalContextMenu.style.left = `${Math.min(Math.max(clientX, margin), maxX)}px`;
  terminalContextMenu.style.top = `${Math.min(Math.max(clientY, margin), maxY)}px`;
}

function openTerminalContextMenu(record, clientX, clientY) {
  if (!terminalContextMenu || !record) {
    return;
  }
  closeAllTopbarMenus();
  state.contextMenu = {
    ...createDefaultContextMenuState(),
    terminalId: record.id,
    anchorX: clientX,
    anchorY: clientY,
  };
  renderOpenTerminalContextMenu();
  getContextMenuButtons()[0]?.focus();
}

function focusTerminalContextMenuItem(step) {
  const buttons = getContextMenuButtons();
  if (buttons.length === 0) {
    return;
  }
  const currentIndex = buttons.indexOf(document.activeElement);
  const nextIndex = currentIndex === -1
    ? 0
    : (currentIndex + step + buttons.length) % buttons.length;
  buttons[nextIndex]?.focus();
}

async function runTerminalContextMenuAction(action) {
  if (!terminalContextMenu) {
    return;
  }
  const { terminalId } = getContextMenuState();
  const record = state.terminals.get(terminalId);

  if (!record) {
    closeTerminalContextMenu();
    return;
  }

  try {
    switch (action) {
      case "create-idea":
        closeTerminalContextMenu();
        openIdeaDialog(record, { mode: "create" });
        break;
      case "view-ideas":
        closeTerminalContextMenu();
        openIdeaDialog(record, { mode: "view" });
        break;
      case "rename":
        closeTerminalContextMenu();
        await promptRenameTerminal(record);
        break;
      case "split-vertical":
        closeTerminalContextMenu();
        if (record.status !== "closed") {
          const result = await request(`/api/terminals/${record.id}/split`, {
            method: "POST",
            body: JSON.stringify({ direction: "vertical" }),
          });
          insertSplitTerminalIntoLayout(record.id, result.item, "right", result.layout || null);
          setMessage("已在右侧新增 split pane");
        }
        break;
      case "split-horizontal":
        closeTerminalContextMenu();
        if (record.status !== "closed") {
          const result = await request(`/api/terminals/${record.id}/split`, {
            method: "POST",
            body: JSON.stringify({ direction: "horizontal" }),
          });
          insertSplitTerminalIntoLayout(record.id, result.item, "bottom", result.layout || null);
          setMessage("已在下方新增 split pane");
        }
        break;
      case "set-default-frame":
        closeTerminalContextMenu();
        if (record.status !== "closed") {
          await setTerminalDefaultFrame(record);
        }
        break;
      case "apply-default-frame-all":
        closeTerminalContextMenu();
        if (record.status !== "closed") {
          await applyDefaultFrameToAll();
        }
        break;
      case "toggle-hide":
        closeTerminalContextMenu();
        await toggleTerminalHidden(record);
        break;
      case "toggle-primary":
        closeTerminalContextMenu();
        await toggleTerminalPrimary(record);
        break;
      case "toggle-mute":
        closeTerminalContextMenu();
        await toggleTerminalMuted(record);
        break;
      case "detach":
        closeTerminalContextMenu();
        if (record.status !== "closed") {
          await detachTerminal(record);
        }
        break;
      case "close":
        closeTerminalContextMenu();
        if (record.status !== "closed") {
          await closeTerminalRecord(record);
        }
        break;
      default:
        break;
    }
  } catch (error) {
    setMessage(error.message, true);
  }
}

function bindTerminalContextMenu() {
  if (!terminalContextMenu) {
    return;
  }

  terminalContextMenu.addEventListener("mousedown", (event) => {
    event.stopPropagation();
  });
  terminalContextMenu.addEventListener("click", async (event) => {
    const removeTagButton = event.target.closest("[data-context-tag-remove]");
    if (removeTagButton) {
      event.preventDefault();
      event.stopPropagation();
      const record = state.terminals.get(getContextMenuState().terminalId);
      if (!record) return;
      const tagToRemove = removeTagButton.dataset.contextTagRemove;
      const nextTags = getRecordTags(record).filter((tag) => tag !== tagToRemove);
      await updateTerminalTags(record, nextTags);
      renderOpenTerminalContextMenu();
      return;
    }
    const addTagButton = event.target.closest("[data-context-tag-add]");
    if (addTagButton) {
      event.preventDefault();
      event.stopPropagation();
      const record = state.terminals.get(getContextMenuState().terminalId);
      if (!record) return;
      const tagToAdd = addTagButton.dataset.contextTagAdd;
      const nextTags = [...getRecordTags(record), tagToAdd];
      await updateTerminalTags(record, nextTags);
      renderOpenTerminalContextMenu();
      return;
    }
    const copyIdeaButton = event.target.closest("[data-context-idea-copy]");
    if (copyIdeaButton) {
      event.preventDefault();
      event.stopPropagation();
      const idea = getSavedIdeaById(copyIdeaButton.dataset.contextIdeaCopy);
      if (!idea) return;
      try {
        await copyTextToClipboard(idea.text);
        setMessage("想法已复制，可直接发给 Codex");
      } catch (error) {
        setMessage(error.message, true);
      }
      return;
    }
    const editIdeaButton = event.target.closest("[data-context-idea-edit]");
    if (editIdeaButton) {
      event.preventDefault();
      event.stopPropagation();
      beginIdeaEditing(editIdeaButton.dataset.contextIdeaEdit);
      return;
    }
    const cancelIdeaButton = event.target.closest("[data-context-idea-cancel]");
    if (cancelIdeaButton) {
      event.preventDefault();
      event.stopPropagation();
      clearContextMenuIdeaEditState();
      renderOpenTerminalContextMenu();
      focusContextMenuField("idea");
      return;
    }
    const deleteIdeaButton = event.target.closest("[data-context-idea-delete]");
    if (deleteIdeaButton) {
      event.preventDefault();
      event.stopPropagation();
      const ideaId = deleteIdeaButton.dataset.contextIdeaDelete;
      const nextIdeas = state.savedIdeas.filter((idea) => idea.id !== ideaId);
      if (nextIdeas.length === state.savedIdeas.length) {
        return;
      }
      state.savedIdeas = nextIdeas;
      if (getContextMenuState().ideaEditingId === ideaId) {
        clearContextMenuIdeaEditState();
      }
      persistSavedIdeas();
      renderOpenTerminalContextMenu();
      setMessage("想法已删除");
      return;
    }
    const actionButton = event.target.closest("[data-context-action]");
    if (!actionButton) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    await runTerminalContextMenuAction(actionButton.dataset.contextAction);
  });
  terminalContextMenu.addEventListener("input", (event) => {
    const input = event.target.closest("[data-context-input]");
    if (!input) {
      return;
    }
    if (input.dataset.contextInput === "tag") {
      state.contextMenu.tagDraft = input.value;
    }
    if (input.dataset.contextInput === "idea") {
      state.contextMenu.ideaDraft = input.value;
    }
    if (input.dataset.contextInput === "idea-edit") {
      state.contextMenu.ideaEditingId = input.dataset.ideaId || state.contextMenu.ideaEditingId;
      state.contextMenu.ideaEditDraft = input.value;
    }
  });
  terminalContextMenu.addEventListener("submit", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const form = event.target.closest("[data-context-form]");
    if (!form) {
      return;
    }
    const record = state.terminals.get(getContextMenuState().terminalId);
    if (!record) {
      return;
    }
    if (form.dataset.contextForm === "tag") {
      const newTag = state.contextMenu.tagDraft.trim();
      if (!newTag) {
        focusContextMenuField("tag");
        return;
      }
      const currentTags = getRecordTags(record);
      if (!currentTags.includes(newTag)) {
        await updateTerminalTags(record, [...currentTags, newTag]);
      }
      state.contextMenu.tagDraft = "";
      renderOpenTerminalContextMenu();
      focusContextMenuField("tag");
      return;
    }
    if (form.dataset.contextForm === "idea-add") {
      const nextText = normalizeIdeaText(state.contextMenu.ideaDraft);
      if (!nextText) {
        focusContextMenuField("idea");
        return;
      }
      state.savedIdeas.unshift(createSavedIdea(nextText));
      persistSavedIdeas();
      state.contextMenu.ideaDraft = "";
      renderOpenTerminalContextMenu();
      focusContextMenuField("idea");
      setMessage("想法已保存");
      return;
    }
    if (form.dataset.contextForm === "idea-edit") {
      const ideaId = form.dataset.ideaId;
      const nextText = normalizeIdeaText(state.contextMenu.ideaEditDraft);
      if (!nextText) {
        focusContextMenuField("idea-edit");
        return;
      }
      state.savedIdeas = state.savedIdeas.map((idea) => (
        idea.id === ideaId ? { ...idea, text: nextText } : idea
      ));
      persistSavedIdeas();
      clearContextMenuIdeaEditState();
      renderOpenTerminalContextMenu();
      focusContextMenuField("idea");
      setMessage("想法已更新");
    }
  });
  terminalContextMenu.addEventListener("pointerdown", (event) => {
    const handle = event.target.closest("[data-context-idea-handle]");
    if (!handle) {
      return;
    }
    const row = handle.closest("[data-context-idea-row]");
    if (!row) {
      return;
    }
    state.contextMenu.ideaDragEnabledId = row.dataset.ideaId;
    row.setAttribute("draggable", "true");
  });
  terminalContextMenu.addEventListener("pointerup", () => {
    if (getContextMenuState().ideaDragId) {
      return;
    }
    terminalContextMenu
      .querySelectorAll("[data-context-idea-row]")
      .forEach((row) => row.setAttribute("draggable", "false"));
    state.contextMenu.ideaDragEnabledId = null;
  });
  terminalContextMenu.addEventListener("pointercancel", () => {
    if (getContextMenuState().ideaDragId) {
      return;
    }
    terminalContextMenu
      .querySelectorAll("[data-context-idea-row]")
      .forEach((row) => row.setAttribute("draggable", "false"));
    state.contextMenu.ideaDragEnabledId = null;
  });
  terminalContextMenu.addEventListener("dragstart", (event) => {
    const row = event.target.closest("[data-context-idea-row]");
    if (!row) {
      return;
    }
    const ideaId = row.dataset.ideaId;
    if (!ideaId || state.contextMenu.ideaDragEnabledId !== ideaId) {
      event.preventDefault();
      return;
    }
    state.contextMenu.ideaDragId = ideaId;
    row.classList.add("is-dragging");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", ideaId);
    }
  });
  terminalContextMenu.addEventListener("dragover", (event) => {
    const { ideaDragId } = getContextMenuState();
    if (!ideaDragId) {
      return;
    }
    const list = event.target.closest("[data-context-idea-list]");
    if (!list) {
      return;
    }
    event.preventDefault();
    const row = event.target.closest("[data-context-idea-row]");
    if (!row) {
      syncIdeaDropIndicator(null, "after");
      return;
    }
    if (row.dataset.ideaId === ideaDragId) {
      clearIdeaDropIndicator();
      return;
    }
    const rect = row.getBoundingClientRect();
    const placement = event.clientY <= rect.top + rect.height / 2 ? "before" : "after";
    syncIdeaDropIndicator(row.dataset.ideaId, placement);
  });
  terminalContextMenu.addEventListener("drop", (event) => {
    const contextMenuState = getContextMenuState();
    if (!contextMenuState.ideaDragId) {
      return;
    }
    const list = event.target.closest("[data-context-idea-list]");
    if (!list) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const row = event.target.closest("[data-context-idea-row]");
    const targetIdeaId = row?.dataset.ideaId || null;
    if (targetIdeaId === contextMenuState.ideaDragId) {
      clearContextMenuIdeaDragState();
      return;
    }
    const placement = targetIdeaId && targetIdeaId !== contextMenuState.ideaDragId
      ? contextMenuState.ideaDropPlacement || "after"
      : "after";
    const changed = reorderSavedIdeas(
      contextMenuState.ideaDragId,
      targetIdeaId && targetIdeaId !== contextMenuState.ideaDragId ? targetIdeaId : null,
      placement,
    );
    clearContextMenuIdeaDragState();
    if (changed) {
      renderOpenTerminalContextMenu();
      setMessage("想法顺序已更新");
    }
  });
  terminalContextMenu.addEventListener("dragend", () => {
    clearContextMenuIdeaDragState();
  });
  terminalContextMenu.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  terminalContextMenu.addEventListener("keydown", async (event) => {
    if (event.target.closest("[data-context-input='idea-edit']") && event.key === "Escape") {
      event.preventDefault();
      clearContextMenuIdeaEditState();
      renderOpenTerminalContextMenu();
      focusContextMenuField("idea");
      return;
    }
    if (isContextMenuEditableTarget(event.target)) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeTerminalContextMenu();
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusTerminalContextMenuItem(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      focusTerminalContextMenuItem(-1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      getContextMenuButtons()[0]?.focus();
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      getContextMenuButtons().at(-1)?.focus();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeTerminalContextMenu();
    }
  });
}

function updateTopbarMenuExpandedState(menu, expanded) {
  const trigger = getTopbarMenuTrigger(menu);
  if (trigger) {
    trigger.setAttribute("aria-expanded", expanded ? "true" : "false");
  }

  const panel = getTopbarMenuPanel(menu);
  if (panel) {
    panel.setAttribute("aria-hidden", expanded ? "false" : "true");
  }
}

function closeTopbarMenu(menu) {
  if (!menu || !menu.classList.contains("is-open")) {
    return;
  }

  menu.classList.remove("is-open");
  updateTopbarMenuExpandedState(menu, false);
}

function closeAllTopbarMenus(exceptMenu = null) {
  getTopbarMenus().forEach((menu) => {
    if (menu !== exceptMenu) {
      closeTopbarMenu(menu);
    }
  });
}

function openTopbarMenu(menu) {
  if (!menu) {
    return;
  }

  closeAllTopbarMenus(menu);
  menu.classList.add("is-open");
  updateTopbarMenuExpandedState(menu, true);

  if (menu.classList.contains("topbar-menu--wide")) {
    loadScreenSelector();
    loadScreenConfigs();
  }
}

function initTopbarMenus() {
  getTopbarMenus().forEach((menu) => {
    const trigger = getTopbarMenuTrigger(menu);
    if (!trigger) {
      return;
    }

    updateTopbarMenuExpandedState(menu, menu.classList.contains("is-open"));
    trigger.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (menu.classList.contains("is-open")) {
        closeTopbarMenu(menu);
        return;
      }

      openTopbarMenu(menu);
    });
  });
}

function getNumberInputStepPrecision(input) {
  const stepRaw = input?.getAttribute("step") || "";
  if (!stepRaw || stepRaw === "any") {
    return 0;
  }
  const decimalPart = stepRaw.split(".")[1] || "";
  return decimalPart.length;
}

function formatNumberInputValue(value, precision) {
  if (!Number.isFinite(value)) {
    return "";
  }
  if (precision <= 0) {
    return String(Math.round(value));
  }
  return value.toFixed(precision).replace(/\.?0+$/, "");
}

function stepNumberInputWithWheel(input, event) {
  if (!(input instanceof HTMLInputElement) || input.type !== "number" || input.disabled || input.readOnly) {
    return false;
  }
  if (event.deltaY === 0) {
    return false;
  }
  const rawStep = Number(input.step);
  const step = Number.isFinite(rawStep) && rawStep > 0 ? rawStep : 1;
  const precision = getNumberInputStepPrecision(input);
  const currentRaw = Number(input.value);
  const minRaw = Number(input.min);
  const maxRaw = Number(input.max);
  const current = Number.isFinite(currentRaw)
    ? currentRaw
    : Number.isFinite(minRaw)
      ? minRaw
      : 0;
  const direction = event.deltaY < 0 ? 1 : -1;
  const factor = precision > 0 ? 10 ** precision : 1;
  let next = current + direction * step;
  if (precision > 0) {
    next = Math.round(next * factor) / factor;
  } else {
    next = Math.round(next);
  }
  if (Number.isFinite(minRaw)) {
    next = Math.max(minRaw, next);
  }
  if (Number.isFinite(maxRaw)) {
    next = Math.min(maxRaw, next);
  }
  const nextValue = formatNumberInputValue(next, precision);
  if (input.value === nextValue) {
    return false;
  }
  input.value = nextValue;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

function bindTopbarNumberInputWheelGuard() {
  getTopbarMenus().forEach((menu) => {
    const panel = getTopbarMenuPanel(menu);
    if (!panel || panel.dataset.numberWheelGuardBound === "true") {
      return;
    }
    panel.dataset.numberWheelGuardBound = "true";
    panel.addEventListener("wheel", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const input = target.closest("input[type='number']");
      if (!(input instanceof HTMLInputElement)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      stepNumberInputWithWheel(input, event);
    }, { passive: false });
  });
}

const DEFAULT_UI_SETTINGS = {
  dashboard_padding_px: 0,
  monitor_stage_padding_px: 12,
  dashboard_gap_px: 5,
  monitor_grid_gap_px: 6,
  wall_card_padding_px: 10,
  wall_card_border_width_px: 1,
  split_resizer_hit_area_px: 14,
  split_resizer_line_width_px: 2,
  grid_resizer_hit_area_px: 16,
  grid_resizer_line_width_px: 2,
  statusbar_font_size_px: 13,
  statusbar_meter_width_px: 90,
  statusbar_meter_height_px: 10,
  filter_tab_slide_duration_ms: 420,
  terminal_font_size_px: 10,
  summary_grid_gap_px: 10,
  summary_hex_side_px: 96,
  summary_card_width_px: 320,
  summary_card_min_height_px: 140,
  summary_card_padding_px: 10,
  summary_card_border_radius_px: 14,
  summary_gap_glow_color: "#ff70db",
  summary_gap_glow_radius_px: 285,
  summary_gap_glow_strength: 0.88,
  summary_gap_glow_softness_px: 14,
  summary_gap_glow_line_width_px: 0,
};

const MIN_GRID_TRACK_RATIO = 0.18;
const MIN_SPLIT_TRACK_RATIO = 0.12;
const CARD_DRAG_START_THRESHOLD_PX = 6;

function normalizeSummaryCellAssignments(raw = {}) {
  const next = {};
  if (!raw || typeof raw !== "object") {
    return next;
  }
  for (const [terminalId, cellIndex] of Object.entries(raw)) {
    const normalizedIndex = Number(cellIndex);
    if (typeof terminalId === "string" && terminalId && Number.isInteger(normalizedIndex) && normalizedIndex >= 0) {
      next[terminalId] = normalizedIndex;
    }
  }
  return next;
}

function pruneSummaryCellAssignments(validTerminalIds = null) {
  const validSet = validTerminalIds instanceof Set
    ? validTerminalIds
    : new Set(state.terminals.keys());
  let changed = false;
  for (const terminalId of Object.keys(state.summaryCellAssignments || {})) {
    if (!validSet.has(terminalId)) {
      delete state.summaryCellAssignments[terminalId];
      changed = true;
    }
  }
  return changed;
}

function getUiSetting(key) {
  return state.uiSettings?.[key] ?? DEFAULT_UI_SETTINGS[key];
}

function getGridGapPx() {
  return getUiSetting(state.viewMode === "brief" ? "summary_grid_gap_px" : "monitor_grid_gap_px");
}

function getSummaryHexSidePx() {
  return Math.max(42, Number(getUiSetting("summary_hex_side_px")) || DEFAULT_UI_SETTINGS.summary_hex_side_px);
}

function getNumericUiSetting(key, fallback = DEFAULT_UI_SETTINGS[key]) {
  const value = Number(getUiSetting(key));
  const defaultValue = Number(fallback);
  return Number.isFinite(value) ? value : defaultValue;
}

function getColorUiSetting(key, fallback = DEFAULT_UI_SETTINGS[key]) {
  const value = String(getUiSetting(key) || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
}

function hexToRgb(hex) {
  const normalized = /^#[0-9a-fA-F]{6}$/.test(String(hex || "").trim())
    ? String(hex).trim()
    : DEFAULT_UI_SETTINGS.summary_gap_glow_color;
  const value = Number.parseInt(normalized.slice(1), 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

function rgbaFromRgb(rgb, alpha) {
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${Math.max(0, Math.min(1, alpha))})`;
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
    if (typeof fallback === "string") {
      const incoming = String(raw[key] ?? "").trim();
      next[key] = incoming || fallback;
      continue;
    }
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
  rootStyle.setProperty("--split-resizer-hit-area-px", `${getUiSetting("split_resizer_hit_area_px")}px`);
  rootStyle.setProperty("--split-resizer-line-width-px", `${getUiSetting("split_resizer_line_width_px")}px`);
  rootStyle.setProperty("--grid-resizer-hit-area-px", `${getUiSetting("grid_resizer_hit_area_px")}px`);
  rootStyle.setProperty("--grid-resizer-line-width-px", `${getUiSetting("grid_resizer_line_width_px")}px`);
  rootStyle.setProperty("--statusbar-font-size-px", `${getUiSetting("statusbar_font_size_px")}px`);
  rootStyle.setProperty("--statusbar-meter-width-px", `${getUiSetting("statusbar_meter_width_px")}px`);
  rootStyle.setProperty("--statusbar-meter-height-px", `${getUiSetting("statusbar_meter_height_px")}px`);
  rootStyle.setProperty("--filter-tab-slide-duration-ms", `${getUiSetting("filter_tab_slide_duration_ms")}ms`);
  rootStyle.setProperty("--terminal-font-size-px", `${getUiSetting("terminal_font_size_px")}px`);
  rootStyle.setProperty("--summary-grid-gap-px", `${getUiSetting("summary_grid_gap_px")}px`);
  const summaryHexSide = getSummaryHexSidePx();
  rootStyle.setProperty("--summary-hex-side-px", `${summaryHexSide}px`);
  rootStyle.setProperty("--summary-hex-width-px", `${Math.sqrt(3) * summaryHexSide}px`);
  rootStyle.setProperty("--summary-hex-height-px", `${2 * summaryHexSide}px`);
  rootStyle.setProperty("--summary-card-width-px", `${getUiSetting("summary_card_width_px")}px`);
  rootStyle.setProperty("--summary-card-min-height-px", `${getUiSetting("summary_card_min_height_px")}px`);
  rootStyle.setProperty("--summary-card-padding-px", `${getUiSetting("summary_card_padding_px")}px`);
  rootStyle.setProperty("--summary-card-border-radius-px", `${getUiSetting("summary_card_border_radius_px")}px`);
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

function formatConnectionSeconds(ms) {
  return Math.max(0, Math.ceil(ms / 1000));
}

function updateConnectionDialogContent() {
  if (!connectionDialog) {
    return;
  }
  const connectionState = state.connectionDialog;
  const elapsed = connectionState.startedAt ? Date.now() - connectionState.startedAt : 0;
  const isLongWaiting = elapsed >= CONNECTION_LONG_WAIT_MS
    && connectionState.status !== "restoring"
    && connectionState.status !== "connected";
  const visualState = isLongWaiting ? "long-waiting" : connectionState.status;
  connectionDialog.dataset.connectionState = visualState;

  if (visualState === "connected") {
    connectionDialogTitle.textContent = "连接成功";
    connectionDialogState.textContent = "已连接";
    connectionDialogDescription.textContent = "连接已恢复，监控数据已同步。";
    connectionDialogDetail.textContent = "即将返回监控墙。";
    connectionDialogAttempt.textContent = connectionState.attempt > 0
      ? `已重连 ${connectionState.attempt} 次`
      : "连接已建立";
    connectionDialogRetry.textContent = "1 秒后关闭";
    return;
  }

  if (visualState === "restoring") {
    connectionDialogTitle.textContent = "正在恢复监控数据";
    connectionDialogState.textContent = "同步中";
    connectionDialogDescription.textContent = "连接已恢复，正在同步终端状态。";
    connectionDialogDetail.textContent = "收到最新快照后，监控墙会自动恢复可操作状态。";
    connectionDialogAttempt.textContent = connectionState.attempt > 0
      ? `已重连 ${connectionState.attempt} 次`
      : "连接已建立";
    connectionDialogRetry.textContent = "等待数据同步";
    return;
  }

  if (visualState === "long-waiting") {
    connectionDialogTitle.textContent = "连接时间较长";
    connectionDialogState.textContent = "重连中";
    connectionDialogDescription.textContent = "后端服务暂时不可用，前端会继续自动重连。";
    connectionDialogDetail.textContent = "当前监控画面会保留；可以检查终端里的服务是否仍在运行。";
  } else if (connectionState.status === "reconnecting") {
    connectionDialogTitle.textContent = "正在重新连接 multi-iterm2-manager";
    connectionDialogState.textContent = "重连中";
    connectionDialogDescription.textContent = "服务连接暂时中断，正在自动重连。";
    connectionDialogDetail.textContent = "当前监控画面会保留，连接恢复后会自动同步最新状态。";
  } else {
    connectionDialogTitle.textContent = "正在连接 multi-iterm2-manager";
    connectionDialogState.textContent = "连接中";
    connectionDialogDescription.textContent = "正在建立与后端服务的连接。";
    connectionDialogDetail.textContent = "如果后端正在重启，连接恢复后会自动同步最新状态。";
  }

  const retryIn = connectionState.nextRetryAt
    ? formatConnectionSeconds(connectionState.nextRetryAt - Date.now())
    : 0;
  connectionDialogAttempt.textContent = connectionState.attempt > 0
    ? `第 ${connectionState.attempt} 次重连`
    : "准备连接";
  connectionDialogRetry.textContent = retryIn > 0 ? `${retryIn} 秒后继续` : "正在尝试连接";
}

function startConnectionDialogTicker() {
  const connectionState = state.connectionDialog;
  if (connectionState.tickTimer) {
    return;
  }
  connectionState.tickTimer = window.setInterval(updateConnectionDialogContent, 1000);
}

function stopConnectionDialogTicker() {
  const connectionState = state.connectionDialog;
  if (!connectionState.tickTimer) {
    return;
  }
  window.clearInterval(connectionState.tickTimer);
  connectionState.tickTimer = null;
}

function showConnectionDialog() {
  if (!connectionDialog || connectionDialog.open) {
    updateConnectionDialogContent();
    return;
  }
  updateConnectionDialogContent();
  try {
    connectionDialog.showModal();
  } catch {
    connectionDialog.setAttribute("open", "");
  }
  startConnectionDialogTicker();
}

function scheduleConnectionDialogShow() {
  if (!connectionDialog) {
    return;
  }
  const connectionState = state.connectionDialog;
  if (connectionDialog.open || connectionState.showTimer) {
    updateConnectionDialogContent();
    return;
  }
  connectionState.showTimer = window.setTimeout(() => {
    connectionState.showTimer = null;
    showConnectionDialog();
  }, CONNECTION_DIALOG_SHOW_DELAY_MS);
}

function hideConnectionDialog() {
  const connectionState = state.connectionDialog;
  if (connectionState.showTimer) {
    window.clearTimeout(connectionState.showTimer);
    connectionState.showTimer = null;
  }
  if (connectionState.closeTimer) {
    window.clearTimeout(connectionState.closeTimer);
    connectionState.closeTimer = null;
  }
  stopConnectionDialogTicker();
  if (!connectionDialog || !connectionDialog.open) {
    return;
  }
  connectionDialog.close();
}

function setConnectionDialogStatus(status, options = {}) {
  const connectionState = state.connectionDialog;
  const now = Date.now();
  const previousStatus = connectionState.status;
  if (connectionState.closeTimer && status !== "connected") {
    window.clearTimeout(connectionState.closeTimer);
    connectionState.closeTimer = null;
  }
  if (!connectionState.startedAt || (status === "connecting" && previousStatus === "connected")) {
    connectionState.startedAt = now;
  }
  if (status === "connecting" && previousStatus === "connected") {
    connectionState.attempt = 0;
  }
  connectionState.status = status;
  if (Number.isInteger(options.attempt)) {
    connectionState.attempt = options.attempt;
  }
  if (Number.isFinite(options.nextRetryAt)) {
    connectionState.nextRetryAt = options.nextRetryAt;
  } else if (status !== "reconnecting") {
    connectionState.nextRetryAt = 0;
  }

  if (status === "connected") {
    connectionState.nextRetryAt = 0;
    if (connectionState.showTimer) {
      window.clearTimeout(connectionState.showTimer);
      connectionState.showTimer = null;
    }
    if (!connectionDialog || !connectionDialog.open) {
      connectionState.startedAt = 0;
      connectionState.attempt = 0;
      hideConnectionDialog();
      return;
    }
    updateConnectionDialogContent();
    stopConnectionDialogTicker();
    connectionState.closeTimer = window.setTimeout(() => {
      connectionState.closeTimer = null;
      connectionState.startedAt = 0;
      connectionState.attempt = 0;
      hideConnectionDialog();
    }, CONNECTION_SUCCESS_HOLD_MS);
    return;
  }
  scheduleConnectionDialogShow();
  updateConnectionDialogContent();
}

if (connectionDialog) {
  connectionDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
  });
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

function insertSplitTerminalIntoLayout(sourceId, terminal, zone, layout = null) {
  if (!sourceId || !terminal?.id) {
    return;
  }

  state.terminals.set(terminal.id, terminal);
  if (terminal.hidden) {
    state.hiddenTerminalIds.add(terminal.id);
  } else {
    state.hiddenTerminalIds.delete(terminal.id);
  }
  if (terminal.muted) {
    state.mutedTerminalIds.add(terminal.id);
  } else {
    state.mutedTerminalIds.delete(terminal.id);
  }
  if (!state.orderedTerminalIds.includes(terminal.id)) {
    state.orderedTerminalIds.push(terminal.id);
  }

  const activeRecords = [...state.terminals.values()].filter((record) => record && record.status !== "closed");
  const activeIds = activeRecords.map((record) => record.id);
  const baseTree = state.layoutTree || buildInitialLayoutTree(activeRecords, Math.max(1, state.layout.columns || 2));
  const nextBaseTree = removeTerminalFromTree(baseTree, terminal.id);
  state.layoutTree = normalizeLayoutTree(
    insertTerminalBySplit(nextBaseTree, sourceId, createTerminalLayoutNode(terminal.id), zone),
  );
  if (state.layoutTree) {
    mergeVisibleIds(getTerminalIdsFromTree(state.layoutTree).filter((id) => activeIds.includes(id)), activeIds);
  }
  updateQueue(terminal.id, null, terminal.status);
  clearSplitDropPreview();
  saveViewState();
  refreshWall(layout);
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
  if (!grid || state.viewMode === "brief" || state.layout.count <= 1 || state.layoutTree) return;
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
  document.querySelectorAll('.wall-card[data-terminal-id]').forEach((card) => {
    const terminalId = card.dataset.terminalId;
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
  clearSummaryCellPreview();
}

function commitCardPointerDrag(clientX, clientY) {
  if (state.viewMode === "brief") {
    commitSummaryCellDrag(clientX, clientY);
    return;
  }
  const target = getDropTargetAtPoint(clientX, clientY);
  if (!target || !state.draggedTerminalId) {
    return;
  }
  reorderTerminalsByZone(state.draggedTerminalId, target.terminalId, target.zone || 'right');
}

let _cardDragRafId = 0;
let _summaryGapGlowRafId = 0;
let _summaryGapGlowPoint = null;

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
    if (state.viewMode === "brief") {
      clearSummaryGapGlow();
      const target = getSummaryDropTargetAtPoint(cx, cy);
      if (target) {
        applySummaryCellPreview(target);
      } else {
        clearSummaryCellPreview();
      }
      return;
    }
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
  if (state.viewMode === "brief") {
    clearSummaryGapGlow();
  }
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

/** 将 Unix 时间戳（秒）格式化为真实相对时间 */
function formatSummaryTime(unixSeconds) {
  if (!unixSeconds) return "";
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - Number(unixSeconds)));
  if (diff < 5) return "刚刚";
  if (diff < 60) return `${diff}s前`;
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;

  const date = new Date(Number(unixSeconds) * 1000);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  if (diff < 172800) {
    return `昨天 ${hours}:${minutes}`;
  }

  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${month}-${day} ${hours}:${minutes}`;
}

/**
 * 根据摘要状态和原因生成 none 状态的提示 HTML
 * @param {string} reason - aiSummaryReason 值
 * @param {number} aiSummaryAt - 上次总结时间（Unix 秒）
 * @returns {string} HTML 字符串
 */
function buildNoneReasonHtml(reason, aiSummaryAt) {
  switch (reason) {
    case "content_changing":
      return `<span class="wall-card-brief-text--reason-pulse">内容变化中...</span>`;
    case "cooldown": {
      // 计算冷却剩余秒数
      const activeInterval = (state.summaryConfig && state.summaryConfig.activeInterval) || 10;
      const elapsed = aiSummaryAt > 0 ? Math.floor(Date.now() / 1000) - aiSummaryAt : 0;
      const remaining = Math.max(0, Math.ceil(activeInterval - elapsed));
      return `<span class="wall-card-brief-text--reason">冷却中，${remaining}s后更新</span>`;
    }
    case "idle":
      return `<span class="wall-card-brief-text--reason">空闲中</span>`;
    case "no_api":
      return `<span class="wall-card-brief-text--warn">未配置 API</span>`;
    default:
      return `<span class="wall-card-brief-text wall-card-brief-text--waiting">等待总结...</span>`;
  }
}

/**
 * 根据摘要原因生成 fallback 状态的附加小字 HTML
 * @param {string} reason - aiSummaryReason 值
 * @returns {string} HTML 字符串（可能为空）
 */
function buildFallbackReasonNoteHtml(reason, errorDetail = "") {
  const detail = errorDetail ? escapeHtml(errorDetail) : "";
  switch (reason) {
    case "api_error":
      return `<span class="wall-card-brief-reason-note">${detail || "请求失败"} · 稍后重试</span>`;
    case "empty_response":
      return `<span class="wall-card-brief-reason-note">模型返回空内容 · 稍后重试</span>`;
    case "no_api":
      return `<span class="wall-card-brief-reason-note wall-card-brief-reason-note--warn">未配置API</span>`;
    default:
      return "";
  }
}

function collectTransientCardClasses(card) {
  const preserveClasses = [];
  if (card.classList.contains("is-dragging")) preserveClasses.push("is-dragging");
  for (const cls of card.classList) {
    if (cls.startsWith("split-preview-")) preserveClasses.push(cls);
  }
  return preserveClasses;
}

function getCardClassName(record, options = {}) {
  const classes = ["wall-card"];
  if (options.brief) {
    classes.push("wall-card--brief", "wall-card--brief-detail");
  }
  classes.push(`status-${record.status}`);
  if (record.isPrimary && record.status !== "closed") {
    classes.push("wall-card--primary-focus");
  }
  if (Array.isArray(options.extraClasses) && options.extraClasses.length) {
    classes.push(...options.extraClasses);
  }
  return classes.join(" ");
}

function buildBriefContentModel(record) {
  const summaryStatus = record.aiSummaryStatus || "none";
  const summaryText = record.aiSummary || record.summary || "暂无输出";
  const reason = record.aiSummaryReason || "";
  const errorDetail = record.aiSummaryErrorDetail || "";
  const updatedAt = record.lastInteractionAt ? formatSummaryTime(record.lastInteractionAt) : "";

  let mainHtml = "";
  let noteHtml = "";
  let badgeHtml = "";

  if (summaryStatus === "summarizing") {
    mainHtml = `
      <span class="wall-card-brief-state-line">
        <span class="wall-card-brief-dots">
          <span class="brief-dot"></span>
          <span class="brief-dot"></span>
          <span class="brief-dot"></span>
        </span>
        <span class="wall-card-brief-loading-text">LLM 正在总结...</span>
      </span>
    `;
    badgeHtml = `<span class="wall-card-brief-badge wall-card-brief-badge--progress">生成中</span>`;
  } else if (summaryStatus === "done") {
    mainHtml = `<span class="wall-card-brief-text">${escapeHtml(summaryText)}</span>`;
    badgeHtml = `<span class="wall-card-brief-badge wall-card-brief-badge--ai">AI总结</span>`;
  } else if (summaryStatus === "fallback") {
    mainHtml = `<span class="wall-card-brief-text wall-card-brief-text--fallback">${escapeHtml(summaryText)}</span>`;
    noteHtml = buildFallbackReasonNoteHtml(reason, errorDetail);
    badgeHtml = `<span class="wall-card-brief-badge wall-card-brief-badge--fallback">Fallback</span>`;
  } else {
    mainHtml = buildNoneReasonHtml(reason, record.aiSummaryAt || 0);
    const waitingLabel = reason === "no_api"
      ? "待配置"
      : reason === "cooldown"
        ? "冷却中"
        : "待摘要";
    badgeHtml = `<span class="wall-card-brief-badge wall-card-brief-badge--muted">${waitingLabel}</span>`;
  }

  return {
    summaryStatus,
    updatedAt,
    mainHtml,
    noteHtml,
    badgeHtml,
  };
}

function buildBriefBadgesHtml(record, summary) {
  const program = getProgramInfo(record);
  const badges = [];
  if (shouldShowProgramChip(record)) {
    badges.push(`
      <span
        class="wall-card-program-chip program-${program.key}"
        title="${escapeHtml(program.commandLine || programSourceLabel(program.source))}"
      >${escapeHtml(program.label)}</span>
    `);
  }
  if (summary?.badgeHtml) {
    badges.push(summary.badgeHtml);
  }
  if (shouldTrackTerminalStatus(record)) {
    badges.push(`<span class="wall-card-brief-status-chip status-${record.status}">${escapeHtml(statusLabel(record.status))}</span>`);
  }
  if (!badges.length) {
    return `
      <div class="wall-card-brief-tags wall-card-brief-tags--empty" aria-label="类型标签">
        <span class="wall-card-brief-tag wall-card-brief-tag--empty">Shell</span>
      </div>
    `;
  }
  return `
    <div class="wall-card-brief-tags" aria-label="类型标签">
      ${badges.join("")}
    </div>
  `;
}

function rerenderBriefCard(card, record) {
  const summary = buildBriefContentModel(record);
  const folderName = getSummaryFolderName(getSummaryFolderPath(record));
  const timeHtml = summary.updatedAt
    ? `<span class="wall-card-brief-time">${summary.updatedAt}</span>`
    : `<span class="wall-card-brief-time wall-card-brief-time--empty">--</span>`;
  card.className = getCardClassName(record, {
    brief: true,
    extraClasses: collectTransientCardClasses(card),
  });
  card.innerHTML = `
    <div
      class="wall-card-brief"
      data-summary-status="${summary.summaryStatus}"
      data-summary-reason="${escapeHtml(record.aiSummaryReason || "")}"
      data-summary-error-detail="${escapeHtml(record.aiSummaryErrorDetail || "")}"
    >
	      <div class="wall-card-brief-shell">
	        <div class="wall-card-brief-drag-zone">
	          <button type="button" class="ghost wall-card-drag-handle" title="拖拽排序" aria-label="拖拽排序"><svg width="100%" height="100%" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 1l-3 3.5h6L12 1z"/><path d="M12 23l-3-3.5h6L12 23z"/><path d="M1 12l3.5-3v6L1 12z"/><path d="M23 12l-3.5-3v6L23 12z"/><rect x="11.25" y="4" width="1.5" height="16" rx=".75"/><rect x="4" y="11.25" width="16" height="1.5" rx=".75"/></svg></button>
	        </div>
	        <div class="wall-card-brief-folder-line">
	          <span class="wall-card-folder-title" title="${escapeHtml(getSummaryFolderPath(record) || folderName)}">${escapeHtml(folderName)}</span>
        </div>
        ${buildBriefBadgesHtml(record, summary)}
        <div class="wall-card-brief-main">
          <div class="wall-card-brief-summary-panel">
            ${summary.mainHtml}
            ${summary.noteHtml ? `<div class="wall-card-brief-note">${summary.noteHtml}</div>` : ""}
          </div>
        </div>
	        <div class="wall-card-brief-title-line">
	          <h2 class="wall-card-title">${escapeHtml(record.name || "")}</h2>
        </div>
        <div class="wall-card-brief-time-row">${timeHtml}</div>
      </div>
    </div>
  `;
  updateCardMeta(card, record);
  bindCardActions(card, record);
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

function getSummaryFolderPath(record) {
  const cwd = typeof record?.cwd === "string" ? record.cwd.trim() : "";
  return cwd.replace(/\/+$/, "");
}

function getSummaryFolderKey(record) {
  return getSummaryFolderPath(record) || "__unknown-folder__";
}

function getSummaryFolderName(folderPath) {
  if (!folderPath) {
    return "未识别文件夹";
  }
  const parts = folderPath.split("/").filter(Boolean);
  return parts[parts.length - 1] || folderPath;
}

function buildSummaryFolderGroups(records) {
  const groups = [];
  const groupByKey = new Map();
  for (const record of records) {
    const folderPath = getSummaryFolderPath(record);
    const key = getSummaryFolderKey(record);
    let group = groupByKey.get(key);
    if (!group) {
      group = {
        key,
        folderPath,
        folderName: getSummaryFolderName(folderPath),
        records: [],
      };
      groupByKey.set(key, group);
      groups.push(group);
    }
    group.records.push(record);
  }
  return groups;
}

function renderSummaryFolderColumn(group) {
  const column = document.createElement("section");
  column.className = "summary-folder-column";
  column.dataset.summaryFolderKey = group.key;
  column.dataset.summaryFolderPath = group.folderPath || "";

  const header = document.createElement("header");
  header.className = "summary-folder-column-header";
  header.title = group.folderPath || "未识别文件夹";

  const titleRow = document.createElement("div");
  titleRow.className = "summary-folder-title-row";

  const title = document.createElement("div");
  title.className = "summary-folder-title";
  title.textContent = group.folderName;

  const count = document.createElement("span");
  count.className = "summary-folder-count";
  count.textContent = String(group.records.length);

  const path = document.createElement("div");
  path.className = "summary-folder-path";
  path.textContent = group.folderPath || "未识别文件夹";

  titleRow.appendChild(title);
  titleRow.appendChild(count);
  header.appendChild(titleRow);
  header.appendChild(path);
  column.appendChild(header);

  const body = document.createElement("div");
  body.className = "summary-folder-column-body";
  for (const record of group.records) {
    body.appendChild(renderTerminal(record));
  }
  column.appendChild(body);

  return column;
}

function renderSummaryFolderColumns(records) {
  const groups = buildSummaryFolderGroups(records);
  grid.dataset.summaryFolderCount = String(groups.length);
  for (const group of groups) {
    grid.appendChild(renderSummaryFolderColumn(group));
  }
}

function getSummaryCellWidthPx() {
  return Math.sqrt(3) * getSummaryHexSidePx();
}

function getSummaryCellHeightPx() {
  return 2 * getSummaryHexSidePx();
}

function getSummaryGridAvailableRect() {
  const rect = grid?.getBoundingClientRect();
  const parentRect = grid?.parentElement?.getBoundingClientRect();
  return {
    width: Math.max(1, parentRect?.width || rect?.width || window.innerWidth || getSummaryCellWidthPx()),
    height: Math.max(
      getSummaryCellHeightPx(),
      rect?.height || grid?.parentElement?.clientHeight || Math.max(240, window.innerHeight - 160),
    ),
  };
}

function buildSummaryHexMetrics(side, gap = getGridGapPx()) {
  const width = Math.sqrt(3) * side;
  const height = 2 * side;
  return {
    side,
    gap,
    width,
    height,
    stepX: width + gap,
    stepY: side * 1.5 + gap,
  };
}

function getSummaryHexMetrics() {
  return buildSummaryHexMetrics(getSummaryHexSidePx());
}

function getSummaryFittingColumnCount(metrics, availableWidth) {
  return getSummaryFittingColumnCountForOffset(metrics, availableWidth, metrics.stepX / 2);
}

function getSummaryFittingColumnCountForOffset(metrics, availableWidth, offset = 0) {
  if (availableWidth < metrics.width) {
    return 1;
  }
  return Math.max(1, Math.floor((availableWidth - metrics.width - offset) / metrics.stepX) + 1);
}

function getSummaryUsableRowEntries(metrics, availableHeight) {
  const firstRowTop = -metrics.stepY;
  const rows = Math.max(3, Math.ceil((availableHeight + metrics.height / 2) / metrics.stepY));
  const usableRowEntries = [];
  for (let row = 0; row < rows; row += 1) {
    const top = firstRowTop + row * metrics.stepY;
    if (top >= 0 && top + metrics.height <= availableHeight) {
      usableRowEntries.push({ row, top, usableRowIndex: usableRowEntries.length });
    }
  }
  if (usableRowEntries.length === 0) {
    const fallbackRow = Math.max(1, Math.floor(rows / 2));
    usableRowEntries.push({
      row: fallbackRow,
      top: Math.max(0, Math.min(availableHeight - metrics.height, firstRowTop + fallbackRow * metrics.stepY)),
      usableRowIndex: 0,
    });
  }
  return { firstRowTop, rows, usableRowEntries };
}

function getAdaptiveSummaryHexLayout(recordCount, available) {
  const configuredSide = getSummaryHexSidePx();
  const minSide = 42;
  const gap = getGridGapPx();
  for (let side = configuredSide; side >= minSide; side -= 2) {
    const metrics = buildSummaryHexMetrics(side, gap);
    const rowModel = getSummaryUsableRowEntries(metrics, available.height);
    const fitColumns = getSummaryFittingColumnCount(metrics, available.width);
    const capacity = fitColumns * rowModel.usableRowEntries.length;
    if (recordCount <= capacity || side === minSide) {
      return { metrics, ...rowModel, fitColumns };
    }
  }
  const metrics = buildSummaryHexMetrics(minSide, gap);
  return {
    metrics,
    ...getSummaryUsableRowEntries(metrics, available.height),
    fitColumns: getSummaryFittingColumnCount(metrics, available.width),
  };
}

function buildSummaryGridModel(records) {
  const available = getSummaryGridAvailableRect();
  const { metrics, firstRowTop, rows, usableRowEntries, fitColumns } = getAdaptiveSummaryHexLayout(records.length, available);
  const usableRows = usableRowEntries.length;
  state.summaryCellAssignments = normalizeSummaryCellAssignments(state.summaryCellAssignments);

  let maxAssignedIndex = -1;
  for (const record of records) {
    const assignedIndex = state.summaryCellAssignments[record.id];
    if (Number.isInteger(assignedIndex) && assignedIndex >= 0) {
      maxAssignedIndex = Math.max(maxAssignedIndex, assignedIndex);
    }
  }

  let columns = Math.max(
    fitColumns,
    Math.ceil(records.length / usableRows),
    1,
  );
  columns = Math.min(columns, fitColumns);
  const slots = Array.from({ length: columns * usableRows }, () => null);
  const unassignedRecords = [];

  for (const record of records) {
    const assignedIndex = state.summaryCellAssignments[record.id];
    if (Number.isInteger(assignedIndex) && assignedIndex >= 0 && assignedIndex < slots.length && !slots[assignedIndex]) {
      slots[assignedIndex] = record;
    } else {
      unassignedRecords.push(record);
    }
  }

  for (const record of unassignedRecords) {
    let slotIndex = slots.findIndex((slot) => !slot);
    if (slotIndex === -1) {
      slots.push(...Array.from({ length: usableRows }, () => null));
      columns += 1;
      slotIndex = slots.length - usableRows;
    }
    slots[slotIndex] = record;
  }

  columns = Math.max(1, Math.ceil(slots.length / usableRows));
  const normalizedSlotCount = columns * usableRows;
  while (slots.length < normalizedSlotCount) {
    slots.push(null);
  }

  const visualColumns = Math.max(
    columns,
    getSummaryFittingColumnCountForOffset(metrics, available.width, 0),
    getSummaryFittingColumnCountForOffset(metrics, available.width, metrics.stepX / 2),
  );
  const cells = [];
  let contentWidth = 0;
  let contentHeight = available.height;
  const usableRowsByRow = new Map(usableRowEntries.map((entry) => [entry.row, entry]));
  for (let column = -1; column <= visualColumns; column += 1) {
    for (let row = 0; row < rows; row += 1) {
      const rawTop = firstRowTop + row * metrics.stepY;
      const left = column * metrics.stepX + (row % 2 === 1 ? metrics.stepX / 2 : 0);
      const usableEntry = usableRowsByRow.get(row) || null;
      const top = usableEntry?.top ?? rawTop;
      const right = left + metrics.width;
      const bottom = top + metrics.height;
      if (right <= 0 || left >= available.width || bottom <= 0 || top >= available.height) {
        continue;
      }
      const fitsWidth = left >= 0 && right <= available.width + 0.5;
      const fitsHeight = top >= 0 && bottom <= available.height + 0.5;
      const isPartial = !fitsWidth || !fitsHeight;
      const slotIndex = usableEntry && column >= 0 && column < columns && fitsWidth && fitsHeight
        ? column * usableRows + usableEntry.usableRowIndex
        : -1;
      cells.push({
        row,
        column,
        left,
        top,
        width: metrics.width,
        height: metrics.height,
        usable: Boolean(usableEntry) && column < columns && fitsWidth && !isPartial,
        partial: isPartial,
        usableRowIndex: usableEntry?.usableRowIndex ?? -1,
        slotIndex,
        record: slotIndex >= 0 ? slots[slotIndex] : null,
      });
      contentWidth = Math.max(contentWidth, left + metrics.width);
      contentHeight = Math.max(contentHeight, top + metrics.height);
    }
  }

  return {
    rows,
    usableRows,
    columns,
    slots,
    cells,
    metrics,
    available,
    contentWidth,
    contentHeight,
  };
}

function ensureSummaryCellAssignments(records) {
  const model = buildSummaryGridModel(records);
  model.slots.forEach((record, index) => {
    if (record?.id) {
      state.summaryCellAssignments[record.id] = index;
    }
  });
  return model;
}

function renderSummaryGrid(records) {
  const model = buildSummaryGridModel(records);
  state.summaryGridRows = model.rows;
  state.summaryGridColumns = model.columns;
  grid.dataset.summaryRows = String(model.rows);
  grid.dataset.summaryUsableRows = String(model.usableRows);
  grid.dataset.summaryColumns = String(model.columns);
  grid.setAttribute("role", "grid");
  grid.setAttribute("aria-rowcount", String(model.usableRows));
  grid.setAttribute("aria-colcount", String(model.columns));
  grid.style.removeProperty("grid-auto-flow");
  grid.style.removeProperty("grid-auto-columns");
  grid.style.removeProperty("grid-auto-rows");
  grid.style.removeProperty("grid-template-rows");
  grid.style.removeProperty("grid-template-columns");
  grid.style.removeProperty("min-width");
  grid.style.width = "100%";
  grid.style.height = "100%";
  grid.style.setProperty("--summary-hex-side-px", `${model.metrics.side}px`);
  grid.style.setProperty("--summary-hex-width-px", `${model.metrics.width}px`);
  grid.style.setProperty("--summary-hex-height-px", `${model.metrics.height}px`);

  const glowCanvas = document.createElement("canvas");
  glowCanvas.className = "summary-gap-glow-canvas";
  glowCanvas.setAttribute("aria-hidden", "true");
  glowCanvas.width = Math.max(1, Math.ceil(model.available.width * (window.devicePixelRatio || 1)));
  glowCanvas.height = Math.max(1, Math.ceil(model.available.height * (window.devicePixelRatio || 1)));
  glowCanvas.style.width = `${model.available.width}px`;
  glowCanvas.style.height = `${model.available.height}px`;
  grid.appendChild(glowCanvas);

  model.cells.forEach((hexCell) => {
    const cell = document.createElement("div");
    cell.className = `summary-grid-cell summary-grid-cell--hex${hexCell.partial ? " summary-grid-cell--half" : ""}`;
    cell.style.left = `${hexCell.left}px`;
    cell.style.top = `${hexCell.top}px`;
    cell.style.width = `${hexCell.width}px`;
    cell.style.height = `${hexCell.height}px`;
    cell.dataset.summaryRow = String(hexCell.row);
    cell.dataset.summaryColumn = String(hexCell.column);
    cell.setAttribute("role", "gridcell");
    if (hexCell.usable) {
      cell.dataset.summaryCellIndex = String(hexCell.slotIndex);
      cell.dataset.summaryUsableRow = String(hexCell.usableRowIndex);
      cell.setAttribute("aria-label", hexCell.record ? `摘要蜂巢：${displayTitle(hexCell.record)}` : "空摘要蜂巢");
    } else {
      cell.dataset.summaryDisabled = "true";
      cell.setAttribute("aria-hidden", "true");
    }
    if (hexCell.record) {
      cell.classList.add("summary-grid-cell--occupied");
      cell.dataset.terminalId = hexCell.record.id;
      cell.appendChild(renderTerminal(hexCell.record));
    }
    grid.appendChild(cell);
  });
}

function clearSummaryCellPreview() {
  state.hoverSummaryCellIndex = null;
  document.querySelector(".summary-grid-cell--virtual")?.remove();
  document
    .querySelectorAll(".summary-grid-cell.is-summary-drop-target")
    .forEach((cell) => cell.classList.remove("is-summary-drop-target"));
}

function getSummaryGapGlowCanvas() {
  return grid?.querySelector(".summary-gap-glow-canvas") || null;
}

function clearSummaryGapGlow() {
  if (_summaryGapGlowRafId) {
    cancelAnimationFrame(_summaryGapGlowRafId);
    _summaryGapGlowRafId = 0;
  }
  _summaryGapGlowPoint = null;
  const canvas = getSummaryGapGlowCanvas();
  const context = canvas?.getContext("2d");
  if (canvas && context) {
    context.clearRect(0, 0, canvas.width, canvas.height);
  }
}

function traceSummaryHexPath(context, left, top, width, height) {
  context.beginPath();
  context.moveTo(left + width * 0.5, top);
  context.lineTo(left + width, top + height * 0.25);
  context.lineTo(left + width, top + height * 0.75);
  context.lineTo(left + width * 0.5, top + height);
  context.lineTo(left, top + height * 0.75);
  context.lineTo(left, top + height * 0.25);
  context.closePath();
}

function drawSummaryGapGlow() {
  _summaryGapGlowRafId = 0;
  if (!_summaryGapGlowPoint || state.viewMode !== "brief" || !grid || state.activeCardDrag || state.draggedTerminalId) {
    clearSummaryGapGlow();
    return;
  }

  const canvas = getSummaryGapGlowCanvas();
  const context = canvas?.getContext("2d");
  if (!canvas || !context) {
    return;
  }

  const gridRect = grid.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = Math.max(1, Math.round(gridRect.width));
  const cssHeight = Math.max(1, Math.round(gridRect.height));
  const pixelWidth = Math.max(1, Math.ceil(cssWidth * dpr));
  const pixelHeight = Math.max(1, Math.ceil(cssHeight * dpr));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
  }

  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, cssWidth, cssHeight);

  const hoverX = _summaryGapGlowPoint.clientX - gridRect.left;
  const hoverY = _summaryGapGlowPoint.clientY - gridRect.top;
  const cells = grid.querySelectorAll(".summary-grid-cell:not(.summary-grid-cell--virtual):not(.summary-grid-cell--half)");
  const glowColor = hexToRgb(getColorUiSetting("summary_gap_glow_color"));
  const glowRadius = Math.max(80, getNumericUiSetting("summary_gap_glow_radius_px", 285));
  const glowStrength = Math.max(0, getNumericUiSetting("summary_gap_glow_strength", 0.88));
  const glowSoftness = Math.max(0, getNumericUiSetting("summary_gap_glow_softness_px", 14));
  const configuredLineWidth = getNumericUiSetting("summary_gap_glow_line_width_px", 0);
  const glowLineWidth = configuredLineWidth > 0
    ? configuredLineWidth
    : Math.max(2, Math.min(8, getGridGapPx() + 2));

  context.save();
  context.lineJoin = "round";
  context.lineCap = "round";

  cells.forEach((cell) => {
    const left = Number.parseFloat(cell.style.left) || 0;
    const top = Number.parseFloat(cell.style.top) || 0;
    const width = Number.parseFloat(cell.style.width) || cell.offsetWidth || 0;
    const height = Number.parseFloat(cell.style.height) || cell.offsetHeight || 0;
    if (!width || !height) {
      return;
    }

    const centerX = left + width / 2;
    const centerY = top + height / 2;
    const distance = Math.hypot(hoverX - centerX, (hoverY - centerY) * 0.92);
    const strength = Math.max(0, 1 - distance / glowRadius);
    if (strength <= 0.08) {
      return;
    }

    traceSummaryHexPath(context, left, top, width, height);
    const gradient = context.createRadialGradient(hoverX, hoverY, 0, hoverX, hoverY, glowRadius);
    gradient.addColorStop(0, rgbaFromRgb(glowColor, glowStrength * strength));
    gradient.addColorStop(0.42, rgbaFromRgb(glowColor, glowStrength * 0.48 * strength));
    gradient.addColorStop(1, rgbaFromRgb(glowColor, 0));
    context.strokeStyle = gradient;
    context.lineWidth = glowLineWidth;
    context.shadowColor = rgbaFromRgb(glowColor, glowStrength * 0.38 * strength);
    context.shadowBlur = glowSoftness * strength;
    context.stroke();
  });

  context.restore();
}

function handleSummaryGridPointerMove(event) {
  if (state.viewMode !== "brief" || !grid || state.activeCardDrag || state.draggedTerminalId) {
    clearSummaryGapGlow();
    return;
  }
  _summaryGapGlowPoint = {
    clientX: event.clientX,
    clientY: event.clientY,
  };
  if (!_summaryGapGlowRafId) {
    _summaryGapGlowRafId = requestAnimationFrame(drawSummaryGapGlow);
  }
}

function getSummaryGridCells() {
  return [...document.querySelectorAll(".summary-grid-cell:not(.summary-grid-cell--virtual):not(.summary-grid-cell--half)")];
}

function getSummaryCellElementAtPoint(clientX, clientY) {
  const hit = document.elementFromPoint(clientX, clientY);
  const directCell = hit instanceof Element ? hit.closest(".summary-grid-cell") : null;
  if (
    directCell
    && !directCell.classList.contains("summary-grid-cell--virtual")
    && !directCell.classList.contains("summary-grid-cell--half")
    && directCell.dataset.summaryDisabled !== "true"
  ) {
    return directCell;
  }

  const gapAllowance = Math.max(2, getGridGapPx() / 2);
  let nearest = null;
  getSummaryGridCells().forEach((cell) => {
    const rect = cell.getBoundingClientRect();
    const dx = clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0;
    const dy = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
    if (dx <= gapAllowance && dy <= gapAllowance) {
      const score = dx + dy;
      if (!nearest || score < nearest.score) {
        nearest = { cell, score };
      }
    }
  });
  return nearest?.cell || null;
}

function getSummaryGridContentMetrics() {
  const cells = getSummaryGridCells();
  if (!grid || cells.length === 0) {
    return null;
  }
  const rects = cells.map((cell) => cell.getBoundingClientRect());
  const rows = Math.max(1, Number(grid.dataset.summaryUsableRows) || 1);
  const columns = Math.max(1, Number(state.summaryGridColumns || grid.dataset.summaryColumns) || 1);
  return {
    left: Math.min(...rects.map((rect) => rect.left)),
    right: Math.max(...rects.map((rect) => rect.right)),
    top: Math.min(...rects.map((rect) => rect.top)),
    bottom: Math.max(...rects.map((rect) => rect.bottom)),
    rows,
    columns,
    cellWidth: rects[0]?.width || getSummaryCellWidthPx(),
    cellHeight: rects[0]?.height || getSummaryCellHeightPx(),
    gap: getGridGapPx(),
    usableCells: cells,
  };
}

function getSummaryVirtualDropTargetAtPoint(clientX, clientY) {
  const metrics = getSummaryGridContentMetrics();
  if (!metrics) {
    return null;
  }
  const gapAllowance = Math.max(4, metrics.gap / 2);
  if (clientY < metrics.top - gapAllowance || clientY > metrics.bottom + gapAllowance) {
    return null;
  }

  let targetRow = null;
  metrics.usableCells.forEach((cell) => {
    const rect = cell.getBoundingClientRect();
    if (clientY >= rect.top - gapAllowance && clientY <= rect.bottom + gapAllowance) {
      const rowIndex = Number(cell.dataset.summaryUsableRow);
      if (Number.isInteger(rowIndex) && rowIndex >= 0 && (!targetRow || rect.left > targetRow.left)) {
        targetRow = { rowIndex, top: rect.top, left: rect.left };
      }
    }
  });
  if (!targetRow) {
    return null;
  }

  const virtualLeft = metrics.right + metrics.gap;
  const virtualRight = virtualLeft + metrics.cellWidth;
  if (clientX < virtualLeft - gapAllowance || clientX > virtualRight + gapAllowance) {
    return null;
  }

  return {
    cell: null,
    cellIndex: metrics.columns * metrics.rows + targetRow.rowIndex,
    virtualRect: {
      left: virtualLeft,
      top: targetRow.top,
      width: metrics.cellWidth,
      height: metrics.cellHeight,
    },
  };
}

function getSummaryDropTargetAtPoint(clientX, clientY) {
  if (!state.draggedTerminalId || state.viewMode !== "brief") {
    return null;
  }
  const cell = getSummaryCellElementAtPoint(clientX, clientY);
  if (cell) {
    const cellIndex = Number(cell.dataset.summaryCellIndex);
    if (Number.isInteger(cellIndex) && cellIndex >= 0) {
      return { cell, cellIndex };
    }
  }
  return getSummaryVirtualDropTargetAtPoint(clientX, clientY);
}

function renderSummaryVirtualDropTarget(target) {
  if (!grid || !target?.virtualRect) {
    return;
  }
  const gridRect = grid.getBoundingClientRect();
  const marker = document.createElement("div");
  marker.className = "summary-grid-cell summary-grid-cell--virtual is-summary-drop-target";
  marker.dataset.summaryCellIndex = String(target.cellIndex);
  marker.setAttribute("aria-hidden", "true");
  marker.style.left = `${target.virtualRect.left - gridRect.left + grid.scrollLeft}px`;
  marker.style.top = `${target.virtualRect.top - gridRect.top + grid.scrollTop}px`;
  marker.style.width = `${target.virtualRect.width}px`;
  marker.style.height = `${target.virtualRect.height}px`;
  grid.appendChild(marker);
}

function applySummaryCellPreview(target) {
  clearSummaryCellPreview();
  if (!target?.cell) {
    renderSummaryVirtualDropTarget(target);
    return;
  }
  state.hoverSummaryCellIndex = target.cellIndex;
  target.cell.classList.add("is-summary-drop-target");
}

function moveSummaryTerminalToCell(sourceId, targetIndex) {
  if (!sourceId || !Number.isInteger(targetIndex) || targetIndex < 0) {
    return;
  }
  const visibleRecords = getPagedTerminals().items;
  if (!visibleRecords.some((record) => record.id === sourceId)) {
    return;
  }
  const model = ensureSummaryCellAssignments(visibleRecords);
  const sourceIndex = state.summaryCellAssignments[sourceId];
  if (!Number.isInteger(sourceIndex) || sourceIndex === targetIndex) {
    return;
  }

  const sourceRecord = state.terminals.get(sourceId);
  const targetRecord = model.slots[targetIndex] || null;
  state.summaryCellAssignments[sourceId] = targetIndex;
  if (targetRecord?.id && targetRecord.id !== sourceId) {
    state.summaryCellAssignments[targetRecord.id] = sourceIndex;
  }

  saveViewState();
  refreshWall();
  if (targetRecord?.id && targetRecord.id !== sourceId) {
    setMessage(`已交换 ${sourceRecord?.name || sourceId} 和 ${targetRecord.name || targetRecord.id} 的摘要格子`);
  } else {
    setMessage(`已移动 ${sourceRecord?.name || sourceId} 到摘要格子`);
  }
}

function commitSummaryCellDrag(clientX, clientY) {
  const target = getSummaryDropTargetAtPoint(clientX, clientY);
  if (!target) {
    return;
  }
  moveSummaryTerminalToCell(state.draggedTerminalId, target.cellIndex);
}

function getProgramInfo(record) {
  return record.program || { key: "unknown", label: "Unknown", source: "none", commandLine: "" };
}

function programSourceLabel(source) {
  if (source === "direct") return "直接识别";
  if (source === "process-tree") return "进程链";
  if (source === "screen-heuristic") return "屏幕特征";
  if (source === "fallback") return "回退";
  return "未知";
}

function shouldShowProgramChip(record) {
  return getProgramInfo(record).key !== "unknown";
}

function truncateProgramCommand(commandLine, maxLength = 72) {
  if (!commandLine || commandLine.length <= maxLength) {
    return commandLine || "";
  }
  return `${commandLine.slice(0, maxLength - 1)}…`;
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
  // split 引擎只在默认过滤器下生效；摘要视图使用独立的固定格子表格。
  const useSplitEngine = Boolean(state.layoutTree) && state.filter === "default" && state.viewMode !== "brief";
  const useSummaryGrid = state.viewMode === "brief";
  grid.dataset.engine = useSplitEngine ? "split" : useSummaryGrid ? "summary-grid" : "grid";
  grid.dataset.view = state.viewMode || "live";
  if (!useSummaryGrid) {
    clearSummaryGapGlow();
    delete grid.dataset.summaryRows;
    delete grid.dataset.summaryUsableRows;
    delete grid.dataset.summaryColumns;
  }
  grid.removeAttribute("role");
  grid.removeAttribute("aria-rowcount");
  grid.removeAttribute("aria-colcount");
  if (useSplitEngine) {
    grid.style.removeProperty("grid-template-columns");
    grid.style.removeProperty("grid-template-rows");
    grid.style.removeProperty("grid-auto-flow");
    grid.style.removeProperty("grid-auto-columns");
    grid.style.removeProperty("grid-auto-rows");
    grid.style.removeProperty("min-width");
    grid.style.removeProperty("height");
  } else if (useSummaryGrid) {
    // renderSummaryGrid owns the fixed row/column templates; incremental updates keep them intact.
  } else {
    grid.style.removeProperty("grid-auto-flow");
    grid.style.removeProperty("grid-auto-columns");
    grid.style.removeProperty("grid-auto-rows");
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
  if (state.filter === "done") return pool.filter((record) => shouldTrackTerminalStatus(record) && record.status === "done" && !state.hiddenTerminalIds.has(record.id));
  if (state.filter === "running") return pool.filter((record) => shouldTrackTerminalStatus(record) && record.status === "running" && !state.hiddenTerminalIds.has(record.id));
  if (state.filter === "attention") {
    // 进入"待处理"时会生成快照，快照期间不随状态变化自动删除终端
    if (state.attentionSnapshot) {
      return pool.filter((record) => shouldTrackTerminalStatus(record) && state.attentionSnapshot.has(record.id));
    }
    return pool.filter((record) => shouldTrackTerminalStatus(record) && ["error", "waiting"].includes(record.status) && !state.hiddenTerminalIds.has(record.id));
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
    if (!shouldTrackTerminalStatus(r)) continue;
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
  return [...state.terminals.values()].find((record) => shouldTrackTerminalStatus(record) && record.status === "error")
    || [...state.terminals.values()].find((record) => shouldTrackTerminalStatus(record) && record.status === "waiting");
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
  return Boolean(target.closest('.wall-card-terminal, button, input, textarea, details, summary, .wall-card-title-input'));
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
    if (!shouldTrackTerminalStatus(record)) continue;
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
  // 点击队列项视为“已处理”，状态不变前不再重复提醒
  const queuedItem = state.queue.find((q) => q.id === id);
  if (queuedItem) {
    dismissQueueItem(id, queuedItem.status);
  }
  // 点击队列项聚焦时，自动从队列移除
  state.queue = state.queue.filter((q) => q.id !== id);
  _lastQueueKey = "__force__";
  renderQueue();
  setMessage(`已切到 ${name}，已从队列移除`);
}

async function refreshTerminalSnapshot(record) {
  await request(`/api/terminals/${record.id}/refresh`, { method: "POST" });
  setMessage(`已刷新 ${record.name}`);
}

async function enterMonitorMode() {
  await request("/api/workspace/monitor-mode", { method: "POST" });
  setMessage("真实 iTerm 已退到后台，回到监控模式");
}

async function setTerminalDefaultFrame(record) {
  const frameData = await request(`/api/terminals/${record.id}/frame`);
  await request("/api/default-frame", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(frameData),
  });
  setMessage(`已将 ${record.name} 的位置设为默认模板`);
}

async function applyDefaultFrameToAll() {
  const result = await request("/api/default-frame/apply-all", { method: "POST" });
  setMessage(`已将 ${result.applied} 个终端对齐到默认位置`);
}

function getPrimaryTerminal() {
  for (const terminalId of state.orderedTerminalIds) {
    const record = state.terminals.get(terminalId);
    if (record?.isPrimary && record.status !== "closed") {
      return record;
    }
  }
  for (const record of state.terminals.values()) {
    if (record?.isPrimary && record.status !== "closed") {
      return record;
    }
  }
  return null;
}

function renderPrimaryFocus() {
  const container = document.getElementById("topbar-primary-focus");
  if (!container) return;

  const record = getPrimaryTerminal();
  container.innerHTML = "";
  container.classList.toggle("is-active", Boolean(record));
  if (!record) {
    container.removeAttribute("data-status");
    return;
  }
  container.dataset.status = record.status;

  const button = document.createElement("button");
  button.type = "button";
  button.className = `primary-focus-pill status-${record.status}`;
  button.title = `当前最重要任务：${displayTitle(record)}`;
  button.innerHTML = `
    <span class="primary-focus-pill-label" aria-hidden="true">★</span>
    <span class="primary-focus-pill-name">${escapeHtml(displayTitle(record))}</span>
    <span class="primary-focus-pill-status">${escapeHtml(statusLabel(record.status))}</span>
  `;
  button.onclick = async () => {
    try {
      await focusTerminal(record.id, record.name);
    } catch (error) {
      setMessage(error.message, true);
    }
  };
  container.appendChild(button);
}

async function toggleTerminalPrimary(record) {
  const nowPrimary = !record.isPrimary;
  const result = await request(`/api/terminals/${record.id}/primary`, {
    method: "POST",
    body: JSON.stringify({ primary: nowPrimary }),
  });

  if (nowPrimary) {
    for (const terminal of state.terminals.values()) {
      terminal.isPrimary = terminal.id === record.id;
    }
  } else {
    const current = state.terminals.get(record.id);
    if (current) {
      current.isPrimary = false;
    }
  }
  if (result.item) {
    state.terminals.set(result.item.id, result.item);
  }

  state._needFullRefresh = true;
  renderPrimaryFocus();
  scheduleRender(result.layout || null);
  setMessage(
    nowPrimary
      ? `已将 ${record.name} 标记为最重要任务`
      : `已取消 ${record.name} 的最重要任务标记`,
  );
}

async function toggleTerminalHidden(record) {
  const nowHidden = !state.hiddenTerminalIds.has(record.id);
  if (nowHidden) {
    state.hiddenTerminalIds.add(record.id);
    setMessage(`已隐藏 ${record.name}，可在"已隐藏"筛选中找到`);
    state.queue = state.queue.filter((q) => q.id !== record.id);
  } else {
    state.hiddenTerminalIds.delete(record.id);
    setMessage(`已取消隐藏 ${record.name}`);
    const terminal = state.terminals.get(record.id);
    if (terminal && shouldTrackTerminalStatus(terminal) && !state.queue.some((q) => q.id === record.id)) {
      if (ATTENTION_STATUSES.has(terminal.status)) {
        state.queue.unshift({ id: record.id, name: terminal.name || record.id, status: terminal.status });
      } else if (terminal.status === "done") {
        state.queue.push({ id: record.id, name: terminal.name || record.id, status: terminal.status });
      }
    }
  }
  saveViewState();
  refreshWall();
  try {
    await request(`/api/terminals/${record.id}/hidden`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hidden: nowHidden }),
    });
  } catch (error) {
    console.warn("同步隐藏状态到后端失败:", error);
  }
}

async function toggleTerminalMuted(record) {
  const nowMuted = !state.mutedTerminalIds.has(record.id);
  if (nowMuted) {
    state.mutedTerminalIds.add(record.id);
    state.queue = state.queue.filter((q) => q.id !== record.id);
    setMessage(`已静默 ${record.name}，状态变更不再进入队列`);
  } else {
    state.mutedTerminalIds.delete(record.id);
    setMessage(`已取消静默 ${record.name}`);
  }
  saveViewState();
  renderQueue();
  try {
    await request(`/api/terminals/${record.id}/muted`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ muted: nowMuted }),
    });
  } catch {
  }
}

async function closeTerminalRecord(record) {
  await request(`/api/terminals/${record.id}/close`, { method: "POST" });
  setMessage(`已关闭 ${record.name}`);
}

async function detachTerminal(record) {
  await request(`/api/terminals/${record.id}/detach`, { method: "POST" });
  setMessage("终端已解绑");
}

async function updateTerminalTags(record, nextTags) {
  const res = await request(`/api/terminals/${record.id}/tags`, {
    method: "POST",
    body: JSON.stringify({ tags: nextTags }),
  });
  if (res.allTags) {
    state.allTags = res.allTags;
    syncTagFilterSelect();
  }
  if (res.item) {
    state.terminals.set(res.item.id, res.item);
  }
  refreshWall();
}

async function sendTextToTerminal(record, text) {
  if (!text.trim()) {
    return;
  }
  state.focusedInputTerminalId = record.id;
  await request(`/api/terminals/${record.id}/send-text`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
  setMessage(`已向 ${record.name} 发送命令`);
}

/* ---- 顶部队列 ---- */
const ATTENTION_STATUSES = new Set(["waiting", "error"]);

function syncQueueCardHighlights() {
  const queuedStatusById = new Map(state.queue.map((item) => [item.id, item.status]));
  document.querySelectorAll(".wall-card[data-terminal-id]").forEach((card) => {
    const queuedStatus = queuedStatusById.get(card.dataset.terminalId);
    card.classList.toggle("wall-card--queued-done", queuedStatus === "done");
  });
}

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
      clearDismissedQueueItem(terminalId); // 状态变了，解除屏蔽
    } else {
      return; // 状态没变，继续屏蔽
    }
  }

  const terminal = state.terminals.get(terminalId);
  if (!terminal) return;
  const name = terminal.name || terminalId;
  const inQueue = state.queue.findIndex((q) => q.id === terminalId);
  if (!shouldTrackTerminalStatus(terminal)) {
    if (inQueue !== -1) state.queue.splice(inQueue, 1);
    return;
  }

  // 任意 → waiting/error：插到队列最前面
  if (ATTENTION_STATUSES.has(newStatus)) {
    if (inQueue !== -1) state.queue.splice(inQueue, 1);
    state.queue.unshift({ id: terminalId, name, status: newStatus });
    return;
  }

  // waiting/error 解决后直接移出队列，避免把已处理异常再次当成 done 提醒
  if (ATTENTION_STATUSES.has(oldStatus) && !ATTENTION_STATUSES.has(newStatus)) {
    if (inQueue !== -1) state.queue.splice(inQueue, 1);
    return;
  }

  // done：加入队列尾部。覆盖 running -> done、首次识别为 agent 后已 done 等场景。
  if (newStatus === "done") {
    if (inQueue === -1) {
      state.queue.push({ id: terminalId, name, status: newStatus });
    } else {
      state.queue[inQueue].status = newStatus;
    }
    return;
  }

  // running/idle/closed 不保留在队列中
  if (inQueue !== -1) state.queue.splice(inQueue, 1);
}

// 缓存上次队列快照，避免无变化时重建 DOM 导致 hover 闪烁
let _lastQueueKey = "";

function renderQueue() {
  const container = document.getElementById("topbar-queue");
  if (!container) return;
  // 生成当前队列的指纹，无变化则跳过
  const key = state.queue.map(q => `${q.id}:${q.name}:${q.status}`).join("|");
  if (key === _lastQueueKey) {
    syncQueueCardHighlights();
    return;
  }
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
      dismissQueueItem(item.id, item.status); // 记录移除时的状态
      state.queue = state.queue.filter((q) => q.id !== item.id);
      _lastQueueKey = "__force__";
      renderQueue();
      setMessage(`已将 ${item.name} 移出队列`);
    };
    container.appendChild(pill);
  }
  syncQueueCardHighlights();
}

function initQueueFromSnapshot() {
  state.queue = [];
  const attentionItems = [];
  const doneItems = [];
  for (const [id, terminal] of state.terminals) {
    if (state.hiddenTerminalIds.has(id)) continue;
    if (state.mutedTerminalIds.has(id)) continue;
    if (!shouldTrackTerminalStatus(terminal)) continue;
    const dismissedStatus = state.queueDismissed.get(id);
    if (dismissedStatus !== undefined) {
      if (dismissedStatus === terminal.status) {
        continue;
      }
      clearDismissedQueueItem(id);
    }
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

function syncRenamedTerminalLocally(terminalId, nextName) {
  const terminal = state.terminals.get(terminalId);
  if (terminal) {
    terminal.name = nextName;
  }
  const qItem = state.queue.find((q) => q.id === terminalId);
  if (qItem) {
    qItem.name = nextName;
    _lastQueueKey = "__force__";
    renderQueue();
  }
}

async function promptRenameTerminal(record) {
  const currentName = record?.name || "";
  const nextName = prompt("重命名终端", currentName);
  if (nextName === null) {
    return;
  }
  const cleanName = nextName.trim();
  if (!cleanName) {
    setMessage("名称不能为空", true);
    return;
  }
  if (cleanName === currentName) {
    return;
  }
  try {
    await renameTerminal(record.id, cleanName);
    syncRenamedTerminalLocally(record.id, cleanName);
    refreshWall();
    setMessage(`已将终端重命名为 ${cleanName}`);
  } catch (error) {
    setMessage(error.message, true);
  }
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
  card.tabIndex = 0;
  card.setAttribute("aria-label", `终端 ${displayTitle(record)}，可右键或使用 Shift+F10 打开操作菜单`);
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
      syncRenamedTerminalLocally(record.id, nextName);
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

  const terminalArea = card.querySelector(".wall-card-terminal") || card.querySelector(".wall-card-brief");
  const dragHandle = card.querySelector(".wall-card-drag-handle");
  const title = card.querySelector(".wall-card-title");
  const titleInput = card.querySelector(".wall-card-title-input");
  card.__startRename = startRename;
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

  card.onkeydown = (event) => {
    if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
      event.preventDefault();
      event.stopPropagation();
      const rect = card.getBoundingClientRect();
      openTerminalContextMenu(state.terminals.get(record.id) || record, rect.left + rect.width / 2, rect.top + 56);
    }
  };

  card.oncontextmenu = (event) => {
    if (isContextMenuEditableTarget(event.target)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    openTerminalContextMenu(state.terminals.get(record.id) || record, event.clientX, event.clientY);
  };

  if (terminalArea) terminalArea.onclick = async (event) => {
    // 点击终端区域时主动关闭所有已展开的顶部菜单（因 stopPropagation 会阻止冒泡）
    closeAllTopbarMenus();
    closeTerminalContextMenu();
    event.stopPropagation();
    if (state.activeCardDrag || state.draggedTerminalId) return;
    if (record.status === "closed") return;
    try {
      await focusTerminal(record.id, record.name);
    } catch (error) {
      setMessage(error.message, true);
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
  card.dataset.terminalId = record.id;

  // 摘要视图：简洁卡片
  if (state.viewMode === "brief") {
    if (state.editingTitleTerminalId === record.id) {
      card.className = getCardClassName(record, {
        brief: true,
        extraClasses: collectTransientCardClasses(card),
      });
      syncAgentCardClass(card, record);
      return card;
    }
    rerenderBriefCard(card, record);
    return card;
  }

  // 正在编辑此卡片标题时，跳过全卡 innerHTML 替换
  // 否则 DOM 重建会销毁聚焦中的 input，触发 blur → finishRename，打断用户输入
  if (state.editingTitleTerminalId === record.id) {
    card.className = getCardClassName(record, {
      extraClasses: collectTransientCardClasses(card),
    });
    syncAgentCardClass(card, record);
    updateTerminalSnapshot(record, card.querySelector(".wall-card-terminal"));
    return card;
  }

  card.className = getCardClassName(record);
  card.innerHTML = `
    <div class="wall-card-header">
      <div class="wall-card-title-row">
        <button type="button" class="ghost wall-card-drag-handle" title="拖拽排序" aria-label="拖拽排序"><svg width="100%" height="100%" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 1l-3 3.5h6L12 1z"/><path d="M12 23l-3-3.5h6L12 23z"/><path d="M1 12l3.5-3v6L1 12z"/><path d="M23 12l-3.5-3v6L23 12z"/><rect x="11.25" y="4" width="1.5" height="16" rx=".75"/><rect x="4" y="11.25" width="16" height="1.5" rx=".75"/></svg></button>
        <h2 class="wall-card-title" ${state.editingTitleTerminalId === record.id ? 'hidden' : ''}>${escapeHtml(displayTitle(record))}</h2>
        <input class="wall-card-title-input" type="text" value="${escapeHtml(record.name)}" ${state.editingTitleTerminalId === record.id ? '' : 'hidden'} />
        <span class="wall-card-primary-badge" hidden></span>
        <span class="wall-card-program-chip" hidden></span>
      </div>
    </div>
    <div class="wall-card-terminal"></div>
  `;

  updateTerminalSnapshot(record, card.querySelector(".wall-card-terminal"));
  updateCardMeta(card, record);
  bindCardActions(card, record);
  restoreInputFocus(card, record);

  return card;
}

function renderEmptyState() {
  grid.innerHTML = `
    <section class="empty-state">
      <svg class="empty-state-icon" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="rgba(148,163,184,0.3)" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="2" y="3" width="20" height="14" rx="2"/>
        <line x1="8" y1="21" x2="16" y2="21"/>
        <line x1="12" y1="17" x2="12" y2="21"/>
        <polyline points="7 8 10 11 7 14"/>
        <line x1="13" y1="14" x2="17" y2="14"/>
      </svg>
      <h2>还没有监控任务</h2>
      <p>点击标题 <strong>Monitor Wall → 启动并纳入监控</strong> 或快捷键 <strong>新建</strong> 创建第一个终端。</p>
      <p>2 个任务自动左右布局，3-4 个四宫格，5-6 个 2x3。</p>
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
    const preserveClasses = collectTransientCardClasses(card);
    if (state.viewMode === "brief") {
      if (state.editingTitleTerminalId === record.id) {
        syncAgentCardClass(card, record);
        card.className = getCardClassName(record, {
          brief: true,
          extraClasses: preserveClasses,
        });
        updateCardMeta(card, record);
      } else {
        rerenderBriefCard(card, record);
      }
    } else {
      card.className = getCardClassName(record, {
        extraClasses: preserveClasses,
      });
      updateTerminalSnapshot(record, card.querySelector(".wall-card-terminal"));
      updateCardMeta(card, record);
    }
  }
  // 更新统计和筛选
  syncFilterTabs();
  renderStats();
  renderPrimaryFocus();
  renderQueue();
}

function refreshBriefRelativeTimes() {
  if (state.viewMode !== "brief") {
    return;
  }
  const visibleCards = document.querySelectorAll(".wall-card--brief[data-terminal-id]");
  visibleCards.forEach((card) => {
    const terminalId = card.dataset.terminalId;
    const record = terminalId ? state.terminals.get(terminalId) : null;
    if (!record) {
      return;
    }
    const briefEl = card.querySelector(".wall-card-brief");
    if (!briefEl) {
      return;
    }
    const summaryStatus = record.aiSummaryStatus || "none";
    const reason = record.aiSummaryReason || "";
    if (summaryStatus === "done" || summaryStatus === "fallback") {
      const timeEl = briefEl.querySelector(".wall-card-brief-time");
      if (timeEl) {
        const nextLabel = formatSummaryTime(record.lastInteractionAt || 0);
        if (timeEl.textContent !== nextLabel) {
          timeEl.textContent = nextLabel;
        }
      }
      return;
    }
    if (summaryStatus === "none" && reason === "cooldown") {
      if (state.editingTitleTerminalId !== terminalId) {
        rerenderBriefCard(card, record);
      }
    }
  });
}

// 轻量更新卡片元信息：标题、状态 badge、摘要等（不重建 DOM）
function updateCardMeta(card, record) {
  // 正在编辑标题时跳过
  if (state.editingTitleTerminalId === record.id) return;
  syncAgentCardClass(card, record);
  const program = getProgramInfo(record);
  // 更新标题
  const title = card.querySelector(".wall-card-title");
  if (title) {
    title.textContent = card.classList.contains("wall-card--brief")
      ? (record.name || "")
      : displayTitle(record);
  }
  const folderTitle = card.querySelector(".wall-card-folder-title");
  if (folderTitle) {
    const folderPath = getSummaryFolderPath(record);
    const folderName = getSummaryFolderName(folderPath);
    folderTitle.textContent = folderName;
    folderTitle.title = folderPath || folderName;
  }
  const chip = card.querySelector(".wall-card-program-chip");
  if (chip) {
    chip.className = `wall-card-program-chip program-${program.key}`;
    chip.textContent = program.label;
    chip.hidden = !shouldShowProgramChip(record);
  }
  const primaryBadge = card.querySelector(".wall-card-primary-badge");
  if (primaryBadge) {
    primaryBadge.hidden = !record.isPrimary || record.status === "closed";
    if (!primaryBadge.hidden) {
      primaryBadge.textContent = "★";
      primaryBadge.setAttribute("title", "当前最重要任务");
      primaryBadge.setAttribute("aria-label", "当前最重要任务");
    }
  }
  const briefStatusChip = card.querySelector(".wall-card-brief-status-chip");
  if (briefStatusChip) {
    briefStatusChip.hidden = !shouldTrackTerminalStatus(record);
    if (!briefStatusChip.hidden) {
      briefStatusChip.className = `wall-card-brief-status-chip status-${record.status}`;
      briefStatusChip.textContent = statusLabel(record.status);
    }
  }
  const hideButton = card.querySelector("[data-action='toggle-hide']");
  if (hideButton) {
    syncHideButton(hideButton, record);
  }
  syncMuteButton(card.querySelector("[data-action='toggle-mute']"), state.mutedTerminalIds.has(record.id));
  // 更新状态 badge
  const badge = card.querySelector(".badge");
  if (badge) {
    badge.className = `badge status-${record.status}`;
    badge.textContent = statusLabel(record.status);
  }
  const programBadge = card.querySelector(".wall-card-program-badge");
  if (programBadge) {
    programBadge.className = `badge badge-program wall-card-program-badge program-${program.key}`;
    programBadge.textContent = program.label;
  }
  const programMeta = card.querySelector(".wall-card-program-meta");
  if (programMeta) {
    const commandLine = truncateProgramCommand(program.commandLine);
    const metaParts = [
      `程序：${program.label}`,
      `来源：${programSourceLabel(program.source)}`,
    ];
    if (commandLine) {
      metaParts.push(`命令：${commandLine}`);
      programMeta.title = program.commandLine || "";
    } else {
      programMeta.removeAttribute("title");
    }
    programMeta.textContent = metaParts.join(" · ");
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
  } else if (state.layoutTree && state.filter === "default" && state.viewMode !== "brief") {
    syncLayoutTree();
    treeElement = renderLayoutNode(state.layoutTree, new Set(pageInfo.items.map((record) => record.id)));
    if (treeElement) {
      grid.appendChild(treeElement);
    } else {
      renderEmptyState();
    }
  } else if (state.viewMode === "brief") {
    renderSummaryGrid(pageInfo.items);
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
  renderPrimaryFocus();
  renderQueue();
  if (isTerminalContextMenuOpen()) {
    renderOpenTerminalContextMenu();
  }
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
    } else {
      state.hiddenTerminalIds.delete(record.id);
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
  // 清理 queueDismissed 中不再存在的旧 ID
  for (const id of state.queueDismissed.keys()) {
    if (!state.terminals.has(id)) {
      state.queueDismissed.delete(id);
    }
  }
  pruneSummaryCellAssignments(new Set(terminals.map((record) => record.id)));
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
    closeAllTopbarMenus();
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
  loadSavedIdeas();
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
  setConnectionDialogStatus("connecting");
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
  let reconnectMarked = false;
  // 每个终端 ID 的限速状态：{ timer, lastTime, pending }
  const _termThrottle = new Map();
  const THROTTLE_MS = 200;

  function markSocketReconnecting() {
    const nextAttempt = reconnectMarked
      ? state.connectionDialog.attempt
      : state.connectionDialog.attempt + 1;
    reconnectMarked = true;
    setConnectionDialogStatus("reconnecting", {
      attempt: nextAttempt,
      nextRetryAt: Date.now() + CONNECTION_RETRY_DELAY_MS,
    });
  }

  // 处理一条 terminal-updated 消息（限速后实际执行）
  function _applyTerminalUpdate(payload) {
    const oldRecord = state.terminals.get(payload.terminal.id);
    const oldStatus = oldRecord ? oldRecord.status : null;
    if (payload.terminal.status === "waiting" && oldStatus !== "waiting" && shouldTrackTerminalStatus(payload.terminal)) {
      playWaitingAlert();
    }
    state.terminals.set(payload.terminal.id, payload.terminal);
    // 从后端同步隐藏状态（接管时恢复）
    if (payload.terminal.hidden) {
      state.hiddenTerminalIds.add(payload.terminal.id);
    } else {
      state.hiddenTerminalIds.delete(payload.terminal.id);
    }
    saveViewState();
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
      delete state.summaryCellAssignments[payload.terminal.id];
      saveViewState();
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

  socket.onopen = () => {
    setWebSocketStatus("connected");
    setConnectionDialogStatus("restoring");
    clearTransientErrorMessage();
    socket.send("ready");
  };
  socket.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "snapshot") {
      // 先恢复 App 监控状态，再调用 applySnapshot（内部会调用 refreshWall）
      if (payload.appMonitors) {
        applyAppMonitorSnapshot(payload.appMonitors);
      }
      applySnapshot(payload.terminals || [], payload.layout || null, payload.allTags || null);
      setConnectionDialogStatus("connected");
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
    markSocketReconnecting();
  };
  socket.onclose = () => {
    setWebSocketStatus("reconnecting", "WebSocket 重连中");
    markSocketReconnecting();
    setMessage("WebSocket 已断开，3 秒后重连", true);
    window.setTimeout(connectWebSocket, CONNECTION_RETRY_DELAY_MS);
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

async function handleAdoptAllSessions(btn) {
  if (!btn) {
    return;
  }
  btn.disabled = true;
  btn.textContent = "扫描中...";
  try {
    const result = await request("/api/terminals/adopt-all", { method: "POST" });
    const scanned = Number(result.scanned || 0);
    const adopted = Number(result.adopted || 0);
    const errors = Array.isArray(result.errors) ? result.errors : [];
    if (Array.isArray(result.items)) {
      applySnapshot(result.items, result.layout || null, result.allTags || null);
    }
    if (scanned === 0) {
      setMessage("没有发现可接管的终端");
      return;
    }
    if (errors.length > 0) {
      const firstError = errors[0];
      const failedName = firstError.name || firstError.sessionId || "未知终端";
      setMessage(`已接管 ${adopted}/${scanned} 个终端，${errors.length} 个失败：${failedName} ${firstError.error || ""}`, true);
      return;
    }
    setMessage(`已接管 ${adopted} 个终端`);
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "一键接管";
  }
}

// 顶部栏 App 监控按钮
const appMonitorButton = document.getElementById("app-monitor-btn");
if (appMonitorButton) {
  appMonitorButton.onclick = () => {
    closeAllTopbarMenus();
    openAppMonitorDialog();
  };
}
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

const adoptAllSessionsButton = document.getElementById("adopt-all-sessions");
if (adoptAllSessionsButton) {
  adoptAllSessionsButton.onclick = async () => {
    await handleAdoptAllSessions(adoptAllSessionsButton);
    doScanSessions();
  };
}

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
          const fallback = state.uiSettings?.[key] ?? DEFAULT_UI_SETTINGS[key];
          if (typeof DEFAULT_UI_SETTINGS[key] === "string") {
            return [key, String(field?.value ?? fallback)];
          }
          return [key, Number(field?.value ?? fallback)];
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
  const tuningPanel = document.getElementById("topbar-menu-tuning-extra")
    || document.querySelector(".topbar-menu--wide .topbar-menu-panel");
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
      <select id="target-screen-select">
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
  const tuningPanel = document.getElementById("topbar-menu-tuning-extra")
    || document.querySelector(".topbar-menu--wide .topbar-menu-panel");
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
initTopbarMenus();
bindTopbarNumberInputWheelGuard();
bindTerminalContextMenu();
bindIdeaDialog();

// ── 视图切换 ──
syncViewModeButtons();
viewModeButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    setViewMode(btn.dataset.view);
  });
});

// ── 摘要配置表单 ──
const summaryForm = document.getElementById("summary-config-form");
if (summaryForm) {
  // 加载现有配置
  fetch("/api/summary-config").then(r => r.json()).then((data) => {
    summaryForm.api_base.value = data.apiBase || "";
    summaryForm.api_key.value = "";
    summaryForm.api_key.placeholder = data.hasApiKey ? "已保存 API Key，留空则不修改" : "输入 API Key";
    summaryForm.model.value = data.model || "glm-4.6";
    summaryForm.interval_seconds.value = data.intervalSeconds || 30;
    summaryForm.active_interval.value = data.activeInterval || 10;
    summaryForm.fallback_retry_interval.value = data.fallbackRetryInterval || 30;
    // 缓存配置到 state，供 cooldown 倒计时计算使用
    state.summaryConfig = data;
  }).catch(() => {});
  // 保存配置
  summaryForm.addEventListener("submit", (e) => {
    e.preventDefault();
    fetch("/api/summary-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_base: summaryForm.api_base.value,
        api_key: summaryForm.api_key.value,
        model: summaryForm.model.value || "glm-4.6",
        interval_seconds: parseFloat(summaryForm.interval_seconds.value) || 30,
        active_interval: parseFloat(summaryForm.active_interval.value) || 10,
        fallback_retry_interval: parseFloat(summaryForm.fallback_retry_interval.value) || 30,
      }),
    }).then(r => r.json()).then((data) => {
      if (data.ok) {
        const triggered = Number(data.triggered || 0);
        setMessage(triggered > 0 ? `摘要配置已保存，已触发 ${triggered} 个终端重新总结` : "摘要配置已保存");
        // 更新本地缓存的配置
        state.summaryConfig.apiBase = summaryForm.api_base.value;
        state.summaryConfig.model = summaryForm.model.value || "glm-4.6";
        state.summaryConfig.intervalSeconds = parseFloat(summaryForm.interval_seconds.value) || 30;
        state.summaryConfig.activeInterval = parseFloat(summaryForm.active_interval.value) || 10;
        state.summaryConfig.fallbackRetryInterval = parseFloat(summaryForm.fallback_retry_interval.value) || 30;
        if (summaryForm.api_key.value) {
          summaryForm.api_key.value = "";
          summaryForm.api_key.placeholder = "已保存 API Key，留空则不修改";
          state.summaryConfig.hasApiKey = true;
        }
      }
    }).catch((e) => setMessage("保存失败: " + e.message, true));
  });
}

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
          .filter((r) => shouldTrackTerminalStatus(r) && ["error", "waiting"].includes(r.status) && !state.hiddenTerminalIds.has(r.id))
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
  if (state.viewMode === "brief") {
    state._needFullRefresh = true;
    scheduleRender();
    return;
  }
  if (state.layout.count > 0) {
    renderGridResizers();
  }
});

if ("ResizeObserver" in window && grid?.parentElement) {
  let summaryResizeTimer = null;
  const summaryResizeObserver = new ResizeObserver(() => {
    if (state.viewMode !== "brief") {
      return;
    }
    clearTimeout(summaryResizeTimer);
    summaryResizeTimer = setTimeout(() => {
      state._needFullRefresh = true;
      scheduleRender();
    }, 80);
  });
  summaryResizeObserver.observe(grid.parentElement);
}

if (grid) {
  grid.addEventListener("pointermove", handleSummaryGridPointerMove);
  grid.addEventListener("pointerleave", clearSummaryGapGlow);
  grid.addEventListener("pointercancel", clearSummaryGapGlow);
}

// 记录 mousedown 起始目标，防止从面板内拖选文字到外部松开时误关闭面板
let mousedownTarget = null;
document.addEventListener("mousedown", (e) => {
  mousedownTarget = e.target;
});

// 点击外部或按 Esc 关闭顶部菜单和卡片详情面板
document.addEventListener("click", (e) => {
  getTopbarMenus().forEach((menu) => {
    if (!menu.contains(e.target) && !menu.contains(mousedownTarget)) {
      closeTopbarMenu(menu);
    }
  });
  if (isTerminalContextMenuOpen()
    && !terminalContextMenu.contains(e.target)
    && !terminalContextMenu.contains(mousedownTarget)) {
    closeTerminalContextMenu();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeAllTopbarMenus();
    closeTerminalContextMenu();
    return;
  }
  if (e.key !== "Tab" || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) {
    return;
  }
  if (e.defaultPrevented || e.isComposing) {
    return;
  }
  if (hasOpenTopbarMenu() || isTerminalContextMenuOpen() || isKeyboardShortcutEditableTarget(e.target)) {
    return;
  }
  e.preventDefault();
  toggleViewMode();
});

window.addEventListener("resize", () => {
  closeTerminalContextMenu();
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
let _summaryRelativeTimeTimer = null;

async function fetchSystemStats() {
  try {
    const data = await request("/api/system-stats");
    const diskFreePercent = data.disk_total_gb > 0
      ? (data.disk_free_gb / data.disk_total_gb) * 100
      : 0;
    const diskFreePressure = Math.max(0, 100 - diskFreePercent);

    setStatusbarLabel(statCpuEl, `CPU ${data.cpu_percent.toFixed(0)}%`);
    setStatusbarLabel(statMemEl, `MEM ${data.memory_percent.toFixed(0)}%`);
    setStatusbarLabel(statDiskEl, `DISK ${data.disk_percent.toFixed(0)}%`);
    setStatusbarLabel(statDiskFreeEl, `FREE ${data.disk_free_gb}G`);

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

function startSummaryRelativeTimeRefresh() {
  if (_summaryRelativeTimeTimer !== null) {
    return;
  }
  refreshBriefRelativeTimes();
  _summaryRelativeTimeTimer = setInterval(refreshBriefRelativeTimes, 1000);
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

loadInitialState().catch((error) => {
  setMessage(error.message, true);
}).finally(() => {
  connectWebSocket();
  startSystemStatsPolling();
  startSummaryRelativeTimeRefresh();
});
