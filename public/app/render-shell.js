import {
  ACTIVITY_PANEL_LABEL,
  CONVERSATION_WINDOW_THRESHOLD,
  EXPANDED_VISIBLE_TURN_COUNT,
  INITIAL_VISIBLE_TURN_COUNT,
  PROJECT_PANEL_LABEL,
} from './constants.js';
import {
  escapeHtml,
  getCompactStatusLabel,
  getStatusLabel,
  getStatusTone,
  isAuthenticatedAppState,
  normalizeAuthState,
  normalizeMobileDrawerMode,
  normalizeSystemStatus,
  normalizeTheme,
} from './dom-utils.js';
import {
  findProject,
  getPendingSessionProject,
  getThreadTitle,
  resolveSelectedSessionTitle,
} from './project-utils.js';
import { formatStatus, formatTimestamp } from './session-utils.js';
import { renderActivityPanel } from './render-activity.js';
import {
  renderExternalSessionBadge,
  renderHistoryDialogContent,
  renderProjectGroup,
} from './render-projects.js';
import {
  renderThreadApprovals,
  renderThreadPendingQuestions,
  renderThreadRealtime,
  renderThreadSubagents,
} from './render-thread-panels.js';
import { renderTurn } from './render-turn-items.js';

const approvalControlsMarkupCache = new WeakMap();
export function renderProjectSidebar(state) {
  const header = renderProjectSidebarHeader(state.projects.length > 0, state.systemStatus);
  const footer = renderProjectSidebarFooter(state);

  if (state.loadError) {
    return [
      header,
      '<div class="empty-state empty-state--error">',
      `<strong>${escapeHtml(getStatusLabel(state.systemStatus))}</strong>`,
      `<p>${escapeHtml(state.loadError)}</p>`,
      '</div>',
      state.projects.map((project) => renderProjectGroup(project, state)).join(''),
      footer,
    ].join('');
  }

  if (!state.projects.length) {
    return [header, '<div class="empty-state">还没有项目或会话数据。</div>', footer].join('');
  }

  return [header, state.projects.map((project) => renderProjectGroup(project, state)).join(''), footer].join('');
}

export function renderHistoryDialog(state) {
  const dialogProject = findProject(state.projects ?? [], state.historyDialogProjectId);
  if (!dialogProject) {
    return '';
  }

  return [
    '<dialog class="history-dialog" open>',
    renderHistoryDialogContent(
      dialogProject,
      state.historyDialogTab,
      state.persistPanelPreference,
    ),
    '</dialog>',
  ].join('');
}

export function renderMobileDrawer(state) {
  const activeMode = normalizeMobileDrawerMode(state.mobileDrawerMode);
  const body =
    activeMode === 'activity'
      ? renderActivityPanel(state)
      : [
          '<div class="mobile-project-sidebar">',
          renderProjectSidebar({
            ...state,
            projectPanelCollapsed: false,
            activityPanelCollapsed: false,
          }),
          '</div>',
        ].join('');

  return [
    '<div class="mobile-drawer-shell">',
    '<div class="mobile-drawer-header">',
    '<div class="mobile-drawer-tablist" role="tablist" aria-label="移动抽屉面板">',
    renderMobileDrawerModeButton('sessions', '会话', activeMode),
    renderMobileDrawerModeButton('activity', ACTIVITY_PANEL_LABEL, activeMode),
    '</div>',
    '<div class="mobile-drawer-header-actions">',
    '<button class="mobile-drawer-close" type="button" data-mobile-drawer-close="true" aria-label="关闭抽屉">×</button>',
    '</div>',
    '</div>',
    `<div class="mobile-drawer-body">${body}</div>`,
    '</div>',
  ].join('');
}

export function renderProjectSidebarFooter(state) {
  const auth = normalizeAuthState(state?.auth);
  if (!auth.authenticated) {
    return '';
  }

  const currentTheme = normalizeTheme(state?.theme);
  const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
  const toggleLabel = nextTheme === 'dark' ? '切换到暗色主题' : '切换到浅色主题';
  const toggleIcon = currentTheme === 'dark' ? '☀' : '☾';

  return [
    '<div class="sidebar-footer">',
    '<div class="sidebar-footer-actions">',
    '<button class="sidebar-logout-button" type="button" data-logout-button="true">退出登录</button>',
    `<button class="sidebar-theme-toggle" type="button" data-theme-toggle="true" data-theme-next-theme="${nextTheme}" aria-label="${toggleLabel}" title="${toggleLabel}">`,
    `<span class="sidebar-theme-toggle-icon" aria-hidden="true">${toggleIcon}</span>`,
    '</button>',
    '</div>',
    '</div>',
  ].join('');
}

export function renderMobileDrawerModeButton(value, label, activeMode) {
  const selected = value === activeMode;
  return [
    `<button class="mobile-drawer-tab${selected ? ' mobile-drawer-tab--selected' : ''}" type="button" role="tab" aria-selected="${String(selected)}" data-mobile-drawer-mode="${value}" aria-pressed="${String(selected)}">`,
    escapeHtml(label),
    '</button>',
  ].join('');
}

export function renderThreadDetail(
  session,
  realtimeState = session?.realtime ?? null,
  systemStatus = null,
  approvalUiState = null,
  turnWindow = null,
  pendingActionUiState = null,
) {
  if (!session) {
    return [
      '<div class="thread-empty">',
      '<h2>会话详情</h2>',
      '<p>从左侧选择一个关注会话后，这里会显示完整历史记录。</p>',
      '</div>',
    ].join('');
  }

  const turnWindowState = resolveConversationTurnWindow(turnWindow, session.turns?.length ?? 0);
  const turns = session.turns?.length
    ? [
        renderConversationWindowNotice('before', turnWindowState.hiddenBeforeCount),
        session.turns
          .slice(turnWindowState.startTurnIndex, turnWindowState.endTurnIndex + 1)
          .map((turn, index) => renderTurn(turn, turnWindowState.startTurnIndex + index))
          .join(''),
        renderConversationWindowNotice('after', turnWindowState.hiddenAfterCount),
      ]
        .filter(Boolean)
        .join('')
    : '<div class="thread-empty-inline">这个会话还没有可显示的回合。</div>';

  return [
    '<article class="thread-view">',
    '<header class="thread-header">',
    '<div class="thread-header-top">',
    `<h2>${escapeHtml(getThreadTitle(session))}</h2>`,
    `<button class="thread-rename-button" type="button" data-session-rename-open="${escapeHtml(session.id)}">重命名</button>`,
    '</div>',
    '<div class="thread-meta">',
    renderExternalSessionBadge(session, { variant: 'meta' }),
    `<span class="meta-chip">${escapeHtml(session.cwd ?? 'Unknown Workspace')}</span>`,
    `<span class="meta-chip">${escapeHtml(formatStatus(session.status))}</span>`,
    `<span class="meta-chip">${escapeHtml(formatTimestamp(session.updatedAt ?? session.createdAt))}</span>`,
    '</div>',
    session.preview ? `<p class="thread-preview">${escapeHtml(session.preview)}</p>` : '',
    renderThreadApprovals(session, approvalUiState),
    renderThreadPendingQuestions(session, pendingActionUiState),
    renderThreadSubagents(session),
    renderThreadRealtime(realtimeState),
    '</header>',
    `<div class="turn-list">${turns}</div>`,
    '</article>',
  ].join('');
}

export function renderConversationDetail(
  state,
  detail,
  approvalUiState = null,
  pendingActionUiState = null,
  turnWindow = null,
) {
  if (detail) {
    return renderThreadDetail(
      detail,
      state.realtimeBySession[state.selectedSessionId] ?? null,
      state.systemStatus,
      approvalUiState,
      turnWindow,
      pendingActionUiState,
    );
  }

  const pendingProject = getPendingSessionProject(state);
  if (!pendingProject) {
    return renderThreadDetail(null, null, state.systemStatus);
  }

  return [
    '<div class="thread-empty thread-empty--draft">',
    '<h2>新会话</h2>',
    `<p>将在 ${escapeHtml(pendingProject.displayName ?? pendingProject.cwd ?? '当前项目')} 发送第一条消息后创建会话。</p>`,
    '</div>',
  ].join('');
}

export function resolveConversationTurnWindow(turnWindow, totalTurns) {
  const normalizedTotalTurns = Math.max(0, Number(totalTurns ?? 0));
  if (!turnWindow && normalizedTotalTurns <= CONVERSATION_WINDOW_THRESHOLD) {
    return {
      startTurnIndex: 0,
      endTurnIndex: Math.max(0, normalizedTotalTurns - 1),
      hiddenBeforeCount: 0,
      hiddenAfterCount: 0,
      totalTurns: normalizedTotalTurns,
      windowed: false,
      anchoredToLatest: true,
    };
  }

  const startTurnIndex = clampConversationTurnIndex(
    Math.min(
      Number(turnWindow?.startTurnIndex ?? normalizedTotalTurns - INITIAL_VISIBLE_TURN_COUNT),
      normalizedTotalTurns - 1,
    ),
    normalizedTotalTurns,
  );
  const visibleTurnCount = Math.max(
    1,
    Number(turnWindow?.endTurnIndex ?? normalizedTotalTurns - 1) - startTurnIndex + 1,
  );
  let endTurnIndex = Math.min(normalizedTotalTurns - 1, startTurnIndex + visibleTurnCount - 1);
  let nextStartTurnIndex = Math.max(0, endTurnIndex - visibleTurnCount + 1);

  if (turnWindow?.anchoredToLatest !== false) {
    endTurnIndex = normalizedTotalTurns - 1;
    nextStartTurnIndex = Math.max(0, endTurnIndex - visibleTurnCount + 1);
  }

  return {
    startTurnIndex: nextStartTurnIndex,
    endTurnIndex,
    hiddenBeforeCount: nextStartTurnIndex,
    hiddenAfterCount: Math.max(0, normalizedTotalTurns - endTurnIndex - 1),
    totalTurns: normalizedTotalTurns,
    windowed: true,
    anchoredToLatest: turnWindow?.anchoredToLatest !== false && endTurnIndex === normalizedTotalTurns - 1,
  };
}

export function createLatestConversationWindow(totalTurns) {
  const normalizedTotalTurns = Math.max(0, Number(totalTurns ?? 0));
  if (normalizedTotalTurns <= CONVERSATION_WINDOW_THRESHOLD) {
    return null;
  }

  const endTurnIndex = normalizedTotalTurns - 1;
  const startTurnIndex = Math.max(0, endTurnIndex - INITIAL_VISIBLE_TURN_COUNT + 1);
  return {
    startTurnIndex,
    endTurnIndex,
    totalTurns: normalizedTotalTurns,
    anchoredToLatest: true,
  };
}

export function createEarliestConversationWindow(totalTurns) {
  const normalizedTotalTurns = Math.max(0, Number(totalTurns ?? 0));
  if (normalizedTotalTurns <= CONVERSATION_WINDOW_THRESHOLD) {
    return null;
  }

  return {
    startTurnIndex: 0,
    endTurnIndex: Math.min(normalizedTotalTurns - 1, INITIAL_VISIBLE_TURN_COUNT - 1),
    totalTurns: normalizedTotalTurns,
    anchoredToLatest: false,
  };
}

export function expandConversationTurnWindow(turnWindow, totalTurns, direction) {
  const currentWindow = resolveConversationTurnWindow(turnWindow, totalTurns);
  if (!currentWindow.windowed) {
    return null;
  }

  if (direction === 'up') {
    return {
      ...currentWindow,
      startTurnIndex: Math.max(0, currentWindow.startTurnIndex - EXPANDED_VISIBLE_TURN_COUNT),
      anchoredToLatest: false,
    };
  }

  return {
    ...currentWindow,
    endTurnIndex: Math.min(totalTurns - 1, currentWindow.endTurnIndex + EXPANDED_VISIBLE_TURN_COUNT),
    anchoredToLatest: currentWindow.anchoredToLatest,
  };
}

export function ensureConversationTurnWindowContainsTurn(turnWindow, totalTurns, turnIndex) {
  const currentWindow = resolveConversationTurnWindow(turnWindow, totalTurns);
  if (!currentWindow.windowed) {
    return null;
  }

  const normalizedTurnIndex = clampConversationTurnIndex(turnIndex, totalTurns);
  if (
    normalizedTurnIndex >= currentWindow.startTurnIndex &&
    normalizedTurnIndex <= currentWindow.endTurnIndex
  ) {
    return currentWindow;
  }

  const visibleTurnCount = Math.max(1, currentWindow.endTurnIndex - currentWindow.startTurnIndex + 1);
  const endTurnIndex =
    normalizedTurnIndex > currentWindow.endTurnIndex
      ? normalizedTurnIndex
      : Math.min(totalTurns - 1, normalizedTurnIndex + visibleTurnCount - 1);
  const startTurnIndex = Math.max(0, endTurnIndex - visibleTurnCount + 1);

  return {
    startTurnIndex,
    endTurnIndex,
    totalTurns: Math.max(0, Number(totalTurns ?? 0)),
    anchoredToLatest: endTurnIndex === totalTurns - 1,
  };
}

export function sameConversationWindow(previousWindow, nextWindow) {
  if (!previousWindow && !nextWindow) {
    return true;
  }

  if (!previousWindow || !nextWindow) {
    return false;
  }

  return (
    previousWindow.startTurnIndex === nextWindow.startTurnIndex &&
    previousWindow.endTurnIndex === nextWindow.endTurnIndex &&
    previousWindow.totalTurns === nextWindow.totalTurns &&
    previousWindow.anchoredToLatest === nextWindow.anchoredToLatest
  );
}

export function clampConversationTurnIndex(turnIndex, totalTurns) {
  const normalizedTotalTurns = Math.max(0, Number(totalTurns ?? 0));
  if (normalizedTotalTurns <= 0) {
    return 0;
  }

  return Math.min(
    normalizedTotalTurns - 1,
    Math.max(0, Number.isFinite(Number(turnIndex)) ? Number(turnIndex) : 0),
  );
}

export function renderConversationWindowNotice(position, hiddenTurnCount) {
  if (!hiddenTurnCount) {
    return '';
  }

  return [
    `<div class="conversation-window-notice conversation-window-notice--${position}">`,
    position === 'before'
      ? `上方还有 ${escapeHtml(hiddenTurnCount)} 个回合，继续上滑加载`
      : `下方还有 ${escapeHtml(hiddenTurnCount)} 个回合，继续下滑加载`,
    '</div>',
  ].join('');
}

export function renderProjectSidebarHeader(hasProjects, systemStatus) {
  return [
    '<div class="sidebar-header">',
    '<div class="sidebar-header-top">',
    '<div class="sidebar-header-copy">',
    `<h2>${PROJECT_PANEL_LABEL}</h2>`,
    '</div>',
    '<button class="sidebar-add-project" type="button" data-project-dialog-open="true">添加项目</button>',
    '</div>',
    '</div>',
  ].join('');
}

export function renderStatusBadge(status) {
  const tone = getStatusTone(status);
  return [
    `<div class="status-badge status-badge--${tone}" title="${escapeHtml(status.lastError ?? getStatusLabel(status))}">`,
    `<span class="status-badge-dot status-badge-dot--${tone}"></span>`,
    `<span>${escapeHtml(getStatusLabel(status))}</span>`,
    '</div>',
  ].join('');
}

export function syncPanelLayout(appLayout, state) {
  if (!appLayout) {
    return;
  }

  appLayout.dataset.projectPanel = state.projectPanelCollapsed ? 'collapsed' : 'expanded';
  appLayout.dataset.activityPanel = state.activityPanelCollapsed ? 'collapsed' : 'expanded';
  appLayout.dataset.authLocked = String(!isAuthenticatedAppState(state));
  appLayout.style?.setProperty?.(
    '--project-panel-width',
    state.projectPanelCollapsed ? '0px' : `${state.projectPanelWidth}px`,
  );
  appLayout.style?.setProperty?.(
    '--activity-panel-width',
    state.activityPanelCollapsed ? '0px' : `${state.activityPanelWidth}px`,
  );
  appLayout.style?.setProperty?.(
    '--project-resizer-width',
    state.projectPanelCollapsed ? '0px' : '16px',
  );
  appLayout.style?.setProperty?.(
    '--activity-resizer-width',
    state.activityPanelCollapsed ? '0px' : '16px',
  );
}

export function syncTheme(documentRef, appLayout, state) {
  const theme = normalizeTheme(state?.theme);
  if (appLayout?.dataset) {
    appLayout.dataset.theme = theme;
  }

  if (documentRef?.body?.dataset) {
    documentRef.body.dataset.theme = theme;
  }

  if (documentRef?.documentElement?.dataset) {
    documentRef.documentElement.dataset.theme = theme;
  }

  syncStandaloneThemeToggle(documentRef?.querySelector?.('#auth-theme-toggle'), theme);
}

export function syncStandaloneThemeToggle(button, currentTheme) {
  if (!button) {
    return;
  }

  const theme = normalizeTheme(currentTheme);
  const nextTheme = theme === 'dark' ? 'light' : 'dark';
  const toggleLabel = nextTheme === 'dark' ? '切换到暗色主题' : '切换到浅色主题';
  const toggleIcon = theme === 'dark' ? '☀' : '☾';

  if (button.dataset) {
    button.dataset.themeNextTheme = nextTheme;
  }

  button.setAttribute?.('aria-label', toggleLabel);
  button.setAttribute?.('title', toggleLabel);
  button.innerHTML = `<span class="auth-theme-toggle-icon" aria-hidden="true">${toggleIcon}</span>`;
}

export function syncPanelToggleButton(button, { collapsed, label }) {
  if (!button) {
    return;
  }

  if (button.dataset) {
    button.dataset.panelState = collapsed ? 'collapsed' : 'expanded';
  }

  button.ariaExpanded = String(!collapsed);
  button.title = `${collapsed ? '展开' : '收起'}${label}`;
}

export function syncPanelResizer(handle, { hidden, label, width }) {
  if (!handle) {
    return;
  }

  handle.hidden = Boolean(hidden);
  handle.title = `${label}宽度 ${Math.round(width)}px`;
  handle.setAttribute?.('aria-valuenow', String(Math.round(width)));
}

export function syncConversationTitle(titleNode, title) {
  if (!titleNode) {
    return;
  }

  const normalizedTitle = typeof title === 'string' ? title : '';
  titleNode.textContent = normalizedTitle;
  titleNode.title = normalizedTitle;
  titleNode.hidden = !normalizedTitle;
}

export function syncConversationStatus(statusNode, status) {
  if (!statusNode) {
    return;
  }

  const normalizedStatus = normalizeSystemStatus(status);
  const tone = getStatusTone(normalizedStatus);
  const compactLabel = getCompactStatusLabel(normalizedStatus);
  const detailedLabel = getStatusLabel(normalizedStatus);
  statusNode.className = `conversation-status conversation-status--${tone}`;
  statusNode.dataset.statusTone = tone;
  statusNode.dataset.statusLabel = compactLabel;
  statusNode.title = normalizedStatus.lastError ?? detailedLabel;
  statusNode.textContent = compactLabel;
  statusNode.innerHTML = [
    '<span class="conversation-status-light" aria-hidden="true"></span>',
    `<span class="conversation-status-label">${escapeHtml(compactLabel)}</span>`,
  ].join('');
  statusNode.setAttribute?.('aria-label', compactLabel);
  statusNode.hidden = false;
}

export function syncConversationNavToggle(toggle, checked) {
  if (!toggle) {
    return;
  }

  toggle.checked = Boolean(checked);
}

export function syncApprovalModeControls(
  node,
  markup,
  authLocked = false,
) {
  if (!node) {
    return false;
  }

  const nextMarkup = authLocked ? '' : String(markup ?? '');
  const changed = approvalControlsMarkupCache.get(node) !== nextMarkup;
  if (changed) {
    node.innerHTML = nextMarkup;
    approvalControlsMarkupCache.set(node, nextMarkup);
  }
  node.hidden = authLocked;
  return changed;
}

export function syncAuthGate(authGate, loginError, loginButton, loginPassword, logoutButton, authState) {
  const auth = normalizeAuthState(authState);
  const locked = !auth.authenticated;

  if (authGate) {
    authGate.hidden = !locked;
  }

  if (loginError) {
    loginError.textContent = auth.error ?? '';
    loginError.hidden = !auth.error;
  }

  if (loginButton) {
    loginButton.disabled = auth.pending || auth.checking;
    loginButton.textContent = auth.pending ? '登录中…' : '登录';
  }

  if (loginPassword) {
    loginPassword.disabled = auth.pending || auth.checking;
  }

  if (logoutButton) {
    logoutButton.hidden = !auth.authenticated;
  }
}

export function shouldRenderConversationNav(state, session) {
  return Boolean(state.showConversationNav && session?.turns?.length);
}
