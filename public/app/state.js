import {
  DEFAULT_ACTIVITY_PANEL_WIDTH,
  DEFAULT_PROJECT_PANEL_WIDTH,
} from './constants.js';
import {
  buildOptimisticUserContent,
  createInitialSessionOptions,
  normalizeApprovalMode,
  normalizeComposerAttachmentError,
  normalizeComposerAttachments,
  normalizeSessionOptions,
  normalizeSessionSettings,
} from './session-utils.js';
import {
  applyAuthState,
  clampPanelWidth,
  createInitialAuthState,
  createInitialSystemStatus,
  normalizeHistoryDialogTab,
  normalizeAuthState,
  normalizeMobileDrawerMode,
  normalizeSystemStatus,
  normalizeTheme,
} from './dom-utils.js';
import {
  applyApprovalUpdate,
  applyPendingQuestionUpdate,
  clearSessionUnread,
  filterSessionCountMap,
  keepDialogProject,
  keepPendingProject,
  keepSelectedSession,
  markSessionUnreadIfBackground,
  normalizeSubagentDialogSelection,
  syncThreadIntoProjects,
  updateProject,
  updateThreadNameInProjects,
  updateThreadNameInSessionDetails,
} from './project-utils.js';
import { mergeTurnPlan } from './plan-utils.js';
import {
  appendItemDelta,
  applyRuntimeSnapshotToState,
  collectProjectRuntimeState,
  createRealtimeItemEntry,
  createRealtimeSessionState,
  markTurnItemsSettled,
  normalizeThreadDetail,
  normalizeStreamedItem,
  replaceSessionRuntimeState,
  updateSessionRealtime,
  updateSessionThread,
  upsertThreadTurn,
  upsertTurnItem,
} from './thread-utils.js';

export const initialState = {
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
  theme: 'light',
  showConversationNav: true,
  mobileDrawerOpen: false,
  mobileDrawerMode: 'sessions',
  auth: createInitialAuthState(),
  loadError: null,
  systemStatus: createInitialSystemStatus(),
};

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
    case 'theme_changed':
      return {
        ...state,
        theme: normalizeTheme(action.payload?.theme),
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


export function collectProjectSessionSettings(projects) {
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
