import {
  createDraftAttachment,
  formatAttachmentSize,
  ingestClipboardItems,
  validateDraftAttachments,
} from './composer-attachments.js';

const DEFAULT_PROJECT_PANEL_WIDTH = 312;
const DEFAULT_ACTIVITY_PANEL_WIDTH = 320;
const MIN_PANEL_WIDTH = 240;
const MAX_PANEL_WIDTH = 520;
const PROJECT_PANEL_LABEL = '项目/会话';
const ACTIVITY_PANEL_LABEL = '活动/任务';
const CONVERSATION_WINDOW_THRESHOLD = 40;
const INITIAL_VISIBLE_TURN_COUNT = 24;
const EXPANDED_VISIBLE_TURN_COUNT = 12;
const CONVERSATION_WINDOW_EDGE_TRIGGER_PX = 240;
const CONVERSATION_AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 160;

const initialState = {
  projects: [],
  selectedSessionId: null,
  pendingSessionProjectId: null,
  sessionDetailsById: {},
  subagentDialog: null,
  approvalMode: 'auto-approve',
  sessionOptions: createInitialSessionOptions(),
  sessionSettingsById: {},
  realtimeBySession: {},
  diffBySession: {},
  turnStatusBySession: {},
  activeTurnIdBySession: {},
  unreadBySession: {},
  composerDraft: '',
  composerAttachments: [],
  composerAttachmentError: null,
  taskSummaryCollapsedBySession: {},
  composerSettingsCollapsedByScope: {},
  composerAttachmentMenuOpen: false,
  historyDialogProjectId: null,
  historyDialogTab: 'active',
  projectPanelCollapsed: false,
  activityPanelCollapsed: true,
  persistPanelPreference: true,
  projectPanelWidth: DEFAULT_PROJECT_PANEL_WIDTH,
  activityPanelWidth: DEFAULT_ACTIVITY_PANEL_WIDTH,
  showConversationNav: true,
  mobileDrawerOpen: false,
  mobileDrawerMode: 'sessions',
  auth: createInitialAuthState(),
  loadError: null,
  systemStatus: createInitialSystemStatus(),
};

const PANEL_PREFERENCE_STORAGE_KEY = 'codex.webAgentConsole.preferences.v1';

export function reduceState(state = initialState, action) {
  switch (action.type) {
    case 'projects_loaded': {
      const runtimeState = collectProjectRuntimeState(action.payload.projects ?? []);
      const sessionSettings = collectProjectSessionSettings(action.payload.projects ?? []);
      const nextHistoryDialogProjectId = keepDialogProject(
        action.payload.projects ?? [],
        state.historyDialogProjectId,
      );
      const nextSelectedSessionId = keepSelectedSession(
        action.payload.projects ?? [],
        state.selectedSessionId,
      );
      return {
        ...state,
        projects: action.payload.projects ?? [],
        selectedSessionId: nextSelectedSessionId,
        pendingSessionProjectId: keepPendingProject(
          action.payload.projects ?? [],
          state.pendingSessionProjectId,
        ),
        historyDialogProjectId: nextHistoryDialogProjectId,
        historyDialogTab: nextHistoryDialogProjectId ? state.historyDialogTab : 'active',
        unreadBySession: filterSessionCountMap(action.payload.projects ?? [], state.unreadBySession),
        turnStatusBySession: runtimeState.turnStatusBySession,
        activeTurnIdBySession: runtimeState.activeTurnIdBySession,
        diffBySession: runtimeState.diffBySession,
        realtimeBySession: runtimeState.realtimeBySession,
        sessionSettingsById: {
          ...state.sessionSettingsById,
          ...sessionSettings,
        },
        loadError: null,
      };
    }
    case 'projects_load_failed':
      return {
        ...state,
        loadError: action.payload.error,
      };
    case 'system_status_loaded':
      return {
        ...state,
        systemStatus: normalizeSystemStatus(action.payload),
      };
    case 'approval_mode_loaded':
    case 'approval_mode_changed':
      return {
        ...state,
        approvalMode: normalizeApprovalMode(action.payload?.mode),
      };
    case 'session_options_loaded':
      return {
        ...state,
        sessionOptions: normalizeSessionOptions(action.payload),
      };
    case 'session_settings_loaded':
    case 'session_settings_changed':
      return {
        ...state,
        sessionSettingsById: {
          ...state.sessionSettingsById,
          [action.payload.threadId]: normalizeSessionSettings(action.payload.settings),
        },
      };
    case 'auth_session_check_started':
      return {
        ...state,
        auth: normalizeAuthState({
          ...state.auth,
          checking: true,
          pending: false,
          error: null,
        }),
      };
    case 'auth_login_started':
      return {
        ...state,
        auth: normalizeAuthState({
          ...state.auth,
          required: true,
          authenticated: false,
          checking: false,
          pending: true,
          error: null,
        }),
      };
    case 'auth_state_changed':
      return applyAuthState(state, {
        ...state.auth,
        ...(action.payload ?? {}),
      });
    case 'history_dialog_opened':
      return {
        ...state,
        historyDialogProjectId: action.payload.projectId,
        historyDialogTab: 'active',
      };
    case 'history_dialog_tab_selected':
      return {
        ...state,
        historyDialogTab: normalizeHistoryDialogTab(action.payload.tab),
      };
    case 'history_dialog_closed':
      return {
        ...state,
        historyDialogProjectId: null,
        historyDialogTab: 'active',
      };
    case 'composer_text_changed':
      return {
        ...state,
        composerDraft: action.payload.text ?? '',
      };
    case 'composer_attachments_added':
      return {
        ...state,
        composerAttachments: [
          ...(state.composerAttachments ?? []),
          ...normalizeComposerAttachments(action.payload.attachments),
        ],
        composerAttachmentError: null,
        composerAttachmentMenuOpen: false,
      };
    case 'composer_attachment_removed':
      return {
        ...state,
        composerAttachments: (state.composerAttachments ?? []).filter(
          (attachment) => attachment.id !== action.payload.id,
        ),
        composerAttachmentError: null,
      };
    case 'composer_attachments_cleared':
      return {
        ...state,
        composerAttachments: [],
        composerAttachmentError: null,
      };
    case 'composer_attachment_error_changed':
      return {
        ...state,
        composerAttachmentError: normalizeComposerAttachmentError(action.payload.error),
      };
    case 'project_panel_toggled':
      return {
        ...state,
        projectPanelCollapsed: !state.projectPanelCollapsed,
      };
    case 'activity_panel_toggled':
      return {
        ...state,
        activityPanelCollapsed: !state.activityPanelCollapsed,
      };
    case 'panel_preference_changed':
      return {
        ...state,
        persistPanelPreference: true,
      };
    case 'project_panel_resized':
      return {
        ...state,
        projectPanelWidth: clampPanelWidth(action.payload.width, DEFAULT_PROJECT_PANEL_WIDTH),
      };
    case 'activity_panel_resized':
      return {
        ...state,
        activityPanelWidth: clampPanelWidth(action.payload.width, DEFAULT_ACTIVITY_PANEL_WIDTH),
      };
    case 'conversation_nav_visibility_toggled':
      return {
        ...state,
        showConversationNav:
          typeof action.payload?.visible === 'boolean'
            ? action.payload.visible
            : !state.showConversationNav,
      };
    case 'task_summary_visibility_toggled': {
      const sessionId = String(action.payload?.sessionId ?? state.selectedSessionId ?? '').trim();
      if (!sessionId) {
        return state;
      }

      return {
        ...state,
        taskSummaryCollapsedBySession: {
          ...state.taskSummaryCollapsedBySession,
          [sessionId]: Boolean(action.payload?.collapsed),
        },
      };
    }
    case 'composer_settings_visibility_toggled': {
      const scopeId = String(action.payload?.scopeId ?? '').trim();
      if (!scopeId) {
        return state;
      }

      return {
        ...state,
        composerSettingsCollapsedByScope: {
          ...state.composerSettingsCollapsedByScope,
          [scopeId]: Boolean(action.payload?.collapsed),
        },
      };
    }
    case 'composer_attachment_menu_toggled':
      return {
        ...state,
        composerAttachmentMenuOpen:
          typeof action.payload?.open === 'boolean'
            ? action.payload.open
            : !state.composerAttachmentMenuOpen,
      };
    case 'mobile_drawer_opened':
      return {
        ...state,
        mobileDrawerOpen: true,
        mobileDrawerMode: normalizeMobileDrawerMode(action.payload?.mode),
      };
    case 'mobile_drawer_mode_changed':
      return {
        ...state,
        mobileDrawerMode: normalizeMobileDrawerMode(action.payload?.mode),
      };
    case 'mobile_drawer_closed':
      return {
        ...state,
        mobileDrawerOpen: false,
        mobileDrawerMode: 'sessions',
      };
    case 'project_collapsed_updated':
      return {
        ...state,
        projects: updateProject(state.projects, action.payload.projectId, (project) => ({
          ...project,
          collapsed: action.payload.collapsed,
        })),
      };
    case 'session_selected': {
      const preserveDialog =
        state.subagentDialog?.threadId === action.payload.id;
      const preserveComposerAttachments = action.payload?.preserveComposerAttachments === true;
      return {
        ...state,
        selectedSessionId: action.payload.id,
        pendingSessionProjectId: null,
        composerAttachments: preserveComposerAttachments ? state.composerAttachments : [],
        composerAttachmentError: preserveComposerAttachments ? state.composerAttachmentError : null,
        composerAttachmentMenuOpen: false,
        unreadBySession: clearSessionUnread(state.unreadBySession, action.payload.id),
        subagentDialog: preserveDialog ? state.subagentDialog : null,
      };
    }
    case 'subagent_dialog_opened':
      return {
        ...state,
        subagentDialog: normalizeSubagentDialogSelection(action.payload),
      };
    case 'subagent_dialog_closed':
      return {
        ...state,
        subagentDialog: null,
      };
    case 'project_session_drafted':
      return {
        ...state,
        selectedSessionId: null,
        pendingSessionProjectId: action.payload.projectId,
        composerAttachments: [],
        composerAttachmentError: null,
        composerAttachmentMenuOpen: false,
      };
    case 'project_session_draft_cleared':
      return {
        ...state,
        pendingSessionProjectId: null,
        composerAttachments: [],
        composerAttachmentError: null,
      };
    case 'session_detail_loaded':
      return replaceSessionRuntimeState({
        ...state,
        projects: syncThreadIntoProjects(state.projects, action.payload.thread),
        sessionDetailsById: {
          ...state.sessionDetailsById,
          [action.payload.thread.id]: normalizeThreadDetail(action.payload.thread),
        },
        sessionSettingsById: action.payload.thread?.id
          ? {
              ...state.sessionSettingsById,
              [action.payload.thread.id]: normalizeSessionSettings(action.payload.thread.settings),
            }
          : state.sessionSettingsById,
      }, action.payload.thread);
    case 'approval_requested':
      return applyApprovalUpdate(state, action.payload?.approval, 'requested');
    case 'approval_resolved':
      return applyApprovalUpdate(state, action.payload?.approval, 'resolved');
    case 'pending_question_requested':
      return applyPendingQuestionUpdate(state, action.payload?.question, 'requested');
    case 'pending_question_resolved':
      return applyPendingQuestionUpdate(state, action.payload?.question, 'resolved');
    case 'user_turn_submitted':
      return updateSessionThread(state, action.payload.threadId, (thread) =>
        upsertThreadTurn(thread, action.payload.turnId, (turn) => ({
          ...turn,
          status: 'started',
          items: upsertTurnItem(
            turn.items ?? [],
            {
              type: 'userMessage',
              id: `user-${action.payload.turnId}`,
              content: buildOptimisticUserContent(
                action.payload.text,
                action.payload.attachments,
              ),
            },
            (item) => item.id === `user-${action.payload.turnId}`,
          ),
        })),
      );
    case 'turn_started':
      return updateSessionThread(markSessionUnreadIfBackground({
        ...state,
        turnStatusBySession: {
          ...state.turnStatusBySession,
          [action.payload.threadId]: 'started',
        },
        activeTurnIdBySession: {
          ...state.activeTurnIdBySession,
          [action.payload.threadId]: action.payload.turnId,
        },
      }, action.payload.threadId), action.payload.threadId, (thread) =>
        upsertThreadTurn(thread, action.payload.turnId, (turn) => ({
          ...turn,
          status: 'started',
        })),
      );
    case 'thread_item_started':
      return updateSessionThread(markSessionUnreadIfBackground(state, action.payload.threadId), action.payload.threadId, (thread) =>
        upsertThreadTurn(thread, action.payload.turnId, (turn) => ({
          ...turn,
          status: turn.status ?? 'started',
          items: upsertTurnItem(turn.items ?? [], normalizeStreamedItem(action.payload.item), (item) => {
            return item.id === action.payload.item.id;
          }),
        })),
      );
    case 'thread_item_delta':
      return updateSessionThread(markSessionUnreadIfBackground(state, action.payload.threadId), action.payload.threadId, (thread) =>
        upsertThreadTurn(thread, action.payload.turnId, (turn) => ({
          ...turn,
          status: turn.status ?? 'started',
          items: appendItemDelta(turn.items ?? [], action.payload),
        })),
      );
    case 'thread_item_completed':
      return updateSessionThread(markSessionUnreadIfBackground(state, action.payload.threadId), action.payload.threadId, (thread) =>
        upsertThreadTurn(thread, action.payload.turnId, (turn) => ({
          ...turn,
          status: turn.status ?? 'started',
          items: upsertTurnItem(
            turn.items ?? [],
            normalizeStreamedItem(action.payload.item, { streaming: false }),
            (item) => item.id === action.payload.item.id,
          ),
        })),
      );
    case 'thread_realtime_started':
      return updateSessionRealtime(markSessionUnreadIfBackground(state, action.payload.threadId), action.payload.threadId, () =>
        createRealtimeSessionState({
          status: 'started',
          sessionId: action.payload.sessionId ?? null,
        }),
      );
    case 'thread_realtime_item_added':
      return updateSessionRealtime(markSessionUnreadIfBackground(state, action.payload.threadId), action.payload.threadId, (realtime) => ({
        ...realtime,
        status: realtime.status === 'idle' ? 'started' : realtime.status,
        items: [
          ...realtime.items,
          createRealtimeItemEntry(realtime.items.length + 1, action.payload.item),
        ],
      }));
    case 'thread_realtime_audio_delta':
      return updateSessionRealtime(markSessionUnreadIfBackground(state, action.payload.threadId), action.payload.threadId, (realtime) => {
        const audio = action.payload.audio ?? {};
        const data = String(audio.data ?? '');
        return {
          ...realtime,
          status: realtime.status === 'idle' ? 'started' : realtime.status,
          audioChunkCount: realtime.audioChunkCount + 1,
          audioByteCount: realtime.audioByteCount + data.length,
          lastAudio: {
            sampleRate: audio.sampleRate ?? null,
            numChannels: audio.numChannels ?? null,
            samplesPerChannel: audio.samplesPerChannel ?? null,
          },
        };
      });
    case 'thread_realtime_error':
      return updateSessionRealtime(markSessionUnreadIfBackground(state, action.payload.threadId), action.payload.threadId, (realtime) => ({
        ...realtime,
        status: 'error',
        lastError: action.payload.message ?? null,
      }));
    case 'thread_realtime_closed':
      return updateSessionRealtime(markSessionUnreadIfBackground(state, action.payload.threadId), action.payload.threadId, (realtime) => ({
        ...realtime,
        status: 'closed',
        closeReason: action.payload.reason ?? null,
      }));
    case 'turn_completed': {
      const completedTurnState = { ...state.activeTurnIdBySession };
      delete completedTurnState[action.payload.threadId];
      return updateSessionThread(markSessionUnreadIfBackground({
        ...state,
        turnStatusBySession: {
          ...state.turnStatusBySession,
          [action.payload.threadId]: 'completed',
        },
        activeTurnIdBySession: completedTurnState,
      }, action.payload.threadId), action.payload.threadId, (thread) =>
        upsertThreadTurn(thread, action.payload.turnId, (turn) => ({
          ...turn,
          status: 'completed',
          items: markTurnItemsSettled(turn.items ?? []),
        })),
      );
    }
    case 'turn_interrupt_requested':
      return {
        ...state,
        turnStatusBySession: {
          ...state.turnStatusBySession,
          [action.payload.threadId]: 'interrupting',
        },
      };
    case 'turn_diff_updated':
      return {
        ...state,
        diffBySession: {
          ...state.diffBySession,
          [action.payload.threadId]: action.payload.diff,
        },
      };
    case 'turn_plan_updated':
      return updateSessionThread(
        markSessionUnreadIfBackground(state, action.payload.threadId),
        action.payload.threadId,
        (thread) =>
          upsertThreadTurn(thread, action.payload.turnId, (turn) => ({
            ...turn,
            status: turn.status ?? 'started',
            plan: mergeTurnPlan(turn.plan, action.payload),
          })),
      );
    case 'thread_name_updated':
      return {
        ...state,
        projects: updateThreadNameInProjects(
          state.projects,
          action.payload.threadId,
          action.payload.name,
        ),
        sessionDetailsById: updateThreadNameInSessionDetails(
          state.sessionDetailsById,
          action.payload.threadId,
          action.payload.name,
        ),
      };
    case 'session_runtime_reconciled':
      return applyRuntimeSnapshotToState(
        markSessionUnreadIfBackground(state, action.payload.threadId),
        action.payload.threadId,
        action.payload.runtime,
      );
    default:
      return state;
  }
}

export function createAppController({
  fetchImpl = globalThis.fetch.bind(globalThis),
  eventSourceFactory = (url) => new EventSource(url),
  documentRef = globalThis.document ?? null,
  storageImpl = globalThis.localStorage ?? null,
} = {}) {
  let state = restorePersistentState(initialState, storageImpl);
  let eventSource = null;
  let statusTimer = null;
  let pendingRenameSessionId = null;
  let approvalModeRequestInFlight = false;
  const approvalRequestIdsInFlight = new Set();
  let approvalUiError = null;
  const pendingActionRequestIdsInFlight = new Set();
  let pendingActionUiError = null;
  let sessionSettingsRequestInFlight = false;
  let sessionSettingsPendingThreadId = null;
  let sessionSettingsUiError = null;
  let boundConversationScroll = null;
  let conversationScrollFramePending = false;
  let suppressConversationScrollHandling = false;
  const conversationWindowBySession = new Map();
  const renderCache = {
    sessionList: createMarkupCache(),
    conversationBody: createMarkupCache(),
    activityPanel: createMarkupCache(),
  };

  function stopStatusPolling() {
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
  }

  function disconnectEvents() {
    eventSource?.close?.();
    eventSource = null;
  }

  function invalidateConversationMarkupCache() {
    renderCache.conversationBody.keyParts = null;
  }

  function getConversationWindow(sessionId = state.selectedSessionId, detail = state.sessionDetailsById?.[sessionId]) {
    if (!sessionId || !detail) {
      return null;
    }

    const totalTurns = detail.turns?.length ?? 0;
    const nextWindow = resolveConversationTurnWindow(conversationWindowBySession.get(sessionId), totalTurns);
    if (!nextWindow.windowed) {
      conversationWindowBySession.delete(sessionId);
      return null;
    }

    const currentWindow = conversationWindowBySession.get(sessionId);
    if (!sameConversationWindow(currentWindow, nextWindow)) {
      conversationWindowBySession.set(sessionId, nextWindow);
    }

    return nextWindow;
  }

  function setConversationWindow(sessionId, detail, nextWindow) {
    if (!sessionId || !detail) {
      return null;
    }

    const normalizedWindow = resolveConversationTurnWindow(nextWindow, detail.turns?.length ?? 0);
    if (!normalizedWindow.windowed) {
      conversationWindowBySession.delete(sessionId);
      invalidateConversationMarkupCache();
      return null;
    }

    conversationWindowBySession.set(sessionId, normalizedWindow);
    invalidateConversationMarkupCache();
    return normalizedWindow;
  }

  function syncConversationWindowForDetail(sessionId, detail, { anchorLatest = false } = {}) {
    if (!sessionId || !detail) {
      return null;
    }

    if (anchorLatest) {
      return setConversationWindow(sessionId, detail, createLatestConversationWindow(detail.turns?.length ?? 0));
    }

    const totalTurns = detail.turns?.length ?? 0;
    const currentWindow = conversationWindowBySession.get(sessionId);
    const nextWindow = resolveConversationTurnWindow(currentWindow, totalTurns);
    if (!nextWindow.windowed) {
      conversationWindowBySession.delete(sessionId);
      invalidateConversationMarkupCache();
      return null;
    }

    conversationWindowBySession.set(sessionId, nextWindow);
    invalidateConversationMarkupCache();
    return nextWindow;
  }

  function bindConversationScroll(element) {
    if (!element || boundConversationScroll === element) {
      return;
    }

    if (boundConversationScroll?.removeEventListener) {
      boundConversationScroll.removeEventListener('scroll', handleConversationScroll);
    }

    boundConversationScroll = element;
    boundConversationScroll.addEventListener('scroll', handleConversationScroll);
  }

  function handleConversationScroll() {
    if (suppressConversationScrollHandling || conversationScrollFramePending) {
      return;
    }

    conversationScrollFramePending = true;
    requestAnimationFrameSafe(documentRef?.defaultView ?? globalThis, () => {
      conversationScrollFramePending = false;
      maybeExpandConversationWindowFromScroll();
    });
  }

  function maybeExpandConversationWindowFromScroll() {
    if (suppressConversationScrollHandling) {
      return false;
    }

    const conversationScroll = documentRef?.querySelector?.('#conversation-scroll');
    const detail = state.sessionDetailsById?.[state.selectedSessionId];
    const currentWindow = getConversationWindow(state.selectedSessionId, detail);
    if (!conversationScroll || !detail || !currentWindow) {
      return false;
    }

    if (
      Number(conversationScroll.scrollTop ?? 0) <= CONVERSATION_WINDOW_EDGE_TRIGGER_PX &&
      currentWindow.hiddenBeforeCount > 0
    ) {
      return expandConversationWindow('up');
    }

    const distanceToBottom =
      Number(conversationScroll.scrollHeight ?? 0) -
      Number(conversationScroll.clientHeight ?? 0) -
      Number(conversationScroll.scrollTop ?? 0);
    if (
      distanceToBottom <= CONVERSATION_WINDOW_EDGE_TRIGGER_PX &&
      currentWindow.hiddenAfterCount > 0
    ) {
      return expandConversationWindow('down');
    }

    return false;
  }

  function expandConversationWindow(direction) {
    const sessionId = state.selectedSessionId;
    const detail = state.sessionDetailsById?.[sessionId];
    const conversationScroll = documentRef?.querySelector?.('#conversation-scroll');
    const currentWindow = getConversationWindow(sessionId, detail);
    if (!sessionId || !detail || !conversationScroll || !currentWindow) {
      return false;
    }

    const nextWindow = expandConversationTurnWindow(currentWindow, detail.turns?.length ?? 0, direction);
    if (!nextWindow || sameConversationWindow(currentWindow, nextWindow)) {
      return false;
    }

    const previousScrollTop = Number(conversationScroll.scrollTop ?? 0);
    const previousScrollHeight = Number(conversationScroll.scrollHeight ?? 0);
    setConversationWindow(sessionId, detail, nextWindow);
    render();

    if (direction === 'up') {
      const nextScrollHeight = Number(conversationScroll.scrollHeight ?? previousScrollHeight);
      const scrollDelta = Math.max(0, nextScrollHeight - previousScrollHeight);
      suppressConversationScrollHandling = true;
      setConversationScrollTop(conversationScroll, previousScrollTop + scrollDelta, { smooth: false });
      requestAnimationFrameSafe(documentRef?.defaultView ?? globalThis, () => {
        suppressConversationScrollHandling = false;
      });
    }

    return true;
  }

  function ensureConversationWindowBoundary(boundary) {
    const sessionId = state.selectedSessionId;
    const detail = state.sessionDetailsById?.[sessionId];
    if (!sessionId || !detail) {
      return null;
    }

    const nextWindow =
      boundary === 'top'
        ? createEarliestConversationWindow(detail.turns?.length ?? 0)
        : createLatestConversationWindow(detail.turns?.length ?? 0);
    const currentWindow = getConversationWindow(sessionId, detail);
    if (sameConversationWindow(currentWindow, nextWindow)) {
      return currentWindow;
    }

    return setConversationWindow(sessionId, detail, nextWindow);
  }

  function ensureConversationWindowContainsTurn(turnIndex) {
    const sessionId = state.selectedSessionId;
    const detail = state.sessionDetailsById?.[sessionId];
    if (!sessionId || !detail) {
      return null;
    }

    const currentWindow = getConversationWindow(sessionId, detail);
    const nextWindow = ensureConversationTurnWindowContainsTurn(
      currentWindow,
      detail.turns?.length ?? 0,
      turnIndex,
    );
    if (sameConversationWindow(currentWindow, nextWindow)) {
      return currentWindow;
    }

    return setConversationWindow(sessionId, detail, nextWindow);
  }

  function setAuthenticated(required = false) {
    applyAction({
      type: 'auth_state_changed',
      payload: {
        required: Boolean(required),
        authenticated: true,
        checking: false,
        pending: false,
        error: null,
      },
    });
    controller.connectEvents();
  }

  function handleUnauthorized(message = null) {
    stopStatusPolling();
    disconnectEvents();
    clearLoginPassword(documentRef);
    applyAction({
      type: 'auth_state_changed',
      payload: {
        required: true,
        authenticated: false,
        checking: false,
        pending: false,
        error: message,
      },
    });
    return null;
  }

  async function requestProtectedJson(url, options) {
    try {
      return await requestJson(fetchImpl, url, options);
    } catch (error) {
      if (error?.status === 401) {
        return handleUnauthorized();
      }

      throw error;
    }
  }

  const controller = {
    lastPostedTurn: null,
    getState() {
      return state;
    },
    async bootstrap() {
      const authSession = await controller.checkAuthSession();
      if (!isAuthenticatedAppState(state)) {
        return authSession;
      }

      await controller.loadStatus();
      controller.startStatusPolling();
      await controller.loadSessions();
      await controller.loadApprovalMode();
      await controller.loadSessionOptions();
      return authSession;
    },
    async checkAuthSession() {
      applyAction({ type: 'auth_session_check_started' });
      try {
        const session = await requestJson(fetchImpl, '/api/auth/session');
        setAuthenticated(session?.required);
        return session;
      } catch (error) {
        if (error?.status === 401) {
          return handleUnauthorized();
        }

        applyAction({
          type: 'auth_state_changed',
          payload: {
            required: false,
            authenticated: false,
            checking: false,
            pending: false,
            error: error.message,
          },
        });
        return null;
      }
    },
    async login(password) {
      const normalizedPassword = String(password ?? '');
      if (!normalizedPassword.trim()) {
        applyAction({
          type: 'auth_state_changed',
          payload: {
            required: true,
            authenticated: false,
            checking: false,
            pending: false,
            error: '请输入共享密码',
          },
        });
        return null;
      }

      applyAction({ type: 'auth_login_started' });
      try {
        await requestJson(fetchImpl, '/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password: normalizedPassword }),
        });
      } catch (error) {
        if (error?.status === 401) {
          applyAction({
            type: 'auth_state_changed',
            payload: {
              required: true,
              authenticated: false,
              checking: false,
              pending: false,
              error: error.message,
            },
          });
          return null;
        }

        throw error;
      }

      clearLoginPassword(documentRef);
      setAuthenticated(true);
      await controller.loadStatus();
      controller.startStatusPolling();
      await controller.loadSessions();
      await controller.loadApprovalMode();
      await controller.loadSessionOptions();
      return state.auth;
    },
    async logout() {
      await requestJson(fetchImpl, '/api/auth/logout', {
        method: 'POST',
      }).catch(() => null);
      return handleUnauthorized();
    },
    async loadSessions() {
      try {
        const projects = await requestProtectedJson('/api/sessions');
        if (!projects) {
          return null;
        }

        controller.connectEvents();
        applyAction({ type: 'projects_loaded', payload: projects });
        return projects;
      } catch (error) {
        applyAction({ type: 'projects_load_failed', payload: { error: error.message } });
        return null;
      }
    },
    async loadStatus() {
      try {
        const status = await requestProtectedJson('/api/status');
        if (!status) {
          return state.systemStatus;
        }

        applyAction({ type: 'system_status_loaded', payload: status });
        if (state.loadError && status.backend?.status === 'connected') {
          await controller.loadSessions();
        }

        return status;
      } catch (error) {
        const fallbackStatus = {
          overall: 'disconnected',
          relay: { status: 'offline' },
          backend: { status: 'disconnected' },
          requests: { status: 'error' },
          lastError: error.message,
        };
        applyAction({ type: 'system_status_loaded', payload: fallbackStatus });
        return fallbackStatus;
      }
    },
    async loadApprovalMode() {
      try {
        const approvalMode = await requestProtectedJson('/api/approval-mode');
        if (!approvalMode) {
          return state.approvalMode;
        }

        applyAction({ type: 'approval_mode_loaded', payload: approvalMode });
        return state.approvalMode;
      } catch {
        return state.approvalMode;
      }
    },
    async loadSessionOptions() {
      try {
        const sessionOptions = await requestProtectedJson('/api/session-options');
        if (!sessionOptions) {
          return state.sessionOptions;
        }

        applyAction({ type: 'session_options_loaded', payload: sessionOptions });
        return state.sessionOptions;
      } catch {
        return state.sessionOptions;
      }
    },
    async loadSessionSettings(sessionId = state.selectedSessionId) {
      if (!sessionId) {
        return null;
      }

      try {
        const settings = await requestProtectedJson(`/api/sessions/${sessionId}/settings`);
        if (!settings) {
          return state.sessionSettingsById[sessionId] ?? createInitialSessionSettings();
        }

        applyAction({
          type: 'session_settings_loaded',
          payload: { threadId: sessionId, settings },
        });
        return state.sessionSettingsById[sessionId] ?? createInitialSessionSettings();
      } catch {
        return state.sessionSettingsById[sessionId] ?? createInitialSessionSettings();
      }
    },
    startStatusPolling(intervalMs = 3_000) {
      if (!isAuthenticatedAppState(state)) {
        return null;
      }

      if (statusTimer) {
        return statusTimer;
      }

      void controller.loadStatus();
      statusTimer = setInterval(() => {
        void controller.loadStatus();
      }, intervalMs);
      return statusTimer;
    },
    async selectSession(sessionId, { preserveComposerAttachments = false } = {}) {
      if (isMobileViewport(documentRef) && state.mobileDrawerOpen) {
        applyAction({ type: 'mobile_drawer_closed' });
      }

      applyAction({
        type: 'session_selected',
        payload: { id: sessionId, preserveComposerAttachments },
      });
      const detail = await loadSessionDetail(sessionId, { anchorLatest: true });
      if (!detail) {
        return null;
      }
      await controller.loadSessionSettings(sessionId);

      scrollConversationToBottom(documentRef);
      return detail;
    },
    async sendTurn(text) {
      const draftText = typeof text === 'string' ? text : state.composerDraft;
      if (!canSendTurn(state, draftText)) {
        const attachmentError = getComposerAttachmentError(state);
        if (attachmentError) {
          applyAction({
            type: 'composer_attachment_error_changed',
            payload: { error: attachmentError },
          });
        }
        return null;
      }

      const draftAttachments = normalizeComposerAttachments(state.composerAttachments);
      let sessionId = state.selectedSessionId;
      if (!sessionId && state.pendingSessionProjectId) {
        const created = await requestProtectedJson(
          `/api/projects/${encodeURIComponent(state.pendingSessionProjectId)}/sessions`,
          {
            method: 'POST',
          },
        );
        if (!created?.thread?.id) {
          return null;
        }

        await controller.loadSessions();
        await controller.selectSession(created.thread.id, { preserveComposerAttachments: true });
        sessionId = created.thread.id;
      }

      const sessionSettings = normalizeSessionSettings(state.sessionSettingsById[sessionId]);

      const result = await requestProtectedJson(`/api/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: draftText,
          model: sessionSettings.model,
          reasoningEffort: sessionSettings.reasoningEffort,
          attachments: draftAttachments.map((attachment) => ({
            name: attachment.name,
            mimeType: attachment.mimeType,
            size: attachment.size,
            dataBase64: attachment.dataBase64,
          })),
        }),
      });
      if (!result) {
        return null;
      }

      applyAction({ type: 'composer_text_changed', payload: { text: '' } });
      applyAction({ type: 'composer_attachments_cleared' });
      if (result?.turnId) {
        applyAction({
          type: 'user_turn_submitted',
          payload: {
            threadId: sessionId,
            turnId: result.turnId,
            text: draftText,
            attachments: draftAttachments,
          },
        });
        applyAction({
          type: 'turn_started',
          payload: { threadId: sessionId, turnId: result.turnId },
        });
      }
      controller.lastPostedTurn = { sessionId, text: draftText };
      return result;
    },
    async interruptTurn() {
      const sessionId = state.selectedSessionId;
      const turnId = state.activeTurnIdBySession[sessionId];
      if (!sessionId || !turnId || !canInterruptTurn(state)) {
        return null;
      }

      const result = await requestProtectedJson(`/api/sessions/${sessionId}/interrupt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ turnId }),
      });
      if (!result) {
        return null;
      }

      applyAction({
        type: 'turn_interrupt_requested',
        payload: { threadId: sessionId, turnId },
      });
      return result;
    },
    openHistoryDialog(projectId) {
      applyAction({ type: 'history_dialog_opened', payload: { projectId } });
      return state.historyDialogProjectId;
    },
    closeHistoryDialog() {
      applyAction({ type: 'history_dialog_closed' });
      return null;
    },
    selectHistoryDialogTab(tab) {
      applyAction({ type: 'history_dialog_tab_selected', payload: { tab } });
      return state.historyDialogTab;
    },
    setComposerDraft(text) {
      applyAction({ type: 'composer_text_changed', payload: { text } });
      return state.composerDraft;
    },
    async addComposerFiles(files) {
      const draftAttachments = [];
      try {
        for (const file of files ?? []) {
          draftAttachments.push(await createDraftAttachment(file));
        }
      } catch (error) {
        applyAction({
          type: 'composer_attachment_error_changed',
          payload: { error: error?.message ?? '读取附件失败' },
        });
        return state.composerAttachments;
      }

      if (draftAttachments.length === 0) {
        return state.composerAttachments;
      }

      applyAction({
        type: 'composer_attachments_added',
        payload: { attachments: draftAttachments },
      });
      return state.composerAttachments;
    },
    async handleComposerPaste(items) {
      try {
        const draftAttachments = await ingestClipboardItems(items);
        if (draftAttachments.length === 0) {
          return state.composerAttachments;
        }

        applyAction({
          type: 'composer_attachments_added',
          payload: { attachments: draftAttachments },
        });
        return state.composerAttachments;
      } catch (error) {
        applyAction({
          type: 'composer_attachment_error_changed',
          payload: { error: error?.message ?? '读取剪贴板附件失败' },
        });
        return state.composerAttachments;
      }
    },
    removeComposerAttachment(id) {
      applyAction({ type: 'composer_attachment_removed', payload: { id } });
      return state.composerAttachments;
    },
    toggleProjectPanel() {
      if (isMobileViewport(documentRef)) {
        applyAction({ type: 'mobile_drawer_opened', payload: { mode: 'sessions' } });
        return state.mobileDrawerOpen;
      }

      applyAction({ type: 'project_panel_toggled' });
      return state.projectPanelCollapsed;
    },
    toggleActivityPanel() {
      if (isMobileViewport(documentRef)) {
        applyAction({ type: 'mobile_drawer_opened', payload: { mode: 'activity' } });
        return state.mobileDrawerOpen;
      }

      applyAction({ type: 'activity_panel_toggled' });
      return state.activityPanelCollapsed;
    },
    setPersistPanelPreference(enabled) {
      applyAction({ type: 'panel_preference_changed', payload: { enabled } });
      return state.persistPanelPreference;
    },
    setProjectPanelWidth(width) {
      applyAction({ type: 'project_panel_resized', payload: { width } });
      return state.projectPanelWidth;
    },
    setActivityPanelWidth(width) {
      applyAction({ type: 'activity_panel_resized', payload: { width } });
      return state.activityPanelWidth;
    },
    setConversationNavVisible(visible) {
      applyAction({ type: 'conversation_nav_visibility_toggled', payload: { visible } });
      return state.showConversationNav;
    },
    toggleTaskSummary(sessionId = state.selectedSessionId) {
      const targetSessionId = String(sessionId ?? '').trim();
      if (!targetSessionId) {
        return null;
      }

      const collapsed = !isTaskSummaryCollapsed(
        state,
        targetSessionId,
        isMobileViewport(documentRef),
      );
      applyAction({
        type: 'task_summary_visibility_toggled',
        payload: { sessionId: targetSessionId, collapsed },
      });
      return state.taskSummaryCollapsedBySession[targetSessionId] ?? collapsed;
    },
    toggleComposerSettings(scopeId = getComposerSettingsScopeId(state)) {
      const targetScopeId = String(scopeId ?? '').trim() || getComposerSettingsScopeId(state);
      if (!targetScopeId) {
        return null;
      }

      const collapsed = !isComposerSettingsCollapsed(
        state,
        targetScopeId,
        isMobileViewport(documentRef),
      );
      applyAction({
        type: 'composer_settings_visibility_toggled',
        payload: { scopeId: targetScopeId, collapsed },
      });
      return state.composerSettingsCollapsedByScope[targetScopeId] ?? collapsed;
    },
    setComposerAttachmentMenuOpen(open) {
      applyAction({ type: 'composer_attachment_menu_toggled', payload: { open } });
      return state.composerAttachmentMenuOpen;
    },
    setMobileDrawerMode(mode) {
      applyAction({ type: 'mobile_drawer_mode_changed', payload: { mode } });
      return state.mobileDrawerMode;
    },
    closeMobileDrawer() {
      applyAction({ type: 'mobile_drawer_closed' });
      return state.mobileDrawerOpen;
    },
    async toggleProjectCollapsed(projectId) {
      const project = findProject(state.projects, projectId);
      if (!project) {
        return null;
      }

      const collapsed = !project.collapsed;
      const result = await requestProtectedJson(`/api/projects/${encodeURIComponent(projectId)}/collapse`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ collapsed }),
      });
      if (!result) {
        return null;
      }

      applyAction({
        type: 'project_collapsed_updated',
        payload: { projectId, collapsed },
      });
      return collapsed;
    },
    async addFocusedSession(projectId, threadId) {
      const result = await requestProtectedJson(
        `/api/projects/${encodeURIComponent(projectId)}/focused-sessions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ threadId }),
        },
      );
      if (!result) {
        return null;
      }

      applyAction({ type: 'history_dialog_closed' });
      await controller.loadSessions();
      return threadId;
    },
    openProjectDialog() {
      openDialog(documentRef?.querySelector?.('#project-dialog'));
      focusProjectInput(documentRef);
      return true;
    },
    closeProjectDialog() {
      closeDialog(documentRef?.querySelector?.('#project-dialog'));
      clearProjectInput(documentRef);
      return null;
    },
    openRenameDialog(sessionId = state.selectedSessionId) {
      const renameId = sessionId ?? state.selectedSessionId;
      const session =
        state.sessionDetailsById[renameId] ?? findThreadMeta(state.projects ?? [], renameId);
      if (!renameId || !session) {
        return null;
      }

      pendingRenameSessionId = renameId;
      setRenameDialogSession(documentRef, session);
      openDialog(documentRef?.querySelector?.('#rename-dialog'));
      focusRenameInput(documentRef);
      return renameId;
    },
    closeRenameDialog() {
      pendingRenameSessionId = null;
      closeDialog(documentRef?.querySelector?.('#rename-dialog'));
      clearRenameInput(documentRef);
      return null;
    },
    async createProject(cwd) {
      const normalizedCwd = cwd?.trim();
      if (!normalizedCwd) {
        return null;
      }

      const result = await requestProtectedJson('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: normalizedCwd }),
      });
      if (!result) {
        return null;
      }

      await controller.loadSessions();
      return normalizedCwd;
    },
    async closeProject(projectId) {
      if (!projectId) {
        return null;
      }

      const result = await requestProtectedJson(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: 'DELETE',
      });
      if (!result) {
        return null;
      }

      await controller.loadSessions();
      return projectId;
    },
    async renameSession(sessionId = pendingRenameSessionId ?? state.selectedSessionId, name) {
      const normalizedName = String(name ?? '').trim();
      if (!sessionId || !normalizedName) {
        return null;
      }

      const result = await requestProtectedJson(`/api/sessions/${sessionId}/name`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: normalizedName }),
      });
      if (!result) {
        return null;
      }

      applyAction({
        type: 'thread_name_updated',
        payload: {
          threadId: sessionId,
          name: result?.thread?.name ?? normalizedName,
        },
      });
      await controller.loadSessions();
      if (state.selectedSessionId === sessionId) {
        await loadSessionDetail(sessionId).catch(() => null);
      }
      controller.closeRenameDialog();
      return {
        ...result,
        thread: {
          ...(result?.thread ?? {}),
          id: sessionId,
          name: result?.thread?.name ?? normalizedName,
        },
      };
    },
    async startSessionInProject(projectId) {
      if (!projectId) {
        return null;
      }

      if (isMobileViewport(documentRef) && state.mobileDrawerOpen) {
        applyAction({ type: 'mobile_drawer_closed' });
      }

      applyAction({
        type: 'project_session_drafted',
        payload: { projectId },
      });
      scrollConversationToTop(documentRef);
      return { pendingProjectId: projectId };
    },
    async removeFocusedSession(projectId, threadId) {
      const result = await requestProtectedJson(
        `/api/projects/${encodeURIComponent(projectId)}/focused-sessions/${encodeURIComponent(threadId)}`,
        {
          method: 'DELETE',
        },
      );
      if (!result) {
        return null;
      }

      await controller.loadSessions();
      return threadId;
    },
    async setApprovalMode(mode) {
      const nextMode = normalizeApprovalMode(mode);
      if (approvalModeRequestInFlight || !nextMode || nextMode === state.approvalMode) {
        return null;
      }

      approvalModeRequestInFlight = true;
      approvalUiError = null;
      render();

      try {
        const result = await requestProtectedJson('/api/approval-mode', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: nextMode }),
        });
        if (!result) {
          return null;
        }

        applyAction({ type: 'approval_mode_changed', payload: result });
        return result;
      } catch (error) {
        approvalUiError = error?.message ?? '审批模式更新失败';
        return null;
      } finally {
        approvalModeRequestInFlight = false;
        render();
      }
    },
    async setSessionSettings(sessionId = state.selectedSessionId, settings) {
      const targetSessionId = String(sessionId ?? '').trim();
      if (
        !targetSessionId ||
        sessionSettingsRequestInFlight ||
        !canEditSessionSettings(state, targetSessionId)
      ) {
        return null;
      }

      const nextSettings = normalizeSessionSettings(settings);
      const previousSettings = normalizeSessionSettings(state.sessionSettingsById[targetSessionId]);
      if (
        previousSettings.model === nextSettings.model &&
        previousSettings.reasoningEffort === nextSettings.reasoningEffort
      ) {
        return previousSettings;
      }

      sessionSettingsRequestInFlight = true;
      sessionSettingsPendingThreadId = targetSessionId;
      sessionSettingsUiError = null;
      render();

      try {
        const result = await requestProtectedJson(`/api/sessions/${targetSessionId}/settings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(nextSettings),
        });
        if (!result) {
          return null;
        }

        applyAction({
          type: 'session_settings_changed',
          payload: { threadId: targetSessionId, settings: result },
        });
        return normalizeSessionSettings(result);
      } catch (error) {
        sessionSettingsUiError = error?.message ?? '会话设置更新失败';
        return null;
      } finally {
        sessionSettingsRequestInFlight = false;
        sessionSettingsPendingThreadId = null;
        render();
      }
    },
    async approveRequest(approvalId) {
      return controller.resolveApprovalRequest(approvalId, 'approve');
    },
    async denyRequest(approvalId) {
      return controller.resolveApprovalRequest(approvalId, 'deny');
    },
    async resolveApprovalRequest(approvalId, resolution) {
      const normalizedApprovalId = String(approvalId ?? '').trim();
      if (
        !normalizedApprovalId ||
        approvalRequestIdsInFlight.has(normalizedApprovalId) ||
        (resolution !== 'approve' && resolution !== 'deny')
      ) {
        return null;
      }

      approvalRequestIdsInFlight.add(normalizedApprovalId);
      approvalUiError = null;
      render();

      try {
        const result = await requestProtectedJson(
          `/api/approvals/${encodeURIComponent(normalizedApprovalId)}/${resolution}`,
          {
            method: 'POST',
          },
        );
        if (!result) {
          return null;
        }

        await controller.loadSessions();
        if (state.selectedSessionId) {
          await loadSessionDetail(state.selectedSessionId).catch(() => null);
        }
        return result;
      } catch (error) {
        approvalUiError = error?.message ?? '审批处理失败';
        return null;
      } finally {
        approvalRequestIdsInFlight.delete(normalizedApprovalId);
        render();
      }
    },
    async resolvePendingAction(actionId, resolution = {}) {
      const normalizedActionId = String(actionId ?? '').trim();
      if (!normalizedActionId || pendingActionRequestIdsInFlight.has(normalizedActionId)) {
        return null;
      }

      pendingActionRequestIdsInFlight.add(normalizedActionId);
      pendingActionUiError = null;
      render();

      try {
        const result = await requestProtectedJson(
          `/api/pending-actions/${encodeURIComponent(normalizedActionId)}/respond`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(resolution ?? {}),
          },
        );
        if (!result) {
          return null;
        }

        await controller.loadSessions();
        if (state.selectedSessionId) {
          await loadSessionDetail(state.selectedSessionId).catch(() => null);
        }
        return result;
      } catch (error) {
        pendingActionUiError = error?.message ?? '问题回复失败';
        return null;
      } finally {
        pendingActionRequestIdsInFlight.delete(normalizedActionId);
        render();
      }
    },
    jumpConversationToBottom() {
      ensureConversationWindowBoundary('bottom');
      render();
      return scrollConversationToBottom(documentRef);
    },
    jumpConversationToTop() {
      ensureConversationWindowBoundary('top');
      render();
      return scrollConversationToTop(documentRef);
    },
    jumpConversationByTurn(direction) {
      const target = jumpConversationByTurn(documentRef, direction);
      if (target != null) {
        return target;
      }

      const expanded = direction === 'previous' ? expandConversationWindow('up') : expandConversationWindow('down');
      if (!expanded) {
        return null;
      }

      return jumpConversationByTurn(documentRef, direction);
    },
    jumpConversationToTurnIndex(turnIndex) {
      ensureConversationWindowContainsTurn(turnIndex);
      render();
      return jumpConversationToTurnIndex(documentRef, turnIndex);
    },
    connectEvents() {
      if (!isAuthenticatedAppState(state)) {
        return null;
      }

      if (eventSource) {
        return eventSource;
      }

      eventSource = eventSourceFactory('/api/events');
      eventSource.onmessage = (event) => {
        const action = JSON.parse(event.data);
        applyAction(action);
        if (
          action?.type === 'approval_requested' ||
          action?.type === 'approval_resolved' ||
          action?.type === 'pending_question_requested' ||
          action?.type === 'pending_question_resolved'
        ) {
          void controller.loadSessions();
        }
        void refreshSessionAfterEvent(action);
      };
      return eventSource;
    },
    destroy() {
      stopStatusPolling();
      disconnectEvents();
    },
  };

  function applyAction(action) {
    const previousState = state;
    state = reduceState(state, action);
    render();
    maybeAutoScrollConversation(
      documentRef,
      previousState,
      state,
      action,
      getConversationWindow(state.selectedSessionId, state.sessionDetailsById?.[state.selectedSessionId]),
    );
    syncStoredPanelPreference(storageImpl, state);
    return state;
  }

  async function loadSessionDetail(sessionId, options = {}) {
    const detail = await requestProtectedJson(`/api/sessions/${sessionId}`);
    if (!detail) {
      return null;
    }

    syncConversationWindowForDetail(sessionId, detail.thread, options);
    applyAction({ type: 'session_detail_loaded', payload: detail });
    return detail;
  }

  async function refreshSessionAfterEvent(action) {
    const threadId =
      action?.payload?.threadId ??
      action?.threadId ??
      action?.payload?.approval?.threadId ??
      null;
    if (!threadId || !shouldRefreshSessionAfterEvent(action)) {
      return null;
    }

    if (!findThreadMeta(state.projects, threadId)) {
      return null;
    }

    try {
        return await loadSessionDetail(threadId);
    } catch {
      return null;
    }
  }

  function bindProjectSidebarActions(root) {
    if (!root?.querySelectorAll) {
      return;
    }

    for (const button of root.querySelectorAll('[data-session-id]')) {
      button.addEventListener('click', () => {
        void controller.selectSession(button.dataset.sessionId);
      });
    }

    for (const button of root.querySelectorAll('[data-project-dialog-open]')) {
      button.addEventListener('click', () => {
        controller.openProjectDialog();
      });
    }

    for (const button of root.querySelectorAll('[data-project-collapse]')) {
      button.addEventListener('click', () => {
        void controller.toggleProjectCollapsed(button.dataset.projectCollapse);
      });
    }

    for (const button of root.querySelectorAll('[data-project-close]')) {
      button.addEventListener('click', () => {
        void controller.closeProject(button.dataset.projectClose);
      });
    }

    for (const button of root.querySelectorAll('[data-project-session-start]')) {
      button.addEventListener('click', () => {
        void controller.startSessionInProject(button.dataset.projectSessionStart);
      });
    }

    for (const button of root.querySelectorAll('[data-project-history-open]')) {
      button.addEventListener('click', () => {
        controller.openHistoryDialog(button.dataset.projectHistoryOpen);
      });
    }

    for (const button of root.querySelectorAll('[data-focused-remove]')) {
      button.addEventListener('click', () => {
        void controller.removeFocusedSession(
          button.dataset.projectId,
          button.dataset.focusedRemove,
        );
      });
    }

    for (const button of root.querySelectorAll('[data-logout-button]')) {
      button.addEventListener('click', () => {
        void controller.logout();
      });
    }
  }

  function render() {
    if (!documentRef) {
      return;
    }

    const appLayout = documentRef.querySelector('#app-layout');
    const authGate = documentRef.querySelector('#auth-gate');
    const loginError = documentRef.querySelector('#login-error');
    const loginButton = documentRef.querySelector('#login-button');
    const loginPassword = documentRef.querySelector('#login-password');
    const logoutButton = documentRef.querySelector('#logout-button');
    const sessionList = documentRef.querySelector('#session-list');
    const conversationScroll = documentRef.querySelector('#conversation-scroll');
    const conversationBody = documentRef.querySelector('#conversation-body');
    const conversationNav = documentRef.querySelector('#conversation-nav');
    const activityPanel = documentRef.querySelector('#activity-panel');
    const mobileDrawer = documentRef.querySelector('#mobile-drawer');
    const historyDialog = documentRef.querySelector('#history-dialog');
    const renameDialog = documentRef.querySelector('#rename-dialog');
    const projectPanelToggle = documentRef.querySelector('#project-panel-toggle');
    const activityPanelToggle = documentRef.querySelector('#activity-panel-toggle');
    const projectPanelResizer = documentRef.querySelector('#project-panel-resizer');
    const activityPanelResizer = documentRef.querySelector('#activity-panel-resizer');
    const conversationStatus = documentRef.querySelector('#conversation-status');
    const conversationTitle = documentRef.querySelector('#conversation-title');
    const sessionDockPlanSummary = documentRef.querySelector('#session-dock-plan-summary');
    const composerAttachmentsStrip = documentRef.querySelector('#composer-attachments');
    const composerAttachmentError = documentRef.querySelector('#composer-attachment-error');
    const composerInlineFeedback = documentRef.querySelector('#composer-inline-feedback');
    const composerInput = documentRef.querySelector('#composer-input');
    const approvalModeControls = documentRef.querySelector('#approval-mode-controls');
    const composerUploadFileButton = documentRef.querySelector('#composer-upload-file');
    const composerUploadFileAction = documentRef.querySelector('#composer-upload-file-action');
    const composerUploadImageButton = documentRef.querySelector('#composer-upload-image');
    const composerAttachmentMenu = documentRef.querySelector('#composer-attachment-menu');
    const composerFileInput = documentRef.querySelector('#composer-file-input');
    const composerImageInput = documentRef.querySelector('#composer-image-input');
    const conversationNavToggle = documentRef.querySelector('#conversation-nav-toggle');
    const sendButton = documentRef.querySelector('#send-button');
    const interruptButton = documentRef.querySelector('#interrupt-button');
    const composer = documentRef.querySelector('#composer');
    const detail = state.sessionDetailsById[state.selectedSessionId];
    const conversationWindow = getConversationWindow(state.selectedSessionId, detail);
    const mobileViewport = isMobileViewport(documentRef);
    const authLocked = !isAuthenticatedAppState(state);
    const approvalUiState = {
      approvalModePending: approvalModeRequestInFlight,
      pendingApprovalIds: approvalRequestIdsInFlight,
      error: approvalUiError,
    };
    const pendingActionUiState = {
      pendingActionIds: pendingActionRequestIdsInFlight,
      error: pendingActionUiError,
    };
    const sessionSettingsUiState = {
      pending: sessionSettingsRequestInFlight,
      pendingThreadId: sessionSettingsPendingThreadId,
      error: sessionSettingsUiError,
    };

    syncPanelLayout(appLayout, state);
    syncPanelResizer(projectPanelResizer, {
      hidden: state.projectPanelCollapsed,
      label: PROJECT_PANEL_LABEL,
      width: state.projectPanelWidth,
    });
    syncPanelResizer(activityPanelResizer, {
      hidden: state.activityPanelCollapsed,
      label: ACTIVITY_PANEL_LABEL,
      width: state.activityPanelWidth,
    });
    syncPanelToggleButton(projectPanelToggle, {
      collapsed: state.projectPanelCollapsed,
      label: PROJECT_PANEL_LABEL,
    });
    syncPanelToggleButton(activityPanelToggle, {
      collapsed: state.activityPanelCollapsed,
      label: ACTIVITY_PANEL_LABEL,
    });
    syncConversationStatus(conversationStatus, state.systemStatus);
    syncConversationTitle(
      conversationTitle,
      authLocked ? '访问控制' : resolveSelectedSessionTitle(state, detail),
    );
    syncTaskSummaryBand(sessionDockPlanSummary, detail, state, mobileViewport);
    syncComposerInput(composerInput, state);
    syncComposerAttachmentsStrip(composerAttachmentsStrip, state);
    syncComposerAttachmentError(composerAttachmentError, state);
    syncComposerInlineFeedback(composerInlineFeedback, state);
    syncConversationNavToggle(conversationNavToggle, state.showConversationNav);
    syncComposerButtons(sendButton, interruptButton, state);
    syncComposerAttachmentActions(
      composerUploadFileButton,
      composerUploadFileAction,
      composerUploadImageButton,
      composerAttachmentMenu,
      composerFileInput,
      composerImageInput,
      state,
    );
    syncAuthGate(authGate, loginError, loginButton, loginPassword, logoutButton, state.auth);
    syncApprovalModeControls(
      approvalModeControls,
      state,
      authLocked,
      approvalUiState,
      sessionSettingsUiState,
      mobileViewport,
    );

    if (projectPanelToggle) {
      projectPanelToggle.hidden = false;
    }

    if (activityPanelToggle) {
      activityPanelToggle.hidden = false;
    }

    if (composer) {
      composer.hidden = false;
    }

    if (composerAttachmentsStrip) {
      for (const button of composerAttachmentsStrip.querySelectorAll('[data-composer-attachment-remove]')) {
        button.addEventListener('click', () => {
          controller.removeComposerAttachment(button.dataset.composerAttachmentRemove);
        });
      }
    }

    if (sessionDockPlanSummary) {
      for (const button of sessionDockPlanSummary.querySelectorAll('[data-task-summary-toggle]')) {
        button.addEventListener('click', () => {
          controller.toggleTaskSummary(button.dataset.taskSummarySessionId || state.selectedSessionId);
        });
      }
    }

    if (approvalModeControls) {
      for (const button of approvalModeControls.querySelectorAll('[data-composer-settings-toggle]')) {
        button.addEventListener('click', () => {
          controller.toggleComposerSettings(button.dataset.composerSettingsScope);
        });
      }
    }

    if (conversationScroll) {
      conversationScroll.hidden = false;
      bindConversationScroll(conversationScroll);
    }

    if (sessionList) {
      sessionList.hidden = state.projectPanelCollapsed;
      const sidebarMarkup = getCachedMarkup(
        renderCache.sessionList,
        [
          state.projects,
          state.selectedSessionId,
          state.unreadBySession,
          state.turnStatusBySession,
          state.pendingSessionProjectId,
          state.loadError,
          state.loadError ? state.systemStatus : null,
        ],
        () => renderProjectSidebar(state),
      );
      if (sidebarMarkup.changed) {
        sessionList.innerHTML = sidebarMarkup.html;
        bindProjectSidebarActions(sessionList);
      }
    }

    if (conversationBody) {
      const conversationMarkup = getCachedMarkup(
        renderCache.conversationBody,
        [
          detail,
          state.selectedSessionId,
          state.realtimeBySession[state.selectedSessionId] ?? null,
          getPendingSessionProject(state),
          approvalModeRequestInFlight,
          approvalUiError,
          approvalRequestIdsInFlight.size,
          pendingActionUiError,
          pendingActionRequestIdsInFlight.size,
          conversationWindow?.startTurnIndex ?? null,
          conversationWindow?.endTurnIndex ?? null,
        ],
        () => renderConversationDetail(state, detail, approvalUiState, pendingActionUiState, conversationWindow),
      );
      if (conversationMarkup.changed) {
        conversationBody.innerHTML = conversationMarkup.html;

        for (const button of conversationBody.querySelectorAll('[data-subagent-turn-index]')) {
          button.addEventListener('click', () => {
            controller.jumpConversationToTurnIndex(Number(button.dataset.subagentTurnIndex));
          });
        }

        for (const button of conversationBody.querySelectorAll('[data-session-rename-open]')) {
          button.addEventListener('click', () => {
            controller.openRenameDialog(button.dataset.sessionRenameOpen);
          });
        }

        for (const button of conversationBody.querySelectorAll('[data-approval-approve]')) {
          button.disabled = approvalRequestIdsInFlight.has(button.dataset.approvalApprove);
          button.addEventListener('click', () => {
            if (button.disabled) {
              return;
            }
            void controller.approveRequest(button.dataset.approvalApprove);
          });
        }

        for (const button of conversationBody.querySelectorAll('[data-approval-deny]')) {
          button.disabled = approvalRequestIdsInFlight.has(button.dataset.approvalDeny);
          button.addEventListener('click', () => {
            if (button.disabled) {
              return;
            }
            void controller.denyRequest(button.dataset.approvalDeny);
          });
        }

        for (const button of conversationBody.querySelectorAll('[data-pending-action-submit]')) {
          const pendingActionId = button.dataset.pendingActionSubmit;
          button.disabled = pendingActionRequestIdsInFlight.has(pendingActionId);
          button.addEventListener('click', () => {
            if (button.disabled) {
              return;
            }

            const input = conversationBody.querySelector(
              `[data-pending-action-input="${escapeSelectorValue(pendingActionId)}"]`,
            );
            const response = input?.value ?? '';
            void controller.resolvePendingAction(pendingActionId, { response });
          });
        }
      }
    }

    if (approvalModeControls) {
      const select = approvalModeControls.querySelector('[data-approval-mode-select]');
      if (select) {
        select.addEventListener('change', () => {
          if (select.disabled) {
            return;
          }
          void controller.setApprovalMode(select.value);
        });
      }

      const modelSelect = approvalModeControls.querySelector('[data-session-model-select]');
      if (modelSelect) {
        modelSelect.addEventListener('change', () => {
          if (modelSelect.disabled) {
            return;
          }

          const currentSettings = getSelectedSessionSettings(state);
          void controller.setSessionSettings(state.selectedSessionId, {
            ...currentSettings,
            model: modelSelect.value || null,
          });
        });
      }

      const reasoningSelect = approvalModeControls.querySelector('[data-session-reasoning-select]');
      if (reasoningSelect) {
        reasoningSelect.addEventListener('change', () => {
          if (reasoningSelect.disabled) {
            return;
          }

          const currentSettings = getSelectedSessionSettings(state);
          void controller.setSessionSettings(state.selectedSessionId, {
            ...currentSettings,
            reasoningEffort: reasoningSelect.value || null,
          });
        });
      }
    }

    if (conversationNav) {
      const navMarkup = !authLocked && shouldRenderConversationNav(state, detail)
        ? renderConversationNavigation()
        : '';
      conversationNav.hidden = !navMarkup;
      conversationNav.innerHTML = navMarkup;

      for (const button of conversationNav.querySelectorAll('[data-conversation-nav]')) {
        button.addEventListener('click', () => {
          const direction = button.dataset.conversationNav;
          if (direction === 'top') {
            controller.jumpConversationToTop();
            return;
          }

          if (direction === 'bottom') {
            controller.jumpConversationToBottom();
            return;
          }

          controller.jumpConversationByTurn(direction);
        });
      }
    }

    if (activityPanel) {
      activityPanel.hidden = state.activityPanelCollapsed;
      const activityMarkup = getCachedMarkup(
        renderCache.activityPanel,
        [
          state.selectedSessionId,
          state.turnStatusBySession,
          state.diffBySession,
          state.realtimeBySession,
          state.sessionDetailsById[state.selectedSessionId] ?? null,
          state.pendingSessionProjectId,
        ],
        () => renderActivityPanel(state),
      );
      if (activityMarkup.changed) {
        activityPanel.innerHTML = activityMarkup.html;
      }
    }

    if (mobileDrawer) {
      if (!mobileViewport) {
        mobileDrawer.innerHTML = '';
        if (mobileDrawer.open) {
          closeDialog(mobileDrawer);
        }
      } else {
        mobileDrawer.innerHTML = state.mobileDrawerOpen
          ? renderMobileDrawer(state)
          : '';
      }

      if (mobileViewport && state.mobileDrawerOpen) {
        openDialog(mobileDrawer);

        for (const button of mobileDrawer.querySelectorAll('[data-mobile-drawer-close]')) {
          button.addEventListener('click', () => {
            controller.closeMobileDrawer();
          });
        }

        for (const button of mobileDrawer.querySelectorAll('[data-mobile-drawer-mode]')) {
          button.addEventListener('click', () => {
            controller.setMobileDrawerMode(button.dataset.mobileDrawerMode);
          });
        }

        bindProjectSidebarActions(mobileDrawer);
      } else if (mobileDrawer.open) {
        closeDialog(mobileDrawer);
      }
    }

    if (historyDialog) {
      const dialogProject = findProject(state.projects, state.historyDialogProjectId);
      historyDialog.innerHTML = dialogProject
        ? renderHistoryDialogContent(dialogProject, state.historyDialogTab, state.persistPanelPreference)
        : '';

      if (dialogProject) {
        if (typeof historyDialog.showModal === 'function' && !historyDialog.open) {
          historyDialog.showModal();
        } else {
          historyDialog.open = true;
        }

        for (const button of historyDialog.querySelectorAll('[data-history-dialog-close]')) {
          button.addEventListener('click', () => {
            controller.closeHistoryDialog();
          });
        }

        for (const button of historyDialog.querySelectorAll('[data-history-dialog-tab]')) {
          button.addEventListener('click', () => {
            controller.selectHistoryDialogTab(button.dataset.historyDialogTab);
          });
        }

        for (const button of historyDialog.querySelectorAll('[data-project-history-add]')) {
          button.addEventListener('click', () => {
            void controller.addFocusedSession(
              button.dataset.projectId,
              button.dataset.projectHistoryAdd,
            );
          });
        }
      } else if (historyDialog.open) {
        if (typeof historyDialog.close === 'function') {
          historyDialog.close();
        } else {
          historyDialog.open = false;
        }
      }
    }
  }

  if (documentRef) {
    const loginForm = documentRef.querySelector('#login-form');
    const loginPassword = documentRef.querySelector('#login-password');
    const composer = documentRef.querySelector('#composer');
    const composerAttachmentsStrip = documentRef.querySelector('#composer-attachments');
    const composerInput = documentRef.querySelector('#composer-input');
    const composerUploadFileButton = documentRef.querySelector('#composer-upload-file');
    const composerUploadFileAction = documentRef.querySelector('#composer-upload-file-action');
    const composerUploadImageButton = documentRef.querySelector('#composer-upload-image');
    const composerFileInput = documentRef.querySelector('#composer-file-input');
    const composerImageInput = documentRef.querySelector('#composer-image-input');
    const interruptButton = documentRef.querySelector('#interrupt-button');
    const historyDialog = documentRef.querySelector('#history-dialog');
    const mobileDrawer = documentRef.querySelector('#mobile-drawer');
    const projectDialog = documentRef.querySelector('#project-dialog');
    const projectDialogForm = documentRef.querySelector('#project-dialog-form');
    const projectDialogInput = documentRef.querySelector('#project-dialog-input');
    const renameDialog = documentRef.querySelector('#rename-dialog');
    const renameDialogForm = documentRef.querySelector('#rename-dialog-form');
    const renameDialogInput = documentRef.querySelector('#rename-dialog-input');
    const projectPanelToggle = documentRef.querySelector('#project-panel-toggle');
    const activityPanelToggle = documentRef.querySelector('#activity-panel-toggle');
    const conversationNavToggle = documentRef.querySelector('#conversation-nav-toggle');
    const projectPanelResizer = documentRef.querySelector('#project-panel-resizer');
    const activityPanelResizer = documentRef.querySelector('#activity-panel-resizer');

    loginForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      void controller.login(loginPassword?.value ?? '');
    });

    composer?.addEventListener('submit', (event) => {
      event.preventDefault();
      const primaryAction = resolveComposerPrimaryAction(state);
      if (primaryAction.kind === 'interrupt') {
        void controller.interruptTurn();
        return;
      }

      if (primaryAction.kind === 'send') {
        void controller.sendTurn(state.composerDraft);
      }
    });

    composerInput?.addEventListener('input', () => {
      controller.setComposerDraft(composerInput.value);
    });

    composerInput?.addEventListener('paste', (event) => {
      void controller.handleComposerPaste(event?.clipboardData?.items ?? []);
    });

    composerUploadFileButton?.addEventListener('click', () => {
      controller.setComposerAttachmentMenuOpen(!state.composerAttachmentMenuOpen);
    });

    composerUploadFileAction?.addEventListener('click', () => {
      controller.setComposerAttachmentMenuOpen(false);
      composerFileInput?.click?.();
    });

    composerUploadImageButton?.addEventListener('click', () => {
      controller.setComposerAttachmentMenuOpen(false);
      composerImageInput?.click?.();
    });

    composerFileInput?.addEventListener('change', () => {
      void controller.addComposerFiles(Array.from(composerFileInput.files ?? []));
      composerFileInput.value = '';
    });

    composerImageInput?.addEventListener('change', () => {
      void controller.addComposerFiles(Array.from(composerImageInput.files ?? []));
      composerImageInput.value = '';
    });

    interruptButton?.addEventListener('click', () => {
      void controller.interruptTurn();
    });

    projectPanelToggle?.addEventListener('click', () => {
      controller.toggleProjectPanel();
    });

    activityPanelToggle?.addEventListener('click', () => {
      controller.toggleActivityPanel();
    });

    conversationNavToggle?.addEventListener('change', () => {
      controller.setConversationNavVisible(Boolean(conversationNavToggle.checked));
    });

    setupPanelResizer(projectPanelResizer, {
      side: 'project',
      controller,
      getState: () => state,
      documentRef,
    });

    setupPanelResizer(activityPanelResizer, {
      side: 'activity',
      controller,
      getState: () => state,
      documentRef,
    });

    historyDialog?.addEventListener?.('close', () => {
      if (state.historyDialogProjectId) {
        controller.closeHistoryDialog();
      }
    });

    renameDialog?.addEventListener?.('close', () => {
      if (pendingRenameSessionId) {
        controller.closeRenameDialog();
      }
    });

    mobileDrawer?.addEventListener?.('close', () => {
      if (state.mobileDrawerOpen) {
        controller.closeMobileDrawer();
      }
    });

    for (const button of projectDialog?.querySelectorAll?.('[data-project-dialog-close]') ?? []) {
      button.addEventListener('click', () => {
        controller.closeProjectDialog();
      });
    }

    projectDialogForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      void controller.createProject(projectDialogInput?.value ?? '').then((created) => {
        if (!created) {
          return;
        }

        controller.closeProjectDialog();
      });
    });

    projectDialog?.addEventListener?.('close', () => {
      clearProjectInput(documentRef);
    });

    for (const button of renameDialog?.querySelectorAll?.('[data-rename-dialog-close]') ?? []) {
      button.addEventListener('click', () => {
        controller.closeRenameDialog();
      });
    }

    renameDialogForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      void controller.renameSession(pendingRenameSessionId, renameDialogInput?.value ?? '');
    });
  }

  render();
  return controller;
}

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

function renderMobileDrawer(state) {
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

function renderProjectSidebarFooter(state) {
  const auth = normalizeAuthState(state?.auth);
  if (!auth.authenticated) {
    return '';
  }

  return [
    '<div class="sidebar-footer">',
    '<button class="sidebar-logout-button" type="button" data-logout-button="true">退出登录</button>',
    '</div>',
  ].join('');
}

function renderMobileDrawerModeButton(value, label, activeMode) {
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

function renderConversationDetail(
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

function resolveConversationTurnWindow(turnWindow, totalTurns) {
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

function createLatestConversationWindow(totalTurns) {
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

function createEarliestConversationWindow(totalTurns) {
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

function expandConversationTurnWindow(turnWindow, totalTurns, direction) {
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

function ensureConversationTurnWindowContainsTurn(turnWindow, totalTurns, turnIndex) {
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

function sameConversationWindow(previousWindow, nextWindow) {
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

function clampConversationTurnIndex(turnIndex, totalTurns) {
  const normalizedTotalTurns = Math.max(0, Number(totalTurns ?? 0));
  if (normalizedTotalTurns <= 0) {
    return 0;
  }

  return Math.min(
    normalizedTotalTurns - 1,
    Math.max(0, Number.isFinite(Number(turnIndex)) ? Number(turnIndex) : 0),
  );
}

function renderConversationWindowNotice(position, hiddenTurnCount) {
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

function renderThreadSubagents(session) {
  const subagents = collectSubagentEntries(session);
  if (!subagents.length) {
    return '';
  }

  return [
    '<section class="thread-subagents">',
    '<div class="thread-subagents-header">',
    '<div class="thread-subagents-title">Subagents</div>',
    `<span class="meta-chip">${subagents.length}</span>`,
    '</div>',
    '<div class="thread-subagents-list">',
    subagents.map((entry) => renderThreadSubagent(entry)).join(''),
    '</div>',
    '</section>',
  ].join('');
}

function renderThreadApprovals(session, approvalUiState = null) {
  const approvals = (session?.pendingApprovals ?? []).filter((approval) => approval?.status === 'pending');
  if (!approvals.length) {
    return '';
  }

  return [
    '<section class="thread-approvals">',
    '<div class="thread-approvals-header">',
    '<div class="thread-approvals-title">待处理审批</div>',
    `<span class="meta-chip">${approvals.length}</span>`,
    '</div>',
    approvalUiState?.error
      ? `<div class="approval-feedback" role="status">${escapeHtml(approvalUiState.error)}</div>`
      : '',
    '<div class="thread-approvals-list">',
    approvals.map((approval) => renderApprovalCard(approval, approvalUiState)).join(''),
    '</div>',
    '</section>',
  ].join('');
}

function renderThreadPendingQuestions(session, pendingActionUiState = null) {
  const questions = (session?.pendingQuestions ?? []).filter((question) => question?.status === 'pending');
  if (!questions.length) {
    return '';
  }

  return [
    '<section class="thread-pending-questions">',
    '<div class="thread-pending-questions-header">',
    '<div class="thread-pending-questions-title">待处理问题</div>',
    `<span class="meta-chip">${questions.length}</span>`,
    '</div>',
    pendingActionUiState?.error
      ? `<div class="approval-feedback" role="status">${escapeHtml(pendingActionUiState.error)}</div>`
      : '',
    '<div class="thread-pending-questions-list">',
    questions.map((question) => renderPendingQuestionCard(question, pendingActionUiState)).join(''),
    '</div>',
    '</section>',
  ].join('');
}

function renderPendingQuestionCard(question, pendingActionUiState = null) {
  const pending = pendingActionUiState?.pendingActionIds?.has?.(question.id) ?? false;
  const questionLines = (question?.questions ?? [])
    .map((entry) => normalizePendingQuestionLine(entry))
    .filter(Boolean)
    .map((line) => `<div class="approval-card-line">${escapeHtml(line)}</div>`)
    .join('');

  return [
    '<article class="approval-card approval-card--question">',
    '<div class="approval-card-header">',
    '<span class="approval-card-kind">Question</span>',
    `<span class="approval-card-status">${escapeHtml(formatPendingQuestionStatus(question.status))}</span>`,
    '</div>',
    `<div class="approval-card-summary">${escapeHtml(question.summary ?? question.prompt ?? '需要用户回答')}</div>`,
    question.prompt ? `<div class="approval-card-line">${escapeHtml(question.prompt)}</div>` : '',
    questionLines ? `<div class="approval-card-detail">${questionLines}</div>` : '',
    '<div class="pending-question-actions">',
    `<input class="pending-question-input" type="text" data-pending-action-input="${escapeHtml(question.id)}" placeholder="输入回复内容" value="${escapeHtml(question.response?.response ?? '')}" />`,
    `<button class="approval-card-button approval-card-button--approve" type="button" data-pending-action-submit="${escapeHtml(question.id)}"${pending ? ' disabled' : ''}>${pending ? '提交中…' : '提交回复'}</button>`,
    '</div>',
    '</article>',
  ].join('');
}

function renderApprovalCard(approval, approvalUiState = null) {
  const detailLines = Object.entries(approval?.detail ?? {})
    .filter(([, value]) => value != null && String(value).trim() !== '')
    .map(([key, value]) => {
      const renderedValue = Array.isArray(value) ? value.join(' ') : String(value);
      return `<div class="approval-card-line"><strong>${escapeHtml(formatApprovalDetailLabel(key))}:</strong> ${escapeHtml(renderedValue)}</div>`;
    })
    .join('');
  const pending = approvalUiState?.pendingApprovalIds?.has?.(approval.id) ?? false;

  return [
    `<article class="approval-card approval-card--${escapeHtml(approval.kind ?? 'generic')}">`,
    '<div class="approval-card-header">',
    `<span class="approval-card-kind">${escapeHtml(formatApprovalKind(approval.kind))}</span>`,
    `<span class="approval-card-status">${escapeHtml(formatApprovalStatus(approval.status))}</span>`,
    '</div>',
    `<div class="approval-card-summary">${escapeHtml(approval.summary ?? '待确认操作')}</div>`,
    detailLines ? `<div class="approval-card-detail">${detailLines}</div>` : '',
    '<div class="approval-card-actions">',
    `<button class="approval-card-button approval-card-button--approve" type="button" data-approval-approve="${escapeHtml(approval.id)}"${pending ? ' disabled' : ''}>${pending ? '处理中…' : '批准'}</button>`,
    `<button class="approval-card-button approval-card-button--deny" type="button" data-approval-deny="${escapeHtml(approval.id)}"${pending ? ' disabled' : ''}>${pending ? '处理中…' : '拒绝'}</button>`,
    '</div>',
    '</article>',
  ].join('');
}

function normalizePendingQuestionLine(entry) {
  if (!entry) {
    return null;
  }

  if (typeof entry === 'string') {
    return entry;
  }

  if (typeof entry?.question === 'string' && entry.question.trim()) {
    return entry.question;
  }

  if (typeof entry?.prompt === 'string' && entry.prompt.trim()) {
    return entry.prompt;
  }

  return null;
}

function formatPendingQuestionStatus(status) {
  return status === 'answered' ? '已回答' : '待回答';
}

function renderThreadSubagent(entry) {
  return [
    '<div class="thread-subagent-item">',
    '<div class="thread-subagent-copy">',
    `<span class="thread-subagent-name">${escapeHtml(entry.id)}</span>`,
    `<span class="thread-subagent-status thread-subagent-status--${escapeHtml(entry.statusTone)}">${escapeHtml(entry.statusLabel)}</span>`,
    '</div>',
    `<button class="thread-subagent-jump" type="button" data-subagent-turn-index="${entry.turnIndex}" title="${escapeHtml(entry.jumpTitle)}">跳转</button>`,
    '</div>',
  ].join('');
}

function renderThreadRealtime(realtimeState) {
  const realtime = normalizeRealtimeSessionState(realtimeState);
  if (!hasRealtimeSessionData(realtime)) {
    return '';
  }

  const summaryBody = [
    renderKeyValueList([
      ['Session', realtime.sessionId],
      ['Items', realtime.items.length],
      ['Status', realtime.status],
    ]),
    realtime.lastError
      ? `<div class="thread-item-meta-line"><strong>Error:</strong> ${escapeHtml(realtime.lastError)}</div>`
      : '',
    realtime.closeReason
      ? `<div class="thread-item-meta-line"><strong>Closed:</strong> ${escapeHtml(realtime.closeReason)}</div>`
      : '',
  ]
    .filter(Boolean)
    .join('');

  const cards = [
    renderThreadItemCard({
      label: '实时',
      title: '实时流',
      tone: 'realtime',
      status: realtime.status,
      body: summaryBody,
    }),
  ];

  if (realtime.audioChunkCount > 0) {
    cards.push(
      renderThreadItemCard({
        label: 'Audio',
        title: '音频 Audio',
        tone: 'realtimeAudio',
        status: `${realtime.audioChunkCount} chunks`,
        body: renderKeyValueList([
          ['Chunk count', realtime.audioChunkCount],
          ['Base64 bytes', realtime.audioByteCount],
          [
            'Sample rate',
            realtime.lastAudio?.sampleRate ? `${realtime.lastAudio.sampleRate} Hz` : null,
          ],
          ['Channels', realtime.lastAudio?.numChannels],
          ['Samples / channel', realtime.lastAudio?.samplesPerChannel],
        ]),
      }),
    );
  }

  if (realtime.items.length) {
    cards.push(
      renderThreadItemCard({
        label: '事件',
        title: 'Realtime items',
        tone: 'realtime',
        status: `${realtime.items.length}`,
        body: renderRealtimeItems(realtime.items),
      }),
    );
  }

  return [
    '<section class="thread-realtime">',
    '<div class="thread-realtime-header">',
    '<div class="thread-realtime-title">实时流</div>',
    `<span class="meta-chip">${escapeHtml(realtime.status)}</span>`,
    '</div>',
    '<div class="thread-realtime-list">',
    cards.join(''),
    '</div>',
    '</section>',
  ].join('');
}

function renderRealtimeItems(items) {
  return items
    .map((item) => {
      return [
        '<div class="thread-item-section">',
        `<div class="thread-item-section-title">#${item.index} ${escapeHtml(item.summary)}</div>`,
        `<pre class="thread-item-pre">${escapeHtml(JSON.stringify(item.value, null, 2))}</pre>`,
        '</div>',
      ].join('');
    })
    .join('');
}

function renderProjectSidebarHeader(hasProjects, systemStatus) {
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

function renderStatusBadge(status) {
  const tone = getStatusTone(status);
  return [
    `<div class="status-badge status-badge--${tone}" title="${escapeHtml(status.lastError ?? getStatusLabel(status))}">`,
    `<span class="status-badge-dot status-badge-dot--${tone}"></span>`,
    `<span>${escapeHtml(getStatusLabel(status))}</span>`,
    '</div>',
  ].join('');
}

function syncPanelLayout(appLayout, state) {
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

function syncPanelToggleButton(button, { collapsed, label }) {
  if (!button) {
    return;
  }

  if (button.dataset) {
    button.dataset.panelState = collapsed ? 'collapsed' : 'expanded';
  }

  button.ariaExpanded = String(!collapsed);
  button.title = `${collapsed ? '展开' : '收起'}${label}`;
}

function syncPanelResizer(handle, { hidden, label, width }) {
  if (!handle) {
    return;
  }

  handle.hidden = Boolean(hidden);
  handle.title = `${label}宽度 ${Math.round(width)}px`;
  handle.setAttribute?.('aria-valuenow', String(Math.round(width)));
}

function syncConversationTitle(titleNode, title) {
  if (!titleNode) {
    return;
  }

  const normalizedTitle = typeof title === 'string' ? title : '';
  titleNode.textContent = normalizedTitle;
  titleNode.title = normalizedTitle;
  titleNode.hidden = !normalizedTitle;
}

function syncConversationStatus(statusNode, status) {
  if (!statusNode) {
    return;
  }

  const normalizedStatus = normalizeSystemStatus(status);
  const tone = getStatusTone(normalizedStatus);
  statusNode.className = `status-badge-dot status-badge-dot--${tone} conversation-status-dot`;
  statusNode.dataset.statusTone = tone;
  statusNode.title = normalizedStatus.lastError ?? getStatusLabel(normalizedStatus);
  statusNode.hidden = false;
}

function syncConversationNavToggle(toggle, checked) {
  if (!toggle) {
    return;
  }

  toggle.checked = Boolean(checked);
}

function syncApprovalModeControls(
  node,
  state,
  authLocked,
  approvalUiState = null,
  sessionSettingsUiState = null,
  mobileViewport = false,
) {
  if (!node) {
    return;
  }

  node.innerHTML = authLocked
    ? ''
    : renderApprovalModeControls(state, approvalUiState, sessionSettingsUiState, { mobileViewport });
  node.hidden = authLocked;
}

function syncAuthGate(authGate, loginError, loginButton, loginPassword, logoutButton, authState) {
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

function shouldRenderConversationNav(state, session) {
  return Boolean(state.showConversationNav && session?.turns?.length);
}

function renderProjectGroup(project, state) {
  const projectId = project.id ?? project.cwd ?? '__unknown__';
  const focusedSessions = project.focusedSessions ?? [];

  return [
    '<section class="project-group">',
    '<header class="project-group-header">',
    '<div class="project-header-row">',
    `<button class="project-toggle" data-project-collapse="${escapeHtml(projectId)}" aria-expanded="${String(!project.collapsed)}">`,
    `<span class="project-chevron">${project.collapsed ? '▸' : '▾'}</span>`,
    `<span class="project-name">${escapeHtml(project.displayName ?? project.cwd ?? 'Unknown Workspace')}</span>`,
    `<span class="project-count">${focusedSessions.length}</span>`,
    '</button>',
    '<div class="project-action-group">',
    renderProjectActionButton({
      projectId,
      action: 'start',
      label: '新会话',
      tone: 'primary',
      icon: renderProjectActionIcon('start'),
      dataAttribute: 'data-project-session-start',
    }),
    renderProjectActionButton({
      projectId,
      action: 'history',
      label: '添加历史会话',
      tone: 'secondary',
      icon: renderProjectActionIcon('history'),
      dataAttribute: 'data-project-history-open',
    }),
    `<button class="project-close" type="button" data-project-close="${escapeHtml(projectId)}" aria-label="关闭项目" title="关闭项目">×</button>`,
    '</div>',
    '</div>',
    '</header>',
    project.collapsed
      ? ''
      : [
          '<div class="project-body">',
          renderFocusedSessions(project, state.selectedSessionId, state),
          '</div>',
        ].join(''),
    '</section>',
  ].join('');
}

function renderProjectActionButton({ projectId, action, label, tone, icon, dataAttribute }) {
  return [
    `<button class="project-action project-action--icon project-action--${escapeHtml(tone)}" type="button" ${dataAttribute}="${escapeHtml(projectId)}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}" data-project-action="${escapeHtml(action)}">`,
    icon,
    '</button>',
  ].join('');
}

function renderProjectActionIcon(kind) {
  if (kind === 'history') {
    return [
      '<span class="project-action-icon" aria-hidden="true">',
      '<svg viewBox="0 0 16 16" focusable="false">',
      '<path d="M8 3.2a4.8 4.8 0 1 1-3.64 1.67" />',
      '<path d="M4.36 2.9v2.6H1.8" />',
      '<path d="M8 5.35V8l1.9 1.32" />',
      '</svg>',
      '</span>',
    ].join('');
  }

  return [
    '<span class="project-action-icon" aria-hidden="true">',
    '<svg viewBox="0 0 16 16" focusable="false">',
    '<path d="M8 3.1v9.8" />',
    '<path d="M3.1 8h9.8" />',
    '</svg>',
    '</span>',
  ].join('');
}

function renderFocusedSessions(project, selectedSessionId, state) {
  const projectId = project.id ?? project.cwd ?? '__unknown__';
  const sessions = project.focusedSessions ?? [];
  const pendingItem =
    state.pendingSessionProjectId === projectId
      ? renderPendingSessionItem(project)
      : '';

  if (!sessions.length && !pendingItem) {
    return '<div class="empty-list">暂无关注会话</div>';
  }

  return [
    pendingItem,
    sessions
      .map((session) => renderFocusedSessionItem(projectId, session, selectedSessionId, state))
      .join(''),
  ]
    .filter(Boolean)
    .join('');
}

function renderFocusedSessionItem(projectId, session, selectedSessionId, state) {
  const selected = session.id === selectedSessionId ? ' aria-current="true"' : '';
  const sessionSignal = getSessionSignal(state, session.id, session.id === selectedSessionId);

  return [
    '<div class="focused-session-row">',
    '<div class="session-swipe-lane">',
    `<button class="session-item session-item--focused" data-session-id="${escapeHtml(session.id)}"${selected}>`,
    renderSessionItemBody(session, { signal: sessionSignal, showSubtitle: false }),
    '</button>',
    `<button class="focus-remove focus-remove--embedded" type="button" data-project-id="${escapeHtml(projectId)}" data-focused-remove="${escapeHtml(session.id)}" aria-label="移出关注">×</button>`,
    '</div>',
    '</div>',
  ].join('');
}

function renderPendingSessionItem(project) {
  return [
    '<div class="focused-session-row focused-session-row--draft">',
    '<div class="session-swipe-lane">',
    '<div class="session-item session-item--draft" aria-current="true">',
    renderSessionItemBody(
      {
        id: `draft:${project.id ?? project.cwd ?? '__unknown__'}`,
        name: '新会话',
        preview: '发送第一条消息后创建',
      },
      {
        signal: null,
        showSubtitle: false,
      },
    ),
    '</div>',
    '</div>',
    '</div>',
  ].join('');
}

function renderHistoryDialogContent(project, activeTab = 'active') {
  return [
    '<div class="history-dialog-shell">',
    '<div class="history-dialog-header">',
    '<div>',
    '<div class="history-dialog-eyebrow">添加历史会话</div>',
    `<h2 class="history-dialog-title">${escapeHtml(project.displayName ?? project.cwd ?? 'Unknown Workspace')}</h2>`,
    '</div>',
    '<button class="history-dialog-close" type="button" data-history-dialog-close="true" aria-label="关闭">×</button>',
    '</div>',
    renderHistoryDialogTabs(activeTab),
    '<div class="history-picker">',
    activeTab === 'archived'
      ? renderHistorySection(
          project.id ?? project.cwd ?? '__unknown__',
          '已归档',
          project.historySessions?.archived ?? [],
          'archived',
        )
      : renderHistorySection(
          project.id ?? project.cwd ?? '__unknown__',
          '未归档',
          project.historySessions?.active ?? [],
          'active',
        ),
    '</div>',
    '</div>',
  ].join('');
}

function renderHistoryDialogTabs(activeTab) {
  return [
    '<div class="history-dialog-tabs" role="tablist" aria-label="历史会话分类">',
    renderHistoryDialogTab('active', '未归档', activeTab),
    renderHistoryDialogTab('archived', '已归档', activeTab),
    '</div>',
  ].join('');
}

function renderHistoryDialogTab(value, label, activeTab) {
  const selected = value === activeTab;
  return [
    `<button class="history-dialog-tab${selected ? ' history-dialog-tab--selected' : ''}" type="button" role="tab" aria-selected="${String(selected)}" data-history-dialog-tab="${value}">`,
    escapeHtml(label),
    '</button>',
  ].join('');
}

function renderHistorySection(projectId, title, sessions, sectionKind) {
  const items = sessions.length
    ? sessions.map((session) => renderHistoryItem(projectId, session, sectionKind)).join('')
    : '<div class="empty-list">暂时没有可导入的会话</div>';

  return [
    '<section class="history-section">',
    `<div class="history-section-title">${escapeHtml(title)}</div>`,
    items,
    '</section>',
  ].join('');
}

function renderHistoryItem(projectId, session, sectionKind) {
  const buttonClass = [
    'session-item',
    'session-item--history',
    sectionKind === 'archived' ? 'session-item--archived' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return [
    `<button class="${buttonClass}" type="button" data-project-id="${escapeHtml(projectId)}" data-project-history-add="${escapeHtml(session.id)}">`,
    renderSessionItemBody(session),
    '</button>',
  ].join('');
}

function renderSessionItemBody(session, { signal = null, showSubtitle = true } = {}) {
  const subtitle = showSubtitle ? getThreadSubtitle(session) : null;
  return [
    '<span class="session-item-inner">',
    '<span class="session-item-title-row">',
    renderSessionSignal(signal, { includePlaceholder: true }),
    `<span class="session-title">${escapeHtml(getThreadTitle(session))}</span>`,
    renderExternalSessionBadge(session),
    '</span>',
    subtitle
      ? `<span class="session-item-subtitle">${escapeHtml(subtitle)}</span>`
      : '',
    '</span>',
  ].join('');
}

function renderExternalSessionBadge(session, { variant = 'session' } = {}) {
  const badge = getExternalSessionBadge(session);
  if (!badge) {
    return '';
  }

  const className =
    variant === 'meta'
      ? `meta-chip meta-chip--external meta-chip--${badge.tone}`
      : `session-external-badge session-external-badge--${badge.tone}`;
  return `<span class="${className}" title="${escapeHtml(badge.title)}">${escapeHtml(badge.label)}</span>`;
}

function getExternalSessionBadge(session) {
  const external = session?.external;
  const bridgeMode = normalizeExternalBridgeMode(external?.bridgeMode);
  if (!bridgeMode) {
    return null;
  }

  if (bridgeMode === 'discovered') {
    return {
      tone: 'discovered',
      label: '已发现',
      title: '独立 Claude 会话已发现',
    };
  }

  if (bridgeMode === 'hooked') {
    if (isActiveExternalRuntime(session?.runtime)) {
      return {
        tone: 'hooked',
        label: '外部运行中',
        title: '独立 Claude 会话正在外部继续运行',
      };
    }
    return {
      tone: 'hooked',
      label: '已接管',
      title: '独立 Claude 会话已接入运行桥',
    };
  }

  if (isActiveExternalRuntime(session?.runtime)) {
    return {
      tone: 'hooked',
      label: '外部运行中',
      title: '独立 Claude 会话正在外部继续运行并同步转录进度',
    };
  }

  return {
    tone: 'hooked',
    label: '已跟踪',
    title: '独立 Claude 会话已接入运行桥并开启转录跟踪',
  };
}

function renderSessionSignal(signal, { includePlaceholder = false } = {}) {
  if (!signal) {
    return includePlaceholder
      ? '<span class="session-status-indicator session-status-indicator--placeholder" aria-hidden="true"></span>'
      : '';
  }

  if (signal.kind === 'busy') {
    return `<span class="session-status-indicator session-status-indicator--busy" title="${escapeHtml(signal.label)}" aria-label="${escapeHtml(signal.label)}"></span>`;
  }

  if (signal.kind === 'unread') {
    return `<span class="session-status-indicator session-status-indicator--unread" title="${escapeHtml(signal.label)}" aria-label="${escapeHtml(signal.label)}"></span>`;
  }

  if (signal.kind === 'approval') {
    return `<span class="session-status-indicator session-status-indicator--approval" title="${escapeHtml(signal.label)}" aria-label="${escapeHtml(signal.label)}"></span>`;
  }

  if (signal.kind === 'question') {
    return `<span class="session-status-indicator session-status-indicator--question" title="${escapeHtml(signal.label)}" aria-label="${escapeHtml(signal.label)}"></span>`;
  }

  return '';
}

function isActiveExternalRuntime(runtime) {
  return Boolean(
    runtime?.turnStatus === 'started' ||
      runtime?.turnStatus === 'interrupting' ||
      runtime?.activeTurnId ||
      runtime?.realtime?.status === 'started',
  );
}

function renderApprovalModeControls(
  state,
  approvalUiState = null,
  sessionSettingsUiState = null,
  { mobileViewport = false } = {},
) {
  const normalizedMode = normalizeApprovalMode(state?.approvalMode);
  const sessionOptions = normalizeSessionOptions(state?.sessionOptions);
  const selectedSettings = getSelectedSessionSettings(state);
  const selectedSessionId = String(state?.selectedSessionId ?? '').trim();
  const sessionBusy = isSessionBusy(state, selectedSessionId);
  const approvalPending = approvalUiState?.approvalModePending === true;
  const sessionSettingsPending =
    sessionSettingsUiState?.pending === true &&
    sessionSettingsUiState?.pendingThreadId === selectedSessionId;
  const sessionSettingsDisabled =
    sessionSettingsPending || !canEditSessionSettings(state, selectedSessionId);
  const approvalDisabled = approvalPending || sessionBusy;
  const sandboxMode =
    firstNonEmptyText(sessionOptions.runtimeContext?.sandboxMode) ?? '未提供';
  const inlineFeedback = [
    sessionSettingsUiState?.error
      ? `<div class="approval-feedback approval-feedback--inline" role="status">${escapeHtml(sessionSettingsUiState.error)}</div>`
      : '',
    approvalUiState?.error
      ? `<div class="approval-feedback approval-feedback--inline" role="status">${escapeHtml(approvalUiState.error)}</div>`
      : '',
  ]
    .filter(Boolean)
    .join('');

  const settingDescriptors = [
    {
      kind: 'select',
      settingKey: 'model',
      label: '模型',
      ariaLabel: '模型',
      dataAttribute: 'data-session-model-select',
      options: sessionOptions.modelOptions,
      value: selectedSettings.model,
      disabled: sessionSettingsDisabled,
      pending: sessionSettingsPending,
      valueLabel: resolveSessionOptionLabel(sessionOptions.modelOptions, selectedSettings.model),
    },
    {
      kind: 'select',
      settingKey: 'reasoning',
      label: '推理强度',
      ariaLabel: '推理强度',
      dataAttribute: 'data-session-reasoning-select',
      options: sessionOptions.reasoningEffortOptions,
      value: selectedSettings.reasoningEffort,
      disabled: sessionSettingsDisabled,
      pending: sessionSettingsPending,
      valueLabel: resolveSessionOptionLabel(
        sessionOptions.reasoningEffortOptions,
        selectedSettings.reasoningEffort,
      ),
    },
    {
      kind: 'readonly',
      settingKey: 'sandbox',
      label: '沙箱隔离类型',
      value: sandboxMode,
    },
    {
      kind: 'select',
      settingKey: 'approval',
      label: '审批模式',
      ariaLabel: '审批模式',
      dataAttribute: 'data-approval-mode-select',
      options: [
        { value: 'manual', label: '手动审批' },
        { value: 'auto-approve', label: '自动通过' },
      ],
      value: normalizedMode,
      disabled: approvalDisabled,
      pending: approvalPending,
      valueLabel: resolveSessionOptionLabel(
        [
          { value: 'manual', label: '手动审批' },
          { value: 'auto-approve', label: '自动通过' },
        ],
        normalizedMode,
      ),
    },
  ];
  const controlsMarkup = settingDescriptors
    .map((descriptor) => renderComposerSettingControl(descriptor))
    .join('');

  if (!mobileViewport) {
    return [
      '<div class="composer-settings-row" role="group" aria-label="会话与审批设置">',
      controlsMarkup,
      inlineFeedback,
      '</div>',
    ].join('');
  }

  const scopeId = getComposerSettingsScopeId(state);
  const collapsed = isComposerSettingsCollapsed(state, scopeId, mobileViewport);

  return [
    `<div class="composer-settings-mobile-shell" data-composer-settings-collapsed="${String(collapsed)}">`,
    renderComposerSettingsSummary(settingDescriptors, scopeId, collapsed),
    `<div class="composer-settings-mobile-panel"${collapsed ? ' hidden' : ''}>`,
    '<div class="composer-settings-row" role="group" aria-label="会话与审批设置">',
    controlsMarkup,
    '</div>',
    '</div>',
    inlineFeedback,
    '</div>',
  ].join('');
}

function renderComposerSettingControl(descriptor) {
  return descriptor.kind === 'readonly'
    ? renderSettingsReadonlyControl(descriptor)
    : renderSettingsSelectControl(descriptor);
}

function renderComposerSettingsSummary(settingDescriptors, scopeId, collapsed) {
  return [
    '<div class="composer-settings-mobile-summary-row">',
    '<div class="composer-settings-mobile-summary" data-composer-settings-summary="true" role="note" aria-label="当前会话设置摘要">',
    settingDescriptors.map((descriptor) => renderComposerSettingsSummaryItem(descriptor)).join(''),
    '</div>',
    `<button class="composer-settings-mobile-toggle" type="button" data-composer-settings-toggle="true" data-composer-settings-scope="${escapeHtml(scopeId)}" aria-expanded="${String(!collapsed)}" aria-label="${collapsed ? '展开设置底栏' : '收起设置底栏'}">`,
    collapsed ? '▾' : '▴',
    '</button>',
    '</div>',
  ].join('');
}

function renderComposerSettingsSummaryItem(descriptor) {
  return [
    `<span class="composer-settings-mobile-summary-item" data-composer-settings-summary-item="${escapeHtml(descriptor.settingKey)}">`,
    `<span class="composer-settings-mobile-summary-label">${escapeHtml(descriptor.label)}</span>`,
    `<span class="composer-settings-mobile-summary-value">${escapeHtml(
      formatComposerSettingsSummaryValue(descriptor),
    )}</span>`,
    '</span>',
  ].join('');
}

function formatComposerSettingsSummaryValue(descriptor) {
  const value =
    descriptor.kind === 'readonly'
      ? descriptor.value
      : descriptor.valueLabel || '默认';

  if (descriptor.settingKey === 'sandbox') {
    return truncateMiddleText(value, 24);
  }

  return value;
}

function truncateMiddleText(value, maxLength = 24) {
  const normalizedValue = String(value ?? '').trim();
  if (!normalizedValue || normalizedValue.length <= maxLength) {
    return normalizedValue || '未提供';
  }

  const headLength = Math.max(8, Math.ceil((maxLength - 1) / 2));
  const tailLength = Math.max(4, maxLength - headLength - 1);
  return `${normalizedValue.slice(0, headLength)}…${normalizedValue.slice(-tailLength)}`;
}

function renderSettingsSelectControl({
  settingKey,
  label,
  ariaLabel,
  dataAttribute,
  options,
  value,
  disabled = false,
  pending = false,
  valueLabel = '默认',
}) {
  const normalizedValue = String(value ?? '');
  return [
    `<div class="composer-settings-item composer-settings-item--editable" data-composer-setting="${escapeHtml(settingKey)}">`,
    '<div class="composer-settings-item-copy">',
    `<span class="composer-settings-item-label" data-composer-setting-label="${escapeHtml(settingKey)}">${escapeHtml(label)}</span>`,
    `<span class="composer-settings-item-value" data-composer-setting-value="${escapeHtml(settingKey)}">${escapeHtml(valueLabel || '默认')}</span>`,
    '</div>',
    `<label class="composer-settings-select-wrap${pending ? ' composer-settings-select-wrap--pending' : ''}">`,
    `<span class="sr-only">${escapeHtml(ariaLabel)}</span>`,
    `<select class="composer-settings-select approval-mode-select" ${dataAttribute}="true" aria-label="${escapeHtml(ariaLabel)}"${disabled ? ' disabled' : ''}>`,
    (options ?? [])
      .map((option) =>
        renderSettingsSelectOption(option?.value ?? '', option?.label ?? '', normalizedValue),
      )
      .join(''),
    '</select>',
    '<span class="composer-settings-select-icon approval-mode-select-icon" aria-hidden="true">▾</span>',
    '</label>',
    '</div>',
  ].join('');
}

function renderSettingsReadonlyControl({ settingKey, label, value }) {
  return [
    `<div class="composer-settings-item composer-settings-item--readonly" data-composer-setting="${escapeHtml(settingKey)}">`,
    `<span class="composer-settings-item-label" data-composer-setting-label="${escapeHtml(settingKey)}">${escapeHtml(label)}</span>`,
    `<span class="composer-settings-item-value" data-composer-setting-value="${escapeHtml(settingKey)}">${escapeHtml(value)}</span>`,
    '</div>',
  ].join('');
}

function renderSettingsSelectOption(value, label, activeValue) {
  const normalizedValue = String(value ?? '');
  return `<option value="${escapeHtml(normalizedValue)}"${normalizedValue === activeValue ? ' selected' : ''}>${escapeHtml(label)}</option>`;
}

function renderTurn(turn, index) {
  const items = turn.items?.length
    ? turn.items.map((item) => renderTurnItem(item)).join('')
    : '<div class="message-bubble message-bubble--system">这个 turn 没有可显示的消息。</div>';

  return [
    `<section class="turn-card" data-turn-card="${index}">`,
    '<div class="turn-card-header">',
    `<span>Turn ${index + 1}</span>`,
    `<span>${escapeHtml(turn.status ?? 'unknown')}</span>`,
    '</div>',
    items,
    '</section>',
  ].join('');
}

function renderConversationNavigation() {
  return [
    '<div class="thread-nav" aria-label="会话跳转">',
    '<button class="thread-nav-button" type="button" data-conversation-nav="top">到顶部</button>',
    '<button class="thread-nav-button" type="button" data-conversation-nav="previous">上一回合</button>',
    '<button class="thread-nav-button" type="button" data-conversation-nav="next">下一回合</button>',
    '<button class="thread-nav-button thread-nav-button--primary" type="button" data-conversation-nav="bottom">到底部</button>',
    '</div>',
  ].join('');
}

function renderTurnItem(item) {
  const renderer = TURN_ITEM_RENDERERS[item.type] ?? renderFallbackTurnItem;
  return renderer(item);
}

function renderMessageBubble(label, text, role, options = {}) {
  const classes = ['message-bubble', `message-bubble--${role}`];
  if (options.streaming) {
    classes.push('message-bubble--streaming');
  }
  const messageText = String(text ?? '').trim() || 'Empty message';
  const renderedMessage = renderMarkdownMessage(messageText);

  return [
    `<div class="${classes.join(' ')}">`,
    `<div class="message-role">${escapeHtml(label)}</div>`,
    `<div class="${renderedMessage.className}">${renderedMessage.html}</div>`,
    options.attachmentsHtml ?? '',
    '</div>',
  ].join('');
}

function renderUserMessageBubble(item) {
  const messageText = extractUserText(item) || '已发送附件';
  return renderMessageBubble('用户', messageText, 'user', {
    attachmentsHtml: renderUserMessageAttachments(item),
  });
}

function renderUserMessageAttachments(item) {
  const attachments = collectUserMessageAttachments(item);
  if (attachments.length === 0) {
    return '';
  }

  return [
    '<div class="message-attachments" role="list">',
    attachments.map((attachment) => renderUserMessageAttachmentCard(attachment)).join(''),
    '</div>',
  ].join('');
}

function renderUserMessageAttachmentCard(attachment) {
  const title = attachment.name ?? inferAttachmentLabel(attachment);
  const detail = attachment.mimeType ?? 'application/octet-stream';

  return [
    '<div class="message-attachment-card" role="listitem">',
    attachment.kind === 'image' && attachment.url
      ? `<img class="message-attachment-thumb" alt="${escapeHtml(title)}" src="${escapeHtml(attachment.url)}" />`
      : `<div class="message-attachment-placeholder">${escapeHtml(inferAttachmentLabel(attachment))}</div>`,
    '<div class="message-attachment-meta">',
    `<div class="message-attachment-title">${escapeHtml(title)}</div>`,
    `<div class="message-attachment-detail">${escapeHtml(detail)}</div>`,
    attachment.previewText
      ? `<div class="message-attachment-preview">${escapeHtml(attachment.previewText)}</div>`
      : '',
    '</div>',
    '</div>',
  ].join('');
}

function renderPlanTurnItem(item) {
  const normalizedPlan = normalizeTurnPlan(item);
  const structuredBody = normalizedPlan?.steps.length
    ? [
        normalizedPlan.explanation
          ? `<div class="thread-item-section"><div class="thread-item-section-title">说明</div><p class="thread-item-paragraph">${escapeHtml(normalizedPlan.explanation)}</p></div>`
          : '',
        '<div class="thread-item-section">',
        '<div class="thread-item-section-title">任务列表</div>',
        '<div class="task-plan-list" role="list">',
        normalizedPlan.steps.map((step, index) => renderTaskPlanStep(step, index)).join(''),
        '</div>',
        '</div>',
      ]
        .filter(Boolean)
        .join('')
    : '';

  return renderThreadItemCard({
    label: '计划',
    title: '执行计划',
    tone: 'plan',
    status: null,
    body:
      structuredBody || renderParagraphList(splitMultilineText(normalizedPlan?.text ?? item.text)),
  });
}

function renderReasoningTurnItem(item) {
  const summary = renderParagraphList(item.summary ?? []);
  const content = renderParagraphList(item.content ?? []);

  return renderThreadItemCard({
    label: '推理',
    title: '推理摘要',
    tone: 'reasoning',
    status: null,
    body: [
      summary ? `<div class="thread-item-section"><div class="thread-item-section-title">Summary</div>${summary}</div>` : '',
      content ? `<div class="thread-item-section"><div class="thread-item-section-title">Details</div>${content}</div>` : '',
    ]
      .filter(Boolean)
      .join(''),
  });
}

function renderCommandExecutionTurnItem(item) {
  return renderThreadItemCard({
    label: '命令执行',
    title: item.command || 'Command',
    tone: 'command',
    status: formatItemStatus(item.status),
    statusTone: item.status,
    collapsible: true,
    expanded: false,
    body: [
      item.cwd ? `<div class="thread-item-meta-line">cwd: ${escapeHtml(item.cwd)}</div>` : '',
      item.aggregatedOutput
        ? `<pre class="thread-item-pre">${escapeHtml(item.aggregatedOutput)}</pre>`
        : '<div class="thread-item-empty">还没有输出</div>',
    ]
      .filter(Boolean)
      .join(''),
  });
}

function renderMcpToolCallTurnItem(item) {
  return renderThreadItemCard({
    label: 'MCP 工具',
    title: `${item.server || 'unknown'} / ${item.tool || 'unknown'}`,
    tone: 'mcp',
    status: formatItemStatus(item.status),
    statusTone: item.status,
    body: [
      renderKeyValueList([
        ['Server', item.server],
        ['Tool', item.tool],
      ]),
      hasJsonValue(item.arguments)
        ? `<pre class="thread-item-pre">${escapeHtml(JSON.stringify(item.arguments, null, 2))}</pre>`
        : '',
      renderProgressList(item.progressMessages ?? []),
      item.error ? `<pre class="thread-item-pre thread-item-pre--error">${escapeHtml(JSON.stringify(item.error, null, 2))}</pre>` : '',
      item.result ? `<pre class="thread-item-pre">${escapeHtml(JSON.stringify(item.result, null, 2))}</pre>` : '',
    ]
      .filter(Boolean)
      .join(''),
  });
}

function renderCollabAgentTurnItem(item) {
  return renderThreadItemCard({
    label: 'Subagent',
    title: item.tool || 'spawnAgent',
    tone: 'subagent',
    status: formatItemStatus(item.status),
    statusTone: item.status,
    body: `<pre class="thread-item-pre">${escapeHtml(formatCollabToolCall(item))}</pre>`,
  });
}

function renderFileChangeTurnItem(item) {
  const title =
    item.path ??
    item.relativePath ??
    item.filePath ??
    item.targetPath ??
    item.uri ??
    item.name ??
    '文件变更';
  const changeType = firstNonEmptyText(item.changeType, item.operation, item.kind, item.event);
  const preview = firstNonEmptyText(item.diff, item.patch, item.content, item.preview);
  const extra = omitObjectKeys(item, [
    'type',
    'id',
    'path',
    'relativePath',
    'filePath',
    'targetPath',
    'uri',
    'name',
    'changeType',
    'operation',
    'kind',
    'event',
    'diff',
    'patch',
    'content',
    'preview',
    'status',
  ]);

  const body = [
    changeType ? `<div class="thread-item-meta-line">类型: ${escapeHtml(changeType)}</div>` : '',
    preview ? `<pre class="thread-item-pre">${escapeHtml(preview)}</pre>` : '',
    hasJsonValue(extra)
      ? `<pre class="thread-item-pre">${escapeHtml(JSON.stringify(extra, null, 2))}</pre>`
      : '',
  ]
    .filter(Boolean)
    .join('');

  return renderThreadItemCard({
    label: '文件变更',
    title,
    tone: 'fileChange',
    status: formatItemStatus(item.status),
    statusTone: item.status,
    collapsible: true,
    expanded: false,
    body: body || '<div class="thread-item-empty">暂无更多详情</div>',
  });
}

function renderFallbackTurnItem(item) {
  return renderThreadItemCard({
    label: '通用事件',
    title: item.type ?? 'unknown',
    tone: 'generic',
    status: null,
    body: `<pre class="thread-item-pre">${escapeHtml(JSON.stringify(item, null, 2))}</pre>`,
  });
}

function renderThreadItemCard({
  label,
  title,
  tone,
  status,
  statusTone = null,
  body,
  collapsible = false,
  expanded = true,
}) {
  const classes = ['thread-item-card', `thread-item-card--${tone}`];
  const statusBadge = renderThreadItemStatusBadge(status, statusTone);
  const cardHeader = renderThreadItemCardCopy({
    label,
    title,
    trailingMeta: collapsible ? '' : statusBadge,
  });

  if (collapsible) {
    classes.push('thread-item-card--collapsible');
    return [
      `<details class="${classes.join(' ')}"${expanded ? ' open' : ''}>`,
      '<summary class="thread-item-card-summary">',
      `<div class="thread-item-card-summary-copy">${cardHeader}</div>`,
      '<div class="thread-item-card-summary-meta">',
      statusBadge,
      renderThreadItemDisclosure(),
      '</div>',
      '</summary>',
      body ? `<div class="thread-item-card-body">${body}</div>` : '',
      '</details>',
    ].join('');
  }

  return [
    `<section class="${classes.join(' ')}">`,
    cardHeader,
    body ? `<div class="thread-item-card-body">${body}</div>` : '',
    '</section>',
  ].join('');
}

function renderThreadItemCardCopy({ label, title, trailingMeta = '' }) {
  return [
    '<div class="thread-item-card-header">',
    `<div class="thread-item-card-label">${escapeHtml(label)}</div>`,
    trailingMeta,
    '</div>',
    `<div class="thread-item-card-title">${escapeHtml(title || 'Untitled')}</div>`,
  ].join('');
}

function renderThreadItemStatusBadge(status, statusTone) {
  if (!status) {
    return '';
  }

  const tone = normalizeThreadItemStatusTone(statusTone);
  return `<span class="thread-item-card-status thread-item-card-status--${tone}">${escapeHtml(status)}</span>`;
}

function renderThreadItemDisclosure() {
  return [
    '<span class="thread-item-card-toggle" aria-hidden="true">',
    '<span class="thread-item-card-toggle-label thread-item-card-toggle-label--expand">展开</span>',
    '<span class="thread-item-card-toggle-label thread-item-card-toggle-label--collapse">收起</span>',
    '<span class="thread-item-card-toggle-icon"></span>',
    '</span>',
  ].join('');
}

function renderParagraphList(items) {
  const values = (items ?? []).map((item) => String(item ?? '').trim()).filter(Boolean);
  if (!values.length) {
    return '';
  }

  return values.map((value) => `<p class="thread-item-paragraph">${escapeHtml(value)}</p>`).join('');
}

function renderKeyValueList(entries) {
  const values = entries.filter(([, value]) => value != null && String(value).trim() !== '');
  if (!values.length) {
    return '';
  }

  return values
    .map(([key, value]) => {
      return `<div class="thread-item-meta-line"><strong>${escapeHtml(key)}:</strong> ${escapeHtml(value)}</div>`;
    })
    .join('');
}

function renderProgressList(messages) {
  const values = (messages ?? []).map((message) => String(message ?? '').trim()).filter(Boolean);
  if (!values.length) {
    return '';
  }

  return [
    '<div class="thread-item-section">',
    '<div class="thread-item-section-title">Progress</div>',
    values.map((message) => `<p class="thread-item-paragraph">${escapeHtml(message)}</p>`).join(''),
    '</div>',
  ].join('');
}

function splitMultilineText(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function formatItemStatus(status) {
  if (!status) {
    return null;
  }

  const labels = {
    inProgress: '进行中',
    completed: '已完成',
    failed: '失败',
    pending: '待处理',
    success: '成功',
  };

  return labels[status] ?? String(status);
}

function normalizeThreadItemStatusTone(status) {
  const normalized = String(status ?? '').trim();
  if (!normalized) {
    return 'neutral';
  }

  const knownStatuses = new Set(['inProgress', 'completed', 'failed', 'pending', 'success']);
  return knownStatuses.has(normalized) ? normalized : 'neutral';
}

function hasJsonValue(value) {
  if (value == null) {
    return false;
  }

  if (typeof value === 'object') {
    return Object.keys(value).length > 0;
  }

  return String(value).trim().length > 0;
}

const TURN_ITEM_RENDERERS = {
  userMessage: renderUserMessageBubble,
  agentMessage(item) {
    const label = item.phase === 'final_answer' ? '助手' : '助手过程';
    return renderMessageBubble(label, item.text ?? '', 'assistant', {
      streaming: Boolean(item.streaming),
    });
  },
  plan: renderPlanTurnItem,
  reasoning: renderReasoningTurnItem,
  commandExecution: renderCommandExecutionTurnItem,
  fileChange: renderFileChangeTurnItem,
  mcpToolCall: renderMcpToolCallTurnItem,
  collabAgentToolCall: renderCollabAgentTurnItem,
};

function collectSubagentEntries(session) {
  const subagentsById = new Map();

  for (const [turnIndex, turn] of (session.turns ?? []).entries()) {
    for (const item of turn.items ?? []) {
      if (item.type !== 'collabAgentToolCall') {
        continue;
      }

      const candidateIds = [
        ...(item.receiverThreadIds ?? []),
        ...Object.keys(item.agentsStates ?? {}),
      ].filter(Boolean);

      for (const agentId of [...new Set(candidateIds)]) {
        const agentState = item.agentsStates?.[agentId];
        const statusKey = agentState?.status ?? normalizeCollabToolCallStatus(item.status);
        subagentsById.set(agentId, {
          id: agentId,
          statusKey,
          statusLabel: formatCollabAgentStatus(statusKey),
          statusTone: getCollabAgentTone(statusKey),
          turnIndex,
          jumpTitle: `跳到第 ${turnIndex + 1} 回合查看 ${agentId}`,
        });
      }
    }
  }

  return [...subagentsById.values()].sort((left, right) => left.turnIndex - right.turnIndex);
}

function formatCollabToolCall(item) {
  const agentIds = [...new Set([...(item.receiverThreadIds ?? []), ...Object.keys(item.agentsStates ?? {})])];
  const lines = [
    `工具: ${item.tool ?? 'unknown'}`,
    `目标: ${agentIds.join(', ') || 'unknown'}`,
  ];

  if (agentIds.length) {
    for (const agentId of agentIds) {
      const agentState = item.agentsStates?.[agentId];
      const statusKey = agentState?.status ?? normalizeCollabToolCallStatus(item.status);
      const message = agentState?.message;
      lines.push(`${agentId}: ${formatCollabAgentStatus(statusKey)}${message ? ` - ${message}` : ''}`);
    }
  } else {
    lines.push(`状态: ${formatCollabAgentStatus(normalizeCollabToolCallStatus(item.status))}`);
  }

  return lines.join('\n');
}

function renderActivityPanel(state) {
  const pendingProject = getPendingSessionProject(state);
  if (pendingProject) {
    return renderActivitySplitLayout({
      activityBody: `<p>将在 ${escapeHtml(pendingProject.displayName ?? pendingProject.cwd ?? '当前项目')} 发送第一条消息后创建会话。</p>`,
      tasksBody: '<p class="activity-empty">发送第一条消息后，这里会同步展示任务列表。</p>',
    });
  }

  if (!state.selectedSessionId) {
    return renderActivitySplitLayout({
      activityBody: '<p>选择会话后，这里会显示当前 turn 状态和 diff。</p>',
      tasksBody: '<p class="activity-empty">选择会话后，这里会显示当前任务列表。</p>',
    });
  }

  const selectedDetail = state.sessionDetailsById[state.selectedSessionId] ?? null;
  const status = state.turnStatusBySession[state.selectedSessionId] ?? 'idle';
  const diff = state.diffBySession[state.selectedSessionId];
  const realtime = normalizeRealtimeSessionState(state.realtimeBySession[state.selectedSessionId]);

  return renderActivitySplitLayout({
    activityBody: [
      `<div class="meta-chip">${escapeHtml(status)}</div>`,
      renderActivityRealtime(realtime),
      diff
        ? `<pre class="diff-view">${escapeHtml(diff)}</pre>`
        : '<p class="activity-empty">这个会话还没有 diff 事件。</p>',
    ].join(''),
    tasksBody: renderTaskListPanel(selectedDetail),
  });
}

function renderActivityRealtime(realtime) {
  if (!hasRealtimeSessionData(realtime)) {
    return '<p class="activity-empty">这个会话还没有 realtime 事件。</p>';
  }

  const latestItem = realtime.items.at(-1) ?? null;

  return [
    '<section class="activity-realtime">',
    '<div class="activity-realtime-header">',
    '<div class="activity-realtime-title">实时流</div>',
    `<span class="meta-chip">${escapeHtml(realtime.status)}</span>`,
    '</div>',
    '<div class="activity-realtime-body">',
    realtime.sessionId
      ? `<p class="activity-realtime-line"><strong>Session:</strong> ${escapeHtml(realtime.sessionId)}</p>`
      : '',
    latestItem
      ? `<p class="activity-realtime-line"><strong>Latest:</strong> #${latestItem.index} ${escapeHtml(latestItem.summary)}</p>`
      : '',
    realtime.audioChunkCount > 0
      ? `<p class="activity-realtime-line"><strong>Audio:</strong> ${escapeHtml(formatRealtimeAudioSummary(realtime))}</p>`
      : '',
    realtime.lastError
      ? `<p class="activity-realtime-line"><strong>Error:</strong> ${escapeHtml(realtime.lastError)}</p>`
      : '',
    realtime.closeReason
      ? `<p class="activity-realtime-line"><strong>Closed:</strong> ${escapeHtml(realtime.closeReason)}</p>`
      : '',
    '</div>',
    '</section>',
  ].join('');
}

function renderActivitySplitLayout({ activityBody, tasksBody }) {
  return [
    '<div class="activity-split-layout">',
    renderActivitySplitSection({
      title: '活动',
      body: activityBody,
      className: 'activity-split-section activity-split-section--activity',
    }),
    renderActivitySplitSection({
      title: '任务列表',
      body: tasksBody,
      className: 'activity-split-section activity-split-section--tasks',
    }),
    '</div>',
  ].join('');
}

function renderActivitySplitSection({ title, body, className = 'activity-split-section' }) {
  return [
    `<section class="${className}">`,
    '<div class="activity-card activity-split-card">',
    `<div class="activity-split-header"><h2>${escapeHtml(title)}</h2></div>`,
    `<div class="activity-split-body">${body}</div>`,
    '</div>',
    '</section>',
  ].join('');
}

function renderTaskListPanel(session) {
  const latestPlan = extractLatestTurnPlan(session);
  if (!latestPlan) {
    return '<p class="activity-empty">这个会话还没有任务计划。</p>';
  }

  const stepMarkup = latestPlan.steps.length
    ? [
        '<div class="task-plan-list" role="list">',
        latestPlan.steps
          .map((step, index) => renderTaskPlanStep(step, index))
          .join(''),
        '</div>',
      ].join('')
    : '';
  const textMarkup =
    !latestPlan.steps.length && latestPlan.text
      ? renderParagraphList(splitMultilineText(latestPlan.text))
      : '';

  return [
    latestPlan.explanation
      ? `<p class="task-plan-explanation">${escapeHtml(latestPlan.explanation)}</p>`
      : '',
    stepMarkup,
    textMarkup,
  ]
    .filter(Boolean)
    .join('');
}

function renderTaskPlanStep(step, index) {
  const statusTone = getPlanStepTone(step.status);
  return [
    '<div class="task-plan-step" role="listitem">',
    '<div class="task-plan-step-copy">',
    `<div class="task-plan-step-index">${index + 1}</div>`,
    `<div class="task-plan-step-text">${escapeHtml(step.step)}</div>`,
    '</div>',
    `<span class="task-plan-step-status task-plan-step-status--${statusTone}">${escapeHtml(formatPlanStepStatus(step.status))}</span>`,
    '</div>',
  ].join('');
}

function syncTaskSummaryBand(node, session, state, mobileViewport = false) {
  if (!node) {
    return;
  }

  if (!session && !state.pendingSessionProjectId) {
    node.hidden = true;
    node.innerHTML = '';
    return;
  }

  node.hidden = false;
  node.innerHTML = renderTaskSummaryBand(session, state, { mobileViewport });
}

function renderTaskSummaryBand(session, state, { mobileViewport = false } = {}) {
  const summary = summarizeLatestPlan(session);
  if (!summary) {
    return [
      '<div class="task-summary-placeholder">',
      '<span class="task-summary-placeholder-icon" aria-hidden="true">·</span>',
      '<span>暂无任务计划</span>',
      '</div>',
    ].join('');
  }

  const collapsed = isTaskSummaryCollapsed(state, session?.id, mobileViewport);
  return [
    `<section class="task-summary-band" data-task-summary-collapsed="${String(collapsed)}">`,
    '<div class="task-summary-band-header">',
    `<div class="task-summary-band-title">已完成 ${summary.completedCount} 个任务（共 ${summary.total} 个）</div>`,
    `<button class="task-summary-band-toggle" type="button" data-task-summary-toggle="true" data-task-summary-session-id="${escapeHtml(session?.id ?? '')}" aria-expanded="${String(!collapsed)}">`,
    collapsed ? '展开任务概览' : '收起任务概览',
    '</button>',
    '</div>',
    summary.explanation
      ? `<p class="task-summary-band-explanation">${escapeHtml(summary.explanation)}</p>`
      : '',
    collapsed ? '' : renderTaskSummaryBreakdown(summary),
    '</section>',
  ].join('');
}

function renderTaskSummaryBreakdown(summary) {
  return [
    '<div class="task-summary-breakdown" data-task-summary-breakdown="true">',
    renderTaskSummaryGroup('completed', '已完成', summary.completedPreview),
    renderTaskSummaryGroup('running', '进行中', summary.runningPreview),
    renderTaskSummaryGroup('upcoming', '即将开始', summary.upcomingPreview),
    '</div>',
  ].join('');
}

function renderTaskSummaryGroup(group, title, items) {
  if (!items.length) {
    return '';
  }

  return [
    `<section class="task-summary-group task-summary-group--${group}" data-task-summary-group="${group}">`,
    `<div class="task-summary-group-title">${escapeHtml(title)}</div>`,
    '<div class="task-summary-group-list">',
    items.map((item) => renderTaskSummaryItem(group, item)).join(''),
    '</div>',
    '</section>',
  ].join('');
}

function renderTaskSummaryItem(group, item) {
  return [
    `<div class="task-summary-item task-summary-item--${group}" data-task-summary-item-group="${group}">`,
    escapeHtml(item.step),
    '</div>',
  ].join('');
}

function summarizeLatestPlan(session) {
  const latestPlan = extractLatestTurnPlan(session);
  if (!latestPlan) {
    return null;
  }

  const steps = latestPlan.steps ?? [];
  const completed = steps.filter((step) => step.status === 'completed');
  const running = steps.filter((step) => step.status === 'inProgress');
  const upcoming = steps.filter((step) => step.status !== 'completed' && step.status !== 'inProgress');

  return {
    total: steps.length,
    explanation: latestPlan.explanation ?? null,
    completedCount: completed.length,
    completedPreview: completed.slice(-2),
    runningPreview: running.slice(0, 1),
    upcomingPreview: upcoming.slice(0, 2),
  };
}

function isTaskSummaryCollapsed(state, sessionId, mobileViewport = false) {
  const normalizedSessionId = String(sessionId ?? '').trim();
  if (!normalizedSessionId) {
    return Boolean(mobileViewport);
  }

  const explicitState = state?.taskSummaryCollapsedBySession?.[normalizedSessionId];
  if (typeof explicitState === 'boolean') {
    return explicitState;
  }

  return Boolean(mobileViewport);
}

function getComposerSettingsScopeId(state) {
  const selectedSessionId = String(state?.selectedSessionId ?? '').trim();
  if (selectedSessionId) {
    return `session:${selectedSessionId}`;
  }

  const pendingProjectId = String(state?.pendingSessionProjectId ?? '').trim();
  if (pendingProjectId) {
    return `project:${pendingProjectId}`;
  }

  return 'global';
}

function isComposerSettingsCollapsed(state, scopeId = getComposerSettingsScopeId(state), mobileViewport = false) {
  if (!mobileViewport) {
    return false;
  }

  const normalizedScopeId = String(scopeId ?? '').trim();
  if (!normalizedScopeId) {
    return true;
  }

  const explicitState = state?.composerSettingsCollapsedByScope?.[normalizedScopeId];
  if (typeof explicitState === 'boolean') {
    return explicitState;
  }

  return true;
}

function syncComposerButtons(sendButton, interruptButton, state) {
  const primaryAction = resolveComposerPrimaryAction(state);

  if (sendButton) {
    sendButton.textContent = primaryAction.label;
    sendButton.disabled = primaryAction.disabled;
    sendButton.title = primaryAction.title;
    if (sendButton.dataset) {
      sendButton.dataset.action = primaryAction.kind;
    }
  }

  if (interruptButton) {
    interruptButton.hidden = true;
    interruptButton.disabled = true;
    interruptButton.textContent = '中断';
    interruptButton.title = '中断当前回合';
    if (interruptButton.dataset) {
      interruptButton.dataset.interruptable = String(primaryAction.kind === 'interrupt');
    }
  }
}

function resolveComposerPrimaryAction(state) {
  const sessionId = state.selectedSessionId;
  const status = sessionId ? state.turnStatusBySession[sessionId] ?? 'idle' : 'idle';

  if (canInterruptTurn(state)) {
    return {
      kind: 'interrupt',
      label: '停止',
      disabled: false,
      title: '停止当前回合',
    };
  }

  if (status === 'interrupting') {
    return {
      kind: 'interrupting',
      label: '停止中…',
      disabled: true,
      title: '正在停止当前回合',
    };
  }

  if (status === 'started') {
    return {
      kind: 'busy',
      label: '执行中…',
      disabled: true,
      title: '当前回合正在执行',
    };
  }

  const sendable = canSendTurn(state);
  return {
    kind: 'send',
    label: '发送',
    disabled: !sendable,
    title: sendable ? '发送当前输入' : '当前还不能发送',
  };
}

function syncComposerInput(composerInput, state) {
  if (!composerInput) {
    return;
  }

  if (composerInput.value !== state.composerDraft) {
    composerInput.value = state.composerDraft;
  }

  composerInput.disabled = !isAuthenticatedAppState(state);
  composerInput.placeholder = isAuthenticatedAppState(state)
    ? '输入下一步请求'
    : '请输入共享密码后再继续';
}

function syncComposerAttachmentsStrip(container, state) {
  if (!container) {
    return;
  }

  const attachments = normalizeComposerAttachments(state.composerAttachments);
  if (attachments.length === 0) {
    container.hidden = true;
    container.innerHTML = '';
    return;
  }

  container.hidden = false;
  container.innerHTML = [
    '<div class="composer-attachment-strip" role="list">',
    attachments.map((attachment) => renderComposerAttachmentCard(attachment)).join(''),
    '</div>',
  ].join('');
}

function syncComposerAttachmentError(container, state) {
  if (!container) {
    return;
  }

  const message = getComposerAttachmentError(state);
  container.hidden = !message;
  container.textContent = message ?? '';
}

function syncComposerInlineFeedback(container, state) {
  if (!container) {
    return;
  }

  const message = resolveComposerInlineFeedback(state);
  container.hidden = !message;
  container.textContent = message ?? '';
}

function resolveComposerInlineFeedback(state) {
  if (!isAuthenticatedAppState(state)) {
    return '登录后即可继续发送。';
  }

  const sessionId = String(state?.selectedSessionId ?? '').trim();
  const sessionMeta = sessionId
    ? state?.sessionDetailsById?.[sessionId] ?? findThreadMeta(state?.projects ?? [], sessionId)
    : null;
  const pendingApprovalCount = Number(
    sessionMeta?.pendingApprovalCount ?? 0,
  );
  if (sessionMeta?.waitingOnApproval || pendingApprovalCount > 0) {
    return '等待审批后可继续发送';
  }

  const pendingQuestionCount = Number(
    sessionMeta?.pendingQuestionCount ?? 0,
  );
  if (sessionMeta?.waitingOnQuestion || pendingQuestionCount > 0) {
    return '等待回答当前问题后可继续发送';
  }

  return null;
}

function syncComposerAttachmentActions(
  fileButton,
  fileActionButton,
  imageButton,
  menu,
  fileInput,
  imageInput,
  state,
) {
  const disabled = !isAuthenticatedAppState(state);
  const menuOpen = !disabled && state.composerAttachmentMenuOpen === true;

  if (fileButton) {
    fileButton.disabled = disabled;
    fileButton.hidden = false;
    fileButton.textContent = '+';
    fileButton.title = '添加附件';
    fileButton.setAttribute?.('aria-expanded', String(menuOpen));
  }

  if (fileActionButton) {
    fileActionButton.disabled = disabled;
    fileActionButton.hidden = !menuOpen;
    fileActionButton.textContent = '上传文件';
  }

  if (imageButton) {
    imageButton.disabled = disabled;
    imageButton.hidden = !menuOpen;
    imageButton.textContent = '上传图片';
  }

  if (menu) {
    menu.hidden = !menuOpen;
  }

  for (const element of [fileInput, imageInput]) {
    if (element) {
      element.disabled = disabled;
    }
  }
}

function getSessionSignal(state, sessionId, isSelected) {
  const sessionMeta = findThreadMeta(state.projects ?? [], sessionId);
  const status = state.turnStatusBySession?.[sessionId] ?? 'idle';
  const realtime = normalizeRealtimeSessionState(state.realtimeBySession?.[sessionId]);
  if (status === 'started' || status === 'interrupting' || realtime.status === 'started') {
    return {
      kind: 'busy',
      label: status === 'interrupting' ? '中断中' : '执行中',
    };
  }

  const pendingApprovalCount = Number(
    state.sessionDetailsById?.[sessionId]?.pendingApprovalCount ??
      sessionMeta?.pendingApprovalCount ??
      0,
  );
  const waitingOnApproval = Boolean(
    state.sessionDetailsById?.[sessionId]?.waitingOnApproval ??
      sessionMeta?.waitingOnApproval,
  );
  if (pendingApprovalCount > 0 || waitingOnApproval) {
    return {
      kind: 'approval',
      label: pendingApprovalCount > 0 ? `等待审批 ${pendingApprovalCount}` : '等待审批',
    };
  }

  const pendingQuestionCount = Number(
    state.sessionDetailsById?.[sessionId]?.pendingQuestionCount ??
      sessionMeta?.pendingQuestionCount ??
      0,
  );
  const waitingOnQuestion = Boolean(
    state.sessionDetailsById?.[sessionId]?.waitingOnQuestion ??
      sessionMeta?.waitingOnQuestion,
  );
  if (pendingQuestionCount > 0 || waitingOnQuestion) {
    return {
      kind: 'question',
      label: pendingQuestionCount > 0 ? `等待回复 ${pendingQuestionCount}` : '等待回复',
    };
  }

  const unreadCount = Number(state.unreadBySession?.[sessionId] ?? 0);
  if (!isSelected && unreadCount > 0) {
    return {
      kind: 'unread',
      label: '有未读更新',
    };
  }

  return null;
}

function canSendTurn(state, draftText = state.composerDraft) {
  if (!isAuthenticatedAppState(state)) {
    return false;
  }

  const hasDraftTarget = Boolean(state.selectedSessionId || state.pendingSessionProjectId);
  if (!hasDraftTarget || !String(draftText ?? '').trim()) {
    return false;
  }

  if (getComposerAttachmentError(state)) {
    return false;
  }

  const sessionId = state.selectedSessionId;
  if (!sessionId) {
    return true;
  }

  const sessionMeta =
    state.sessionDetailsById?.[sessionId] ?? findThreadMeta(state.projects ?? [], sessionId);
  if (
    sessionMeta?.waitingOnApproval ||
    Number(sessionMeta?.pendingApprovalCount ?? 0) > 0 ||
    sessionMeta?.waitingOnQuestion ||
    Number(sessionMeta?.pendingQuestionCount ?? 0) > 0
  ) {
    return false;
  }

  const status = state.turnStatusBySession[sessionId] ?? 'idle';
  return status !== 'started' && status !== 'interrupting';
}

function canInterruptTurn(state) {
  if (!isAuthenticatedAppState(state)) {
    return false;
  }

  const sessionId = state.selectedSessionId;
  if (!sessionId) {
    return false;
  }

  const turnId = state.activeTurnIdBySession[sessionId];
  const status = state.turnStatusBySession[sessionId] ?? 'idle';
  return Boolean(turnId) && status === 'started';
}

function extractUserText(item) {
  if (!Array.isArray(item.content)) {
    return '';
  }

  return item.content
    .map((entry) => {
      return entry.type === 'text' ? entry.text ?? '' : '';
    })
    .filter(Boolean)
    .join('\n');
}

function collectUserMessageAttachments(item) {
  if (!Array.isArray(item?.content)) {
    return [];
  }

  return item.content.flatMap((entry) => {
    if (entry?.type === 'image') {
      return [
        {
          kind: 'image',
          name: entry.name ?? '图片附件',
          mimeType: entry.mimeType ?? 'image/*',
          url: entry.url ?? null,
          previewText: null,
        },
      ];
    }

    if (entry?.type === 'attachmentSummary') {
      return [
        {
          kind: entry.attachmentType ?? 'file',
          name: entry.name ?? inferAttachmentLabel(entry),
          mimeType: entry.mimeType ?? 'application/octet-stream',
          url: null,
          previewText: entry.previewText ?? null,
        },
      ];
    }

    return [];
  });
}

function formatStatus(status) {
  if (!status) {
    return 'unknown';
  }

  return typeof status === 'string' ? status : status.type ?? 'unknown';
}

function formatApprovalKind(kind) {
  switch (kind) {
    case 'commandExecution':
      return '命令执行';
    case 'fileChange':
      return '文件变更';
    case 'permissions':
      return '权限';
    default:
      return kind ?? '审批';
  }
}

function formatApprovalStatus(status) {
  switch (status) {
    case 'pending':
      return '待处理';
    case 'approved':
      return '已批准';
    case 'denied':
      return '已拒绝';
    case 'auto-approved':
      return '自动通过';
    default:
      return status ?? '未知';
  }
}

function formatApprovalDetailLabel(key) {
  const labels = {
    command: '命令',
    cwd: '目录',
    reason: '原因',
    permissions: '权限',
    path: '路径',
    grantRoot: '根目录',
  };
  return labels[key] ?? key;
}

function normalizeApprovalMode(mode) {
  return mode === 'manual' ? 'manual' : 'auto-approve';
}

function createInitialSessionSettings() {
  return {
    model: null,
    reasoningEffort: null,
  };
}

function createInitialSessionOptions() {
  return normalizeSessionOptions();
}

function normalizeSessionSettings(settings) {
  return {
    model: normalizeSessionModel(settings?.model),
    reasoningEffort: normalizeSessionReasoningEffort(settings?.reasoningEffort),
  };
}

function normalizeSessionModel(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function normalizeSessionReasoningEffort(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function normalizeSessionOptions(options = null) {
  return {
    providerId: normalizeSessionProviderId(options?.providerId),
    attachmentCapabilities: normalizeSessionAttachmentCapabilities(options?.attachmentCapabilities),
    modelOptions: normalizeSessionOptionList(options?.modelOptions),
    reasoningEffortOptions: normalizeSessionOptionList(options?.reasoningEffortOptions),
    defaults: normalizeSessionSettings(options?.defaults),
    runtimeContext: normalizeSessionRuntimeContext(options?.runtimeContext),
  };
}

function normalizeSessionProviderId(providerId) {
  const normalized = String(providerId ?? '').trim();
  return normalized || null;
}

function normalizeSessionAttachmentCapabilities(capabilities) {
  if (!capabilities || typeof capabilities !== 'object') {
    return null;
  }

  const maxAttachments = Number(capabilities.maxAttachments ?? 0);
  const maxBytesPerAttachment = Number(capabilities.maxBytesPerAttachment ?? 0);
  const acceptedMimePatterns = Array.isArray(capabilities.acceptedMimePatterns)
    ? capabilities.acceptedMimePatterns.map((pattern) => String(pattern ?? '').trim()).filter(Boolean)
    : [];

  if (
    !Number.isFinite(maxAttachments) ||
    maxAttachments < 0 ||
    !Number.isFinite(maxBytesPerAttachment) ||
    maxBytesPerAttachment < 0
  ) {
    return null;
  }

  return {
    maxAttachments,
    maxBytesPerAttachment,
    acceptedMimePatterns,
    supportsNonImageFiles: capabilities.supportsNonImageFiles === true,
  };
}

function normalizeSessionRuntimeContext(runtimeContext) {
  if (!runtimeContext || typeof runtimeContext !== 'object') {
    return { sandboxMode: null };
  }

  return {
    sandboxMode: firstNonEmptyText(runtimeContext.sandboxMode) ?? null,
  };
}

function normalizeComposerAttachments(attachments) {
  return (attachments ?? [])
    .filter((attachment) => attachment && typeof attachment === 'object')
    .map((attachment) => ({
      id: String(attachment.id ?? ''),
      name: String(attachment.name ?? '未命名附件'),
      mimeType: String(attachment.mimeType ?? 'application/octet-stream'),
      size: Number(attachment.size ?? 0),
      dataBase64: String(attachment.dataBase64 ?? ''),
      preview: normalizeComposerAttachmentPreview(attachment.preview),
    }))
    .filter((attachment) => attachment.id && attachment.name && attachment.mimeType && attachment.dataBase64);
}

function normalizeComposerAttachmentPreview(preview) {
  if (!preview || typeof preview !== 'object') {
    return null;
  }

  const kind = String(preview.kind ?? '').trim();
  if (!kind) {
    return null;
  }

  return {
    kind,
    url: preview.url ? String(preview.url) : null,
    text: preview.text ? String(preview.text) : null,
  };
}

function normalizeComposerAttachmentError(error) {
  const normalized = String(error ?? '').trim();
  return normalized || null;
}

function getComposerAttachmentError(state) {
  return (
    normalizeComposerAttachmentError(state?.composerAttachmentError) ??
    normalizeComposerAttachmentError(
      validateDraftAttachments(
        normalizeComposerAttachments(state?.composerAttachments),
        normalizeSessionOptions(state?.sessionOptions),
      ).error,
    )
  );
}

function buildOptimisticUserContent(text, attachments = []) {
  const content = [{ type: 'text', text, text_elements: [] }];

  for (const attachment of normalizeComposerAttachments(attachments)) {
    if (attachment.mimeType.startsWith('image/')) {
      content.push({
        type: 'image',
        url:
          attachment.preview?.url ??
          `data:${attachment.mimeType};base64,${attachment.dataBase64}`,
        name: attachment.name,
        mimeType: attachment.mimeType,
      });
      continue;
    }

    content.push({
      type: 'attachmentSummary',
      attachmentType: attachment.mimeType === 'application/pdf' ? 'pdf' : 'text',
      mimeType: attachment.mimeType,
      name: attachment.name,
      previewText: attachment.preview?.text ?? null,
    });
  }

  return content;
}

function renderComposerAttachmentCard(attachment) {
  return [
    '<div class="composer-attachment-card" role="listitem">',
    attachment.preview?.kind === 'image' && attachment.preview?.url
      ? `<img class="composer-attachment-thumb" alt="${escapeHtml(attachment.name)}" src="${escapeHtml(attachment.preview.url)}" />`
      : `<div class="composer-attachment-placeholder">${escapeHtml(inferAttachmentLabel(attachment))}</div>`,
    '<div class="composer-attachment-copy">',
    `<div class="composer-attachment-title">${escapeHtml(attachment.name)}</div>`,
    `<div class="composer-attachment-meta">${escapeHtml(attachment.mimeType)} · ${escapeHtml(formatAttachmentSize(attachment.size))}</div>`,
    attachment.preview?.text
      ? `<div class="composer-attachment-preview">${escapeHtml(attachment.preview.text)}</div>`
      : '',
    '</div>',
    `<button class="composer-attachment-remove" type="button" data-composer-attachment-remove="${escapeHtml(attachment.id)}" aria-label="移除 ${escapeHtml(attachment.name)}">×</button>`,
    '</div>',
  ].join('');
}

function inferAttachmentLabel(attachment) {
  const kind = String(attachment?.kind ?? attachment?.attachmentType ?? '').trim();
  if (kind === 'image') {
    return '图片附件';
  }

  if (kind === 'pdf') {
    return 'PDF 附件';
  }

  if (kind === 'text') {
    return '文本附件';
  }

  return '文件附件';
}

function normalizeSessionOptionList(options) {
  const normalizedOptions = [];
  const seenValues = new Set();

  for (const option of options ?? []) {
    const value = String(option?.value ?? '').trim();
    if (seenValues.has(value)) {
      continue;
    }

    const label = String(option?.label ?? '').trim() || value || '默认';
    normalizedOptions.push({ value, label });
    seenValues.add(value);
  }

  if (!seenValues.has('')) {
    normalizedOptions.unshift({ value: '', label: '默认' });
    return normalizedOptions;
  }

  const defaultOption = normalizedOptions.find((option) => option.value === '') ?? {
    value: '',
    label: '默认',
  };

  return [
    defaultOption,
    ...normalizedOptions.filter((option) => option.value !== ''),
  ];
}

function resolveSessionOptionLabel(options, value) {
  const normalizedValue = String(value ?? '');
  const match = (options ?? []).find((option) => String(option?.value ?? '') === normalizedValue);
  if (match?.label) {
    return match.label;
  }

  return normalizedValue || '默认';
}

function getSelectedSessionSettings(state) {
  const sessionId = String(state?.selectedSessionId ?? '').trim();
  return normalizeSessionSettings(
    sessionId ? state?.sessionSettingsById?.[sessionId] : createInitialSessionSettings(),
  );
}

function canEditSessionSettings(state, sessionId = state?.selectedSessionId) {
  const targetSessionId = String(sessionId ?? '').trim();
  if (!isAuthenticatedAppState(state) || !targetSessionId) {
    return false;
  }

  return !isSessionBusy(state, targetSessionId);
}

function isSessionBusy(state, sessionId) {
  const targetSessionId = String(sessionId ?? '').trim();
  if (!targetSessionId) {
    return false;
  }

  const status = state?.turnStatusBySession?.[targetSessionId] ?? 'idle';
  const realtime = normalizeRealtimeSessionState(state?.realtimeBySession?.[targetSessionId]);
  return status === 'started' || status === 'interrupting' || realtime.status === 'started';
}

function formatTimestamp(value) {
  if (!value) {
    return 'Unknown time';
  }

  const timestamp = value > 1_000_000_000_000 ? value : value * 1000;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

function shouldRefreshSessionAfterEvent(action) {
  return (
    action?.type === 'turn_completed' ||
    action?.type === 'session_runtime_reconciled' ||
    action?.type === 'approval_requested' ||
    action?.type === 'approval_resolved' ||
    action?.type === 'pending_question_requested' ||
    action?.type === 'pending_question_resolved'
  );
}

function shouldAutoScrollConversation(previousState, nextState, action, conversationWindow, documentRef) {
  const autoScrollActionTypes = new Set([
    'user_turn_submitted',
    'turn_started',
    'thread_item_started',
    'thread_item_delta',
    'thread_item_completed',
    'turn_completed',
    'thread_realtime_started',
    'thread_realtime_item_added',
    'thread_realtime_audio_delta',
    'thread_realtime_error',
    'thread_realtime_closed',
  ]);
  if (!autoScrollActionTypes.has(action?.type)) {
    return false;
  }

  const threadId = action?.payload?.threadId ?? action?.payload?.thread?.id ?? null;
  if (!threadId || nextState?.selectedSessionId !== threadId) {
    return false;
  }

  if (conversationWindow && conversationWindow.hiddenAfterCount > 0) {
    return false;
  }

  if (action.type === 'user_turn_submitted' || action.type === 'turn_started') {
    return true;
  }

  return (
    previousState?.selectedSessionId === threadId &&
    isConversationNearBottom(documentRef)
  );
}

function maybeAutoScrollConversation(documentRef, previousState, nextState, action, conversationWindow = null) {
  if (!shouldAutoScrollConversation(previousState, nextState, action, conversationWindow, documentRef)) {
    return null;
  }

  return scrollConversationToBottom(documentRef);
}

function keepSelectedSession(projects, selectedSessionId) {
  if (!selectedSessionId) {
    return null;
  }

  const allFocusedSessions = projects.flatMap((project) => project.focusedSessions ?? []);
  return allFocusedSessions.some((session) => session.id === selectedSessionId)
    ? selectedSessionId
    : null;
}

function keepDialogProject(projects, projectId) {
  if (!projectId) {
    return null;
  }

  return projects.some((project) => (project.id ?? project.cwd ?? '__unknown__') === projectId)
    ? projectId
    : null;
}

function keepPendingProject(projects, projectId) {
  if (!projectId) {
    return null;
  }

  return projects.some((project) => (project.id ?? project.cwd ?? '__unknown__') === projectId)
    ? projectId
    : null;
}

function normalizeSubagentDialogSelection(selection) {
  if (!selection || typeof selection !== 'object') {
    return null;
  }

  const threadId = String(selection.threadId ?? '').trim();
  const turnId = String(selection.turnId ?? '').trim();
  const itemId = String(selection.itemId ?? '').trim();

  if (!threadId || !turnId || !itemId) {
    return null;
  }

  return { threadId, turnId, itemId };
}

function findTurnById(thread, turnId) {
  if (!thread?.turns?.length || !turnId) {
    return null;
  }

  return thread.turns.find((turn) => turn?.id === turnId) ?? null;
}

function findTurnItemById(turn, itemId) {
  if (!turn?.items?.length || !itemId) {
    return null;
  }

  return turn.items.find((item) => item?.id === itemId) ?? null;
}

function getSelectedSubagentDialogItem(state) {
  const selection = state?.subagentDialog;
  if (!selection) {
    return null;
  }

  const thread = state.sessionDetailsById?.[selection.threadId];
  const turn = findTurnById(thread, selection.turnId);
  if (!turn) {
    return null;
  }

  return findTurnItemById(turn, selection.itemId);
}

function filterSessionCountMap(projects, counts) {
  const allowedIds = new Set();
  for (const project of projects ?? []) {
    for (const session of project.focusedSessions ?? []) {
      if (session?.id) {
        allowedIds.add(session.id);
      }
    }
  }

  return Object.fromEntries(
    Object.entries(counts ?? {}).filter(([sessionId, count]) => allowedIds.has(sessionId) && Number(count) > 0),
  );
}

function firstNonEmptyText(...values) {
  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (normalized) {
      return normalized;
    }
  }

  return '';
}

function omitObjectKeys(value, keysToSkip) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const skippedKeys = new Set(keysToSkip);
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !skippedKeys.has(key)),
  );
}

function clearSessionUnread(unreadBySession, threadId) {
  if (!threadId || !unreadBySession?.[threadId]) {
    return unreadBySession ?? {};
  }

  return {
    ...unreadBySession,
    [threadId]: 0,
  };
}

function markSessionUnreadIfBackground(state, threadId) {
  if (!threadId || threadId === state.selectedSessionId) {
    return state;
  }

  return {
    ...state,
    unreadBySession: {
      ...state.unreadBySession,
      [threadId]: 1,
    },
  };
}

function updateProject(projects, projectId, updater) {
  return projects.map((project) => {
    const currentProjectId = project.id ?? project.cwd ?? '__unknown__';
    if (currentProjectId !== projectId) {
      return project;
    }

    return updater(project);
  });
}

function findProject(projects, projectId) {
  return projects.find((project) => (project.id ?? project.cwd ?? '__unknown__') === projectId);
}

function syncThreadIntoProjects(projects, thread) {
  if (!thread?.id) {
    return projects;
  }

  return projects.map((project) => {
    const active = syncThreadMetaList(project.historySessions?.active ?? [], thread);
    const archived = syncThreadMetaList(project.historySessions?.archived ?? [], thread);
    const focusedSessions = syncThreadMetaList(project.focusedSessions ?? [], thread);
    return {
      ...project,
      focusedSessions,
      historySessions: {
        active,
        archived,
      },
    };
  });
}

function syncThreadMetaList(sessions, thread) {
  return sessions.map((session) => {
    if (session?.id !== thread.id) {
      return session;
    }

    return mergeThreadMeta(session, thread);
  });
}

function mergeThreadMeta(session, thread) {
  const pendingApprovals =
    thread.pendingApprovals != null
      ? normalizePendingApprovals(thread.pendingApprovals)
      : normalizePendingApprovals(session.pendingApprovals);
  const derivedPendingApprovalCount =
    thread.pendingApprovals != null || session.pendingApprovals != null
      ? pendingApprovals.length
      : 0;
  const pendingApprovalCount = Number(
    thread.pendingApprovalCount ??
      session.pendingApprovalCount ??
      derivedPendingApprovalCount ??
      0,
  );
  const waitingOnApproval =
    typeof thread.waitingOnApproval === 'boolean'
      ? thread.waitingOnApproval
      : pendingApprovalCount > 0 || Boolean(session.waitingOnApproval);
  const pendingQuestions =
    thread.pendingQuestions != null
      ? normalizePendingQuestions(thread.pendingQuestions)
      : normalizePendingQuestions(session.pendingQuestions);
  const derivedPendingQuestionCount =
    thread.pendingQuestions != null || session.pendingQuestions != null
      ? pendingQuestions.length
      : 0;
  const pendingQuestionCount = Number(
    thread.pendingQuestionCount ??
      session.pendingQuestionCount ??
      derivedPendingQuestionCount ??
      0,
  );
  const waitingOnQuestion =
    typeof thread.waitingOnQuestion === 'boolean'
      ? thread.waitingOnQuestion
      : pendingQuestionCount > 0 || Boolean(session.waitingOnQuestion);
  const external = normalizeExternalSession(thread.external) ?? normalizeExternalSession(session.external);

  return {
    ...session,
    name: preferThreadText(thread.name, session.name),
    preview: preferThreadText(thread.preview, session.preview),
    cwd: thread.cwd ?? session.cwd ?? null,
    updatedAt: thread.updatedAt ?? session.updatedAt ?? null,
    status: thread.status ?? session.status ?? null,
    runtime: thread.runtime ?? session.runtime ?? null,
    pendingApprovalCount,
    waitingOnApproval,
    pendingApprovals,
    pendingQuestionCount,
    waitingOnQuestion,
    pendingQuestions,
    ...(external ? { external } : {}),
  };
}

function applyApprovalUpdate(state, approval, mode) {
  const normalizedApproval = normalizeApprovalEntry(approval);
  if (!normalizedApproval?.threadId) {
    return state;
  }

  return {
    ...state,
    projects: updateApprovalInProjects(state.projects, normalizedApproval, mode),
    sessionDetailsById: updateApprovalInSessionDetails(
      state.sessionDetailsById,
      normalizedApproval,
      mode,
    ),
  };
}

function applyPendingQuestionUpdate(state, question, mode) {
  const normalizedQuestion = normalizePendingQuestionEntry(question);
  if (!normalizedQuestion?.threadId) {
    return state;
  }

  return {
    ...state,
    projects: updatePendingQuestionInProjects(state.projects, normalizedQuestion, mode),
    sessionDetailsById: updatePendingQuestionInSessionDetails(
      state.sessionDetailsById,
      normalizedQuestion,
      mode,
    ),
  };
}

function updateApprovalInProjects(projects, approval, mode) {
  return (projects ?? []).map((project) => ({
    ...project,
    focusedSessions: updateApprovalInThreadList(project.focusedSessions ?? [], approval, mode),
    historySessions: {
      active: updateApprovalInThreadList(project.historySessions?.active ?? [], approval, mode),
      archived: updateApprovalInThreadList(project.historySessions?.archived ?? [], approval, mode),
    },
  }));
}

function updateApprovalInThreadList(threads, approval, mode) {
  return (threads ?? []).map((thread) => {
    if (thread?.id !== approval.threadId) {
      return thread;
    }

    return applyApprovalToThread(thread, approval, mode);
  });
}

function updateApprovalInSessionDetails(sessionDetailsById, approval, mode) {
  const thread = sessionDetailsById?.[approval.threadId];
  if (!thread) {
    return sessionDetailsById;
  }

  return {
    ...sessionDetailsById,
    [approval.threadId]: applyApprovalToThread(thread, approval, mode),
  };
}

function updatePendingQuestionInProjects(projects, question, mode) {
  return (projects ?? []).map((project) => ({
    ...project,
    focusedSessions: updatePendingQuestionInThreadList(project.focusedSessions ?? [], question, mode),
    historySessions: {
      active: updatePendingQuestionInThreadList(project.historySessions?.active ?? [], question, mode),
      archived: updatePendingQuestionInThreadList(project.historySessions?.archived ?? [], question, mode),
    },
  }));
}

function updatePendingQuestionInThreadList(threads, question, mode) {
  return (threads ?? []).map((thread) => {
    if (thread?.id !== question.threadId) {
      return thread;
    }

    return applyPendingQuestionToThread(thread, question, mode);
  });
}

function updatePendingQuestionInSessionDetails(sessionDetailsById, question, mode) {
  const thread = sessionDetailsById?.[question.threadId];
  if (!thread) {
    return sessionDetailsById;
  }

  return {
    ...sessionDetailsById,
    [question.threadId]: applyPendingQuestionToThread(thread, question, mode),
  };
}

function applyApprovalToThread(thread, approval, mode) {
  const approvals = normalizePendingApprovals(thread?.pendingApprovals);
  let nextApprovals = approvals;

  if (mode === 'requested') {
    nextApprovals = upsertApproval(approvals, approval);
  } else if (mode === 'resolved') {
    nextApprovals = approvals.filter((entry) => entry.id !== approval.id);
  }

  return {
    ...thread,
    pendingApprovals: nextApprovals,
    pendingApprovalCount: nextApprovals.length,
    waitingOnApproval: nextApprovals.length > 0,
  };
}

function applyPendingQuestionToThread(thread, question, mode) {
  const questions = normalizePendingQuestions(thread?.pendingQuestions);
  let nextQuestions = questions;

  if (mode === 'requested') {
    nextQuestions = upsertPendingQuestion(questions, question);
  } else if (mode === 'resolved') {
    nextQuestions = questions.filter((entry) => entry.id !== question.id);
  }

  return {
    ...thread,
    pendingQuestions: nextQuestions,
    pendingQuestionCount: nextQuestions.length,
    waitingOnQuestion: nextQuestions.length > 0,
  };
}

function upsertApproval(approvals, approval) {
  const nextApprovals = [...approvals];
  const index = nextApprovals.findIndex((entry) => entry.id === approval.id);
  if (index === -1) {
    nextApprovals.push(approval);
  } else {
    nextApprovals[index] = approval;
  }

  return nextApprovals;
}

function upsertPendingQuestion(questions, question) {
  const nextQuestions = [...questions];
  const index = nextQuestions.findIndex((entry) => entry.id === question.id);
  if (index === -1) {
    nextQuestions.push(question);
  } else {
    nextQuestions[index] = question;
  }

  return nextQuestions;
}

function updateThreadNameInProjects(projects, threadId, name) {
  return projects.map((project) => ({
    ...project,
    focusedSessions: updateThreadNameInMetaList(project.focusedSessions ?? [], threadId, name),
    historySessions: {
      active: updateThreadNameInMetaList(project.historySessions?.active ?? [], threadId, name),
      archived: updateThreadNameInMetaList(project.historySessions?.archived ?? [], threadId, name),
    },
  }));
}

function updateThreadNameInMetaList(sessions, threadId, name) {
  return sessions.map((session) => {
    if (session?.id !== threadId) {
      return session;
    }

    return {
      ...session,
      name,
    };
  });
}

function updateThreadNameInSessionDetails(sessionDetailsById, threadId, name) {
  const detail = sessionDetailsById?.[threadId];
  if (!detail) {
    return sessionDetailsById;
  }

  return {
    ...sessionDetailsById,
    [threadId]: {
      ...detail,
      name,
    },
  };
}

function preferThreadText(primary, fallback) {
  if (typeof primary === 'string' && primary.trim()) {
    return primary;
  }

  return fallback ?? primary ?? null;
}

function getThreadTitle(session) {
  if (!session) {
    return null;
  }

  return [session.name, session.preview, session.id].find((value) => {
    if (typeof value === 'string') {
      return value.trim().length > 0;
    }

    return Boolean(value);
  });
}

function getThreadSubtitle(session) {
  if (!session) {
    return '打开后可查看完整历史';
  }

  const title = getThreadTitle(session);
  for (const candidate of [session.preview, session.cwd, session.id]) {
    if (typeof candidate !== 'string') {
      continue;
    }

    const normalized = candidate.trim();
    if (!normalized || normalized === title) {
      continue;
    }

    return normalized;
  }

  return '打开后可查看完整历史';
}

function resolveSelectedSessionTitle(state, detail) {
  if (detail) {
    return getThreadTitle(detail) ?? '';
  }

  if (state.pendingSessionProjectId) {
    return '新会话';
  }

  const selectedMeta = findThreadMeta(state.projects ?? [], state.selectedSessionId);
  return getThreadTitle(selectedMeta) ?? '';
}

function getPendingSessionProject(state) {
  return findProject(state.projects ?? [], state.pendingSessionProjectId);
}

function findThreadMeta(projects, threadId) {
  for (const project of projects ?? []) {
    for (const session of [
      ...(project.focusedSessions ?? []),
      ...(project.historySessions?.active ?? []),
      ...(project.historySessions?.archived ?? []),
    ]) {
      if (session?.id === threadId) {
        return session;
      }
    }
  }

  return null;
}

function extractLatestTurnPlan(session) {
  const turns = [...(session?.turns ?? [])];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const turnPlan = normalizeTurnPlan(turn?.plan);
    if (turnPlan) {
      return turnPlan;
    }

    const itemPlan = extractTurnPlanFromItems(turn?.items ?? []);
    if (itemPlan) {
      return itemPlan;
    }
  }

  return null;
}

function extractTurnPlanFromItems(items) {
  const plans = (items ?? []).filter((item) => item?.type === 'plan');
  for (let index = plans.length - 1; index >= 0; index -= 1) {
    const normalized = normalizeTurnPlan(plans[index]);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function normalizeTurnPlan(plan) {
  if (!plan || typeof plan !== 'object') {
    return null;
  }

  const explanation = firstNonEmptyText(plan.explanation);
  const text = firstNonEmptyText(plan.text);
  const stepSource = Array.isArray(plan.steps)
    ? plan.steps
    : Array.isArray(plan.plan)
      ? plan.plan
      : [];
  const steps = stepSource
    .map((step) => normalizePlanStep(step))
    .filter(Boolean);

  if (!explanation && !text && !steps.length) {
    return null;
  }

  return {
    explanation: explanation || null,
    text: text || '',
    steps,
  };
}

function mergeTurnPlan(currentPlan, payload) {
  const current = normalizeTurnPlan(currentPlan) ?? { explanation: null, text: '', steps: [] };
  const next = normalizeTurnPlan({
    explanation: payload?.explanation ?? current.explanation,
    text: payload?.text ?? current.text,
    steps: Array.isArray(payload?.plan) ? payload.plan : current.steps,
  });
  return next ?? current;
}

function normalizePlanStep(step) {
  if (!step || typeof step !== 'object') {
    return null;
  }

  const text = firstNonEmptyText(step.step, step.text, step.title);
  if (!text) {
    return null;
  }

  return {
    step: text,
    status: normalizePlanStepStatus(step.status),
  };
}

function normalizePlanStepStatus(status) {
  if (status === 'completed' || status === 'inProgress') {
    return status;
  }

  return 'pending';
}

function formatPlanStepStatus(status) {
  switch (normalizePlanStepStatus(status)) {
    case 'completed':
      return '已完成';
    case 'inProgress':
      return '进行中';
    default:
      return '待处理';
  }
}

function getPlanStepTone(status) {
  switch (normalizePlanStepStatus(status)) {
    case 'completed':
      return 'completed';
    case 'inProgress':
      return 'running';
    default:
      return 'pending';
  }
}

function normalizeThreadDetail(thread) {
  const pendingQuestions = normalizePendingQuestions(thread?.pendingQuestions);
  const pendingQuestionCount = Number(
    thread?.pendingQuestionCount ?? thread?.pendingQuestions?.length ?? 0,
  );
  const external = normalizeExternalSession(thread?.external);
  return {
    ...thread,
    ...(external ? { external } : {}),
    pendingApprovalCount: Number(
      thread?.pendingApprovalCount ?? thread?.pendingApprovals?.length ?? 0,
    ),
    waitingOnApproval: Boolean(
      thread?.waitingOnApproval ??
        Number(thread?.pendingApprovalCount ?? thread?.pendingApprovals?.length ?? 0) > 0,
    ),
    pendingApprovals: normalizePendingApprovals(thread?.pendingApprovals),
    pendingQuestionCount,
    waitingOnQuestion: Boolean(thread?.waitingOnQuestion ?? pendingQuestionCount > 0),
    pendingQuestions,
    turns: (thread?.turns ?? []).map((turn) => ({
      id: turn.id,
      status: turn.status ?? 'unknown',
      error: turn.error ?? null,
      plan: normalizeTurnPlan(turn.plan) ?? extractTurnPlanFromItems(turn.items ?? []),
      items: (turn.items ?? []).map((item) => normalizeStreamedItem(item, { preserveStreaming: true })),
    })),
  };
}

function normalizePendingApprovals(approvals) {
  return (approvals ?? []).map((approval) => normalizeApprovalEntry(approval));
}

function normalizeExternalSession(external) {
  if (!external || typeof external !== 'object') {
    return null;
  }

  const bridgeMode = normalizeExternalBridgeMode(external.bridgeMode);
  const runtimeSource = firstNonEmptyText(external.runtimeSource);
  const transcriptPath = firstNonEmptyText(external.transcriptPath);
  const lastSeenAt = normalizePositiveInteger(external.lastSeenAt);

  if (!bridgeMode && !runtimeSource && !transcriptPath && !lastSeenAt) {
    return null;
  }

  return {
    ...(bridgeMode ? { bridgeMode } : {}),
    ...(runtimeSource ? { runtimeSource } : {}),
    ...(transcriptPath ? { transcriptPath } : {}),
    ...(lastSeenAt ? { lastSeenAt } : {}),
  };
}

function normalizeExternalBridgeMode(value) {
  const normalized = firstNonEmptyText(value);
  if (normalized === 'discovered' || normalized === 'hooked' || normalized === 'hooked+tail') {
    return normalized;
  }

  return null;
}

function normalizePositiveInteger(value) {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

function normalizePendingQuestions(questions) {
  return (questions ?? []).map((question) => normalizePendingQuestionEntry(question));
}

function normalizeApprovalEntry(approval) {
  if (!approval) {
    return approval;
  }

  return {
    ...approval,
    summary: approval.summary ?? '',
    detail:
      approval.detail && typeof approval.detail === 'object' && !Array.isArray(approval.detail)
        ? { ...approval.detail }
        : {},
    status: approval.status ?? 'pending',
  };
}

function normalizePendingQuestionEntry(question) {
  if (!question) {
    return question;
  }

  return {
    ...question,
    summary: question.summary ?? '',
    prompt: question.prompt ?? question.summary ?? '',
    questions: Array.isArray(question.questions) ? [...question.questions] : [],
    response:
      question.response && typeof question.response === 'object'
        ? { ...question.response }
        : question.response ?? null,
    status: question.status ?? 'pending',
  };
}

function collectProjectRuntimeState(projects) {
  const runtimeState = {
    turnStatusBySession: {},
    activeTurnIdBySession: {},
    diffBySession: {},
    realtimeBySession: {},
  };

  for (const project of projects ?? []) {
    for (const thread of [
      ...(project.focusedSessions ?? []),
      ...(project.historySessions?.active ?? []),
      ...(project.historySessions?.archived ?? []),
    ]) {
      collectThreadRuntimeState(runtimeState, thread);
    }
  }

  return runtimeState;
}

function collectProjectSessionSettings(projects) {
  const settingsBySession = {};

  for (const project of projects ?? []) {
    for (const thread of [
      ...(project.focusedSessions ?? []),
      ...(project.historySessions?.active ?? []),
      ...(project.historySessions?.archived ?? []),
    ]) {
      if (!thread?.id) {
        continue;
      }

      settingsBySession[thread.id] = normalizeSessionSettings(thread.settings);
    }
  }

  return settingsBySession;
}

function collectThreadRuntimeState(runtimeState, thread) {
  if (!thread?.id) {
    return runtimeState;
  }

  const normalizedRuntime = normalizeThreadRuntime(thread.runtime);
  runtimeState.turnStatusBySession[thread.id] = normalizedRuntime.turnStatus;

  if (normalizedRuntime.activeTurnId) {
    runtimeState.activeTurnIdBySession[thread.id] = normalizedRuntime.activeTurnId;
  }

  if (normalizedRuntime.diff) {
    runtimeState.diffBySession[thread.id] = normalizedRuntime.diff;
  }

  if (hasRealtimeSessionData(normalizedRuntime.realtime)) {
    runtimeState.realtimeBySession[thread.id] = normalizedRuntime.realtime;
  }

  return runtimeState;
}

function replaceSessionRuntimeState(state, thread) {
  if (!thread?.id) {
    return state;
  }

  const normalizedRuntime = normalizeThreadRuntime(thread.runtime);
  const nextActiveTurnIdBySession = {
    ...state.activeTurnIdBySession,
  };
  const nextDiffBySession = {
    ...state.diffBySession,
  };
  const nextRealtimeBySession = {
    ...state.realtimeBySession,
  };

  if (normalizedRuntime.activeTurnId) {
    nextActiveTurnIdBySession[thread.id] = normalizedRuntime.activeTurnId;
  } else {
    delete nextActiveTurnIdBySession[thread.id];
  }

  if (normalizedRuntime.diff) {
    nextDiffBySession[thread.id] = normalizedRuntime.diff;
  } else {
    delete nextDiffBySession[thread.id];
  }

  if (hasRealtimeSessionData(normalizedRuntime.realtime)) {
    nextRealtimeBySession[thread.id] = normalizedRuntime.realtime;
  } else {
    delete nextRealtimeBySession[thread.id];
  }

  return {
    ...state,
    turnStatusBySession: {
      ...state.turnStatusBySession,
      [thread.id]: normalizedRuntime.turnStatus,
    },
    activeTurnIdBySession: nextActiveTurnIdBySession,
    diffBySession: nextDiffBySession,
    realtimeBySession: nextRealtimeBySession,
  };
}

function applyRuntimeSnapshotToState(state, threadId, runtime) {
  const normalizedRuntime = normalizeThreadRuntime(runtime);
  const nextActiveTurnIdBySession = {
    ...state.activeTurnIdBySession,
  };
  const nextDiffBySession = {
    ...state.diffBySession,
  };
  const nextRealtimeBySession = {
    ...state.realtimeBySession,
  };

  if (normalizedRuntime.activeTurnId) {
    nextActiveTurnIdBySession[threadId] = normalizedRuntime.activeTurnId;
  } else {
    delete nextActiveTurnIdBySession[threadId];
  }

  if (normalizedRuntime.diff) {
    nextDiffBySession[threadId] = normalizedRuntime.diff;
  } else {
    delete nextDiffBySession[threadId];
  }

  if (hasRealtimeSessionData(normalizedRuntime.realtime)) {
    nextRealtimeBySession[threadId] = normalizedRuntime.realtime;
  } else {
    delete nextRealtimeBySession[threadId];
  }

  return {
    ...state,
    turnStatusBySession: {
      ...state.turnStatusBySession,
      [threadId]: normalizedRuntime.turnStatus,
    },
    activeTurnIdBySession: nextActiveTurnIdBySession,
    diffBySession: nextDiffBySession,
    realtimeBySession: nextRealtimeBySession,
  };
}

function normalizeThreadRuntime(runtime) {
  return {
    turnStatus: runtime?.turnStatus ?? 'idle',
    activeTurnId: runtime?.activeTurnId ?? null,
    diff: runtime?.diff ?? null,
    realtime: normalizeRealtimeSessionState(runtime?.realtime),
  };
}

function createRealtimeSessionState(overrides = {}) {
  return {
    status: 'idle',
    sessionId: null,
    items: [],
    audioChunkCount: 0,
    audioByteCount: 0,
    lastAudio: null,
    lastError: null,
    closeReason: null,
    ...overrides,
  };
}

function normalizeRealtimeSessionState(realtime) {
  if (!realtime) {
    return createRealtimeSessionState();
  }

  return createRealtimeSessionState({
    ...realtime,
    items: (realtime.items ?? []).map((item, index) => ({
      index: item.index ?? index + 1,
      summary: item.summary ?? summarizeRealtimeItem(item.value),
      value: item.value,
    })),
    audioChunkCount: Number(realtime.audioChunkCount ?? 0),
    audioByteCount: Number(realtime.audioByteCount ?? 0),
    lastAudio: realtime.lastAudio
      ? {
          sampleRate: realtime.lastAudio.sampleRate ?? null,
          numChannels: realtime.lastAudio.numChannels ?? null,
          samplesPerChannel: realtime.lastAudio.samplesPerChannel ?? null,
        }
      : null,
  });
}

function updateSessionRealtime(state, threadId, updater) {
  const currentRealtime = normalizeRealtimeSessionState(state.realtimeBySession[threadId]);
  return {
    ...state,
    realtimeBySession: {
      ...state.realtimeBySession,
      [threadId]: normalizeRealtimeSessionState(updater(currentRealtime)),
    },
  };
}

function createRealtimeItemEntry(index, value) {
  return {
    index,
    summary: summarizeRealtimeItem(value),
    value,
  };
}

function summarizeRealtimeItem(value) {
  if (value == null) {
    return 'unknown';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return `array(${value.length})`;
  }

  if (typeof value === 'object') {
    if (typeof value.type === 'string' && value.type.trim()) {
      return value.type;
    }

    if (typeof value.event === 'string' && value.event.trim()) {
      return value.event;
    }
  }

  return typeof value;
}

function hasRealtimeSessionData(realtime) {
  return Boolean(
    realtime.sessionId ||
      realtime.items.length ||
      realtime.audioChunkCount > 0 ||
      realtime.lastError ||
      realtime.closeReason ||
      realtime.status !== 'idle',
  );
}

function formatRealtimeAudioSummary(realtime) {
  const parts = [`${realtime.audioChunkCount} chunks`];
  if (realtime.lastAudio?.sampleRate) {
    parts.push(`${realtime.lastAudio.sampleRate} Hz`);
  }
  if (realtime.lastAudio?.numChannels) {
    parts.push(`${realtime.lastAudio.numChannels} ch`);
  }
  return parts.join(' · ');
}

function updateSessionThread(state, threadId, updater) {
  const currentThread =
    state.sessionDetailsById[threadId] ??
    createThreadDetailSkeleton(findThreadMeta(state.projects, threadId) ?? { id: threadId });

  if (!currentThread?.id) {
    return state;
  }

  const nextThread = normalizeThreadDetail(updater(currentThread));
  return {
    ...state,
    projects: syncThreadIntoProjects(state.projects, nextThread),
    sessionDetailsById: {
      ...state.sessionDetailsById,
      [threadId]: nextThread,
    },
  };
}

function createThreadDetailSkeleton(thread) {
  return {
    id: thread.id,
    name: thread.name ?? thread.preview ?? thread.id,
    preview: thread.preview ?? '',
    cwd: thread.cwd ?? null,
    createdAt: thread.createdAt ?? null,
    updatedAt: thread.updatedAt ?? null,
    status: thread.status ?? { type: 'loaded' },
    turns: thread.turns ?? [],
  };
}

function upsertThreadTurn(thread, turnId, updater) {
  const turns = [...(thread.turns ?? [])];
  const turnIndex = turns.findIndex((turn) => turn.id === turnId);
  const baseTurn =
    turnIndex === -1
      ? { id: turnId, status: 'started', error: null, items: [] }
      : { ...turns[turnIndex], items: [...(turns[turnIndex].items ?? [])] };
  const nextTurn = updater(baseTurn);

  if (turnIndex === -1) {
    turns.push(nextTurn);
  } else {
    turns[turnIndex] = nextTurn;
  }

  return {
    ...thread,
    updatedAt: Math.floor(Date.now() / 1000),
    turns,
  };
}

function upsertTurnItem(items, nextItem, matcher) {
  const nextItems = [...items];
  const itemIndex = nextItems.findIndex((item) => matcher(item));
  if (itemIndex === -1) {
    nextItems.push(nextItem);
    return nextItems;
  }

  nextItems[itemIndex] = {
    ...nextItems[itemIndex],
    ...nextItem,
  };
  return nextItems;
}

function appendItemDelta(items, payload) {
  const { itemId, itemType = 'agentMessage', delta = '' } = payload;
  const nextItems = [...items];
  const itemIndex = nextItems.findIndex((item) => item.id === itemId);
  if (itemIndex === -1) {
    nextItems.push(createDeltaSeedItem({ itemId, itemType, delta }));
    return nextItems;
  }

  nextItems[itemIndex] = mergeItemDelta(nextItems[itemIndex], payload);
  return nextItems;
}

function markTurnItemsSettled(items) {
  return items.map((item) => {
    if (item.type !== 'agentMessage') {
      return item;
    }

    return {
      ...item,
      streaming: false,
    };
  });
}

function normalizeStreamedItem(item, options = {}) {
  if (!item) {
    return item;
  }

  if (item.type === 'agentMessage') {
    return {
      ...item,
      text: item.text ?? '',
      streaming:
        options.preserveStreaming && typeof item.streaming === 'boolean'
          ? item.streaming
          : options.streaming ?? false,
    };
  }

  if (item.type === 'plan') {
    return {
      ...item,
      text: item.text ?? '',
      explanation: firstNonEmptyText(item.explanation) || null,
      steps: (item.steps ?? item.plan ?? [])
        .map((step) => normalizePlanStep(step))
        .filter(Boolean),
    };
  }

  if (item.type === 'reasoning') {
    return {
      ...item,
      summary: [...(item.summary ?? [])],
      content: [...(item.content ?? [])],
    };
  }

  if (item.type === 'commandExecution') {
    return {
      ...item,
      aggregatedOutput: item.aggregatedOutput ?? '',
    };
  }

  if (item.type === 'mcpToolCall') {
    return {
      ...item,
      progressMessages: [...(item.progressMessages ?? [])],
    };
  }

  return {
    ...item,
  };
}

function createDeltaSeedItem({ itemId, itemType, delta }) {
  if (itemType === 'plan') {
    return normalizeStreamedItem({
      type: 'plan',
      id: itemId,
      text: delta ?? '',
      explanation: null,
      steps: [],
    });
  }

  if (itemType === 'reasoning') {
    return normalizeStreamedItem({ type: 'reasoning', id: itemId, summary: [], content: [] });
  }

  if (itemType === 'commandExecution') {
    return normalizeStreamedItem({
      type: 'commandExecution',
      id: itemId,
      command: '',
      cwd: '',
      processId: null,
      status: 'inProgress',
      commandActions: [],
      aggregatedOutput: delta ?? '',
      exitCode: null,
      durationMs: null,
    });
  }

  if (itemType === 'mcpToolCall') {
    return normalizeStreamedItem({
      type: 'mcpToolCall',
      id: itemId,
      server: '',
      tool: '',
      status: 'inProgress',
      arguments: {},
      result: null,
      error: null,
      durationMs: null,
      progressMessages: [],
    });
  }

  return normalizeStreamedItem(
    { type: 'agentMessage', id: itemId, text: delta ?? '', phase: 'commentary' },
    { streaming: true },
  );
}

function mergeItemDelta(item, payload) {
  const { itemType = item.type, deltaKind = null, delta = '', summaryIndex = 0, contentIndex = 0, message = '' } =
    payload;

  if (itemType === 'plan' || item.type === 'plan') {
    const planItem = normalizeStreamedItem(
      item.type === 'plan' ? item : createDeltaSeedItem({ itemId: item.id, itemType: 'plan', delta: '' }),
    );
    return {
      ...planItem,
      type: 'plan',
      text: `${planItem.text ?? ''}${delta}`,
    };
  }

  if (itemType === 'reasoning' || item.type === 'reasoning') {
    const reasoning = normalizeStreamedItem(item.type === 'reasoning' ? item : { type: 'reasoning', id: item.id, summary: [], content: [] });
    if (deltaKind === 'reasoning_summary_part_added') {
      ensureIndexedValue(reasoning.summary, summaryIndex, '');
      return reasoning;
    }

    if (deltaKind === 'reasoning_summary_text') {
      ensureIndexedValue(reasoning.summary, summaryIndex, '');
      reasoning.summary[summaryIndex] = `${reasoning.summary[summaryIndex]}${delta}`;
      return reasoning;
    }

    ensureIndexedValue(reasoning.content, contentIndex, '');
    reasoning.content[contentIndex] = `${reasoning.content[contentIndex]}${delta}`;
    return reasoning;
  }

  if (itemType === 'commandExecution' || item.type === 'commandExecution') {
    return {
      ...normalizeStreamedItem(item.type === 'commandExecution' ? item : createDeltaSeedItem({ itemId: item.id, itemType: 'commandExecution', delta: '' })),
      type: 'commandExecution',
      aggregatedOutput: `${item.aggregatedOutput ?? ''}${delta}`,
      status: item.status ?? 'inProgress',
    };
  }

  if (itemType === 'mcpToolCall' || item.type === 'mcpToolCall') {
    const nextItem = normalizeStreamedItem(item.type === 'mcpToolCall' ? item : createDeltaSeedItem({ itemId: item.id, itemType: 'mcpToolCall', delta: '' }));
    if (deltaKind === 'mcp_progress' && message) {
      nextItem.progressMessages.push(message);
    }
    return nextItem;
  }

  return {
    ...item,
    type: 'agentMessage',
    text: `${item.text ?? ''}${delta}`,
    streaming: true,
  };
}

function ensureIndexedValue(values, index, seed = '') {
  while (values.length <= index) {
    values.push(seed);
  }
}

function clampPanelWidth(width, fallbackWidth) {
  const numericWidth = Number(width);
  if (!Number.isFinite(numericWidth)) {
    return fallbackWidth;
  }

  return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, Math.round(numericWidth)));
}

function normalizeCollabToolCallStatus(status) {
  if (status === 'inProgress') {
    return 'running';
  }

  if (status === 'failed') {
    return 'errored';
  }

  return status ?? 'pendingInit';
}

function formatCollabAgentStatus(status) {
  switch (status) {
    case 'pendingInit':
      return '准备中';
    case 'running':
      return '运行中';
    case 'completed':
      return '已完成';
    case 'interrupted':
      return '已中断';
    case 'errored':
      return '出错';
    case 'shutdown':
      return '已关闭';
    case 'notFound':
      return '未找到';
    default:
      return status ?? '未知';
  }
}

function getCollabAgentTone(status) {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'errored':
    case 'notFound':
      return 'errored';
    case 'interrupted':
    case 'shutdown':
      return 'muted';
    default:
      return 'running';
  }
}

function setupPanelResizer(handle, { side, controller, getState, documentRef }) {
  if (!handle?.addEventListener) {
    return;
  }

  handle.addEventListener('pointerdown', (event) => {
    if (event.button != null && event.button !== 0) {
      return;
    }

    event.preventDefault?.();
    const view = documentRef?.defaultView ?? globalThis;
    const startX = Number(event.clientX ?? 0);
    const startWidth =
      side === 'project' ? getState().projectPanelWidth : getState().activityPanelWidth;

    const onPointerMove = (moveEvent) => {
      const delta = Number(moveEvent.clientX ?? 0) - startX;
      const nextWidth = side === 'project' ? startWidth + delta : startWidth - delta;
      if (side === 'project') {
        controller.setProjectPanelWidth(nextWidth);
        return;
      }

      controller.setActivityPanelWidth(nextWidth);
    };

    const stopResizing = () => {
      view.removeEventListener?.('pointermove', onPointerMove);
      view.removeEventListener?.('pointerup', stopResizing);
      view.removeEventListener?.('pointercancel', stopResizing);
    };

    view.addEventListener?.('pointermove', onPointerMove);
    view.addEventListener?.('pointerup', stopResizing);
    view.addEventListener?.('pointercancel', stopResizing);
  });
}

export function findConversationTurnTarget(turnOffsets, currentScrollTop, direction) {
  if (!Array.isArray(turnOffsets) || !turnOffsets.length) {
    return null;
  }

  const sortedOffsets = [...turnOffsets]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);

  if (!sortedOffsets.length) {
    return null;
  }

  if (direction === 'previous') {
    for (let index = sortedOffsets.length - 1; index >= 0; index -= 1) {
      if (sortedOffsets[index] <= currentScrollTop) {
        return sortedOffsets[index];
      }
    }

    return sortedOffsets[0];
  }

  for (const offset of sortedOffsets) {
    if (offset > currentScrollTop) {
      return offset;
    }
  }

  return sortedOffsets.at(-1) ?? null;
}

function normalizeHistoryDialogTab(tab) {
  return tab === 'archived' ? 'archived' : 'active';
}

function normalizeMobileDrawerMode(mode) {
  return mode === 'activity' ? 'activity' : 'sessions';
}

function isMobileViewport(documentRef) {
  const view = documentRef?.defaultView ?? globalThis;
  if (typeof view?.matchMedia === 'function') {
    return Boolean(view.matchMedia('(max-width: 760px)').matches);
  }

  return Number(view?.innerWidth ?? 0) > 0 && Number(view.innerWidth) <= 760;
}

function jumpConversationByTurn(documentRef, direction) {
  const conversationScroll = documentRef?.querySelector?.('#conversation-scroll');
  if (!conversationScroll) {
    return null;
  }

  const turnOffsets = getConversationTurnOffsets(documentRef);
  const target = findConversationTurnTarget(turnOffsets, conversationScroll.scrollTop, direction);
  if (target == null) {
    return null;
  }

  setConversationScrollTop(conversationScroll, target);
  return target;
}

function jumpConversationToTurnIndex(documentRef, turnIndex) {
  const conversationScroll = documentRef?.querySelector?.('#conversation-scroll');
  if (!conversationScroll) {
    return null;
  }

  const turnCards = documentRef
    ?.querySelector?.('#conversation-body')
    ?.querySelectorAll?.('[data-turn-card]');
  const turnCard = [...(turnCards ?? [])][turnIndex];
  if (!turnCard) {
    return null;
  }

  const target = Number(turnCard.offsetTop ?? 0);
  setConversationScrollTop(conversationScroll, target);
  return target;
}

function scrollConversationToBottom(documentRef) {
  const conversationScroll = documentRef?.querySelector?.('#conversation-scroll');
  if (!conversationScroll) {
    return null;
  }

  const target = Number(conversationScroll.scrollHeight ?? conversationScroll.scrollTop ?? 0);
  setConversationScrollTop(conversationScroll, target);
  return target;
}

function scrollConversationToTop(documentRef) {
  const conversationScroll = documentRef?.querySelector?.('#conversation-scroll');
  if (!conversationScroll) {
    return null;
  }

  setConversationScrollTop(conversationScroll, 0);
  return 0;
}

function getConversationTurnOffsets(documentRef) {
  const turnCards = documentRef
    ?.querySelector?.('#conversation-body')
    ?.querySelectorAll?.('[data-turn-card]');
  return [...(turnCards ?? [])].map((card) => Number(card.offsetTop ?? 0));
}

function setConversationScrollTop(element, top, { smooth = true } = {}) {
  if (typeof element.scrollTo === 'function') {
    element.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
  }

  element.scrollTop = top;
}

function isConversationNearBottom(documentRef, thresholdPx = CONVERSATION_AUTO_SCROLL_BOTTOM_THRESHOLD_PX) {
  const conversationScroll = documentRef?.querySelector?.('#conversation-scroll');
  if (!conversationScroll) {
    return true;
  }

  if (Number(conversationScroll.clientHeight ?? 0) <= 0) {
    return true;
  }

  const remainingDistance =
    Number(conversationScroll.scrollHeight ?? 0) -
    Number(conversationScroll.clientHeight ?? 0) -
    Number(conversationScroll.scrollTop ?? 0);
  return remainingDistance <= thresholdPx;
}

function requestAnimationFrameSafe(view, callback) {
  if (typeof view?.requestAnimationFrame === 'function') {
    return view.requestAnimationFrame(callback);
  }

  return setTimeout(callback, 0);
}

function createMarkupCache() {
  return {
    keyParts: null,
    html: '',
  };
}

function getCachedMarkup(cache, keyParts, renderMarkup) {
  if (sameMarkupCacheKey(cache.keyParts, keyParts)) {
    return {
      html: cache.html,
      changed: false,
    };
  }

  cache.keyParts = keyParts;
  cache.html = renderMarkup();
  return {
    html: cache.html,
    changed: true,
  };
}

function sameMarkupCacheKey(previousKeyParts, nextKeyParts) {
  if (!Array.isArray(previousKeyParts) || previousKeyParts.length !== nextKeyParts.length) {
    return false;
  }

  return nextKeyParts.every((value, index) => previousKeyParts[index] === value);
}

function openDialog(dialog) {
  if (!dialog) {
    return;
  }

  if (typeof dialog.showModal === 'function' && !dialog.open) {
    dialog.showModal();
    return;
  }

  dialog.open = true;
}

function closeDialog(dialog) {
  if (!dialog) {
    return;
  }

  if (typeof dialog.close === 'function' && dialog.open) {
    dialog.close();
    return;
  }

  dialog.open = false;
}

function restorePersistentState(baseState, storageImpl) {
  const storedPreference = readStoredPanelPreference(storageImpl);
  if (!storedPreference) {
    return { ...baseState };
  }

  return {
    ...baseState,
    persistPanelPreference: true,
    projectPanelCollapsed: storedPreference.projectPanelCollapsed,
    activityPanelCollapsed: storedPreference.activityPanelCollapsed,
  };
}

function syncStoredPanelPreference(storageImpl, state) {
  if (!storageImpl?.setItem || !storageImpl?.removeItem) {
    return;
  }

  try {
    storageImpl.setItem(
      PANEL_PREFERENCE_STORAGE_KEY,
      JSON.stringify({
        projectPanelCollapsed: state.projectPanelCollapsed,
        activityPanelCollapsed: state.activityPanelCollapsed,
      }),
    );
  } catch {}
}

function readStoredPanelPreference(storageImpl) {
  if (!storageImpl?.getItem) {
    return null;
  }

  try {
    const raw = storageImpl.getItem(PANEL_PREFERENCE_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    return {
      persistPanelPreference: true,
      projectPanelCollapsed: Boolean(parsed?.projectPanelCollapsed),
      activityPanelCollapsed: Boolean(parsed?.activityPanelCollapsed),
    };
  } catch {
    return null;
  }
}

function focusProjectInput(documentRef) {
  documentRef?.querySelector?.('#project-dialog-input')?.focus?.();
}

function clearProjectInput(documentRef) {
  const input = documentRef?.querySelector?.('#project-dialog-input');
  if (input) {
    input.value = '';
  }
}

function clearLoginPassword(documentRef) {
  const input = documentRef?.querySelector?.('#login-password');
  if (input) {
    input.value = '';
  }
}

function setRenameDialogSession(documentRef, session) {
  const title = documentRef?.querySelector?.('#rename-dialog-session-title');
  if (title) {
    title.textContent = getThreadTitle(session) ?? session?.id ?? '当前会话';
  }

  const input = documentRef?.querySelector?.('#rename-dialog-input');
  if (input) {
    input.value = session?.name ?? getThreadTitle(session) ?? '';
  }
}

function focusRenameInput(documentRef) {
  const input = documentRef?.querySelector?.('#rename-dialog-input');
  input?.focus?.();
  input?.select?.();
}

function clearRenameInput(documentRef) {
  const input = documentRef?.querySelector?.('#rename-dialog-input');
  if (input) {
    input.value = '';
  }
}

function createInitialAuthState() {
  return {
    required: false,
    authenticated: true,
    checking: false,
    pending: false,
    error: null,
  };
}

function normalizeAuthState(auth) {
  const initialAuth = createInitialAuthState();
  const required = Boolean(auth?.required);
  return {
    ...initialAuth,
    ...(auth ?? {}),
    required,
    authenticated: auth?.authenticated == null ? !required : Boolean(auth?.authenticated),
    checking: Boolean(auth?.checking),
    pending: Boolean(auth?.pending),
    error: auth?.error ?? null,
  };
}

function applyAuthState(state, auth) {
  const nextAuth = normalizeAuthState(auth);
  const nextState = {
    ...state,
    auth: nextAuth,
  };

  if (nextAuth.authenticated) {
    return nextState;
  }

  return {
    ...nextState,
    projects: [],
    selectedSessionId: null,
    pendingSessionProjectId: null,
    sessionDetailsById: {},
    realtimeBySession: {},
    diffBySession: {},
    turnStatusBySession: {},
    activeTurnIdBySession: {},
    unreadBySession: {},
    composerDraft: '',
    historyDialogProjectId: null,
    historyDialogTab: 'active',
    mobileDrawerOpen: false,
    mobileDrawerMode: 'sessions',
    loadError: null,
  };
}

function isAuthenticatedAppState(state) {
  return normalizeAuthState(state?.auth).authenticated;
}

function createInitialSystemStatus() {
  return {
    overall: 'connected',
    relay: { status: 'online' },
    backend: { status: 'connected' },
    requests: { status: 'idle' },
    lastError: null,
  };
}

function normalizeSystemStatus(status) {
  return {
    ...createInitialSystemStatus(),
    ...(status ?? {}),
    relay: {
      status: status?.relay?.status ?? 'online',
    },
    backend: {
      status: status?.backend?.status ?? 'connected',
    },
    requests: {
      status: status?.requests?.status ?? 'idle',
    },
    lastError: status?.lastError ?? null,
  };
}

function getStatusTone(status) {
  if (status.backend?.status === 'connected') {
    return 'connected';
  }

  if (status.backend?.status === 'reconnecting' || status.overall === 'reconnecting') {
    return 'reconnecting';
  }

  return 'disconnected';
}

function getStatusLabel(status) {
  const tone = getStatusTone(status);
  if (tone === 'connected') {
    return '后端正常';
  }

  if (tone === 'reconnecting') {
    return '后端重连中';
  }

  return '后端断开';
}

async function requestJson(fetchImpl, url, options) {
  const response = await fetchImpl(url, options);
  const text = await response.text();
  const body = text ? tryParseJson(text) : {};

  if (!response.ok) {
    const error = new Error(body?.error ?? `Request failed: ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

let markdownParser = null;

function renderMarkdownMessage(text) {
  const parser = getMarkdownParser();
  if (!parser) {
    return {
      className: 'message-text message-text--plain',
      html: escapeHtml(text),
    };
  }

  return {
    className: 'message-text message-markdown',
    html: parser.render(text),
  };
}

function getMarkdownParser() {
  if (markdownParser) {
    return markdownParser;
  }

  const factory = globalThis.markdownit;
  if (typeof factory !== 'function') {
    return null;
  }

  const parser = factory({
    html: false,
    linkify: true,
    breaks: true,
  });

  const defaultLinkOpen =
    parser.renderer.rules.link_open ??
    ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));

  parser.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    ensureTokenAttribute(token, 'target', '_blank');
    ensureTokenAttribute(token, 'rel', 'noreferrer noopener');
    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  markdownParser = parser;
  return markdownParser;
}

function ensureTokenAttribute(token, name, value) {
  const index = token.attrIndex(name);
  if (index >= 0) {
    token.attrs[index][1] = value;
    return;
  }

  token.attrPush([name, value]);
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeSelectorValue(text) {
  return String(text ?? '').replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

if (typeof window !== 'undefined' && window.document) {
  const app = createAppController();
  void app.bootstrap();
}
