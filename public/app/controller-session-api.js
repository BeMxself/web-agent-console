import {
  createDraftAttachment,
  ingestClipboardItems,
} from '../composer-attachments.js';
import {
  clearLoginPassword,
  clearRenameInput,
  closeDialog,
  copyTextToClipboard,
  focusProjectInput,
  focusRenameInput,
  isAuthenticatedAppState,
  isMobileViewport,
  normalizeActivityPanelTab,
  normalizeTheme,
  openDialog,
  requestJson,
  sameSystemStatus,
  scrollConversationToBottom,
  setRenameDialogSession,
} from './dom-utils.js';
import { buildThreadItemCopyText } from './render-turn-items.js';
import {
  buildAttachmentDownloadUrl,
  buildLocalFileListUrl,
  buildLocalFilePreviewUrl,
  getDisplayName,
  isImageFile,
  isTextLikeFile,
  normalizeFileLocation,
  readAttachmentTextContent,
} from './file-preview-utils.js';
import {
  canInterruptTurn,
  canSendTurn,
  canRewriteQuestionInPlace,
  createInitialSessionSettings,
  findLatestUserQuestion,
  findUserQuestionById,
  findConversationAttachment,
  getComposerAttachmentError,
  getRewriteCapabilities,
  getRewriteQuestionAction,
  getRewriteLastQuestionAction,
  normalizeComposerAttachments,
  normalizeSessionSettings,
  resolveSessionSettingsScopeId,
} from './session-utils.js';
import {
  getComposerSettingsScopeId,
  isComposerSettingsCollapsed,
  isTaskSummaryCollapsed,
} from './render-activity.js';
import { findProject, findProjectBySessionId, findThreadMeta } from './project-utils.js';

function normalizeProjectDialogTab(tab) {
  return tab === 'manual' ? 'manual' : 'browse';
}

function shouldReloadProjectDialogBrowse(projectDialog) {
  if (!projectDialog) {
    return false;
  }

  const directoryBrowser = projectDialog.directoryBrowser ?? {};
  const cwdDraft = String(projectDialog.cwdDraft ?? '').trim();
  const currentPath = String(directoryBrowser.currentPath ?? '').trim();

  if (directoryBrowser.loading) {
    return false;
  }

  if (projectDialog.directoryBrowserResolved !== true) {
    return true;
  }

  if (directoryBrowser.error) {
    return true;
  }

  if (!cwdDraft) {
    return !currentPath;
  }

  return currentPath !== cwdDraft;
}

export function createSessionControllerApi(ctx) {
  return {
    getState() {
      return ctx.state;
    },
    async bootstrap() {
      const authSession = await ctx.controller.checkAuthSession();
      if (!isAuthenticatedAppState(ctx.state)) {
        return authSession;
      }

      await ctx.controller.loadStatus();
      ctx.controller.startStatusPolling();
      await ctx.controller.loadSessions();
      await ctx.controller.loadApprovalMode();
      await ctx.controller.loadSessionOptions();
      return authSession;
    },
    async checkAuthSession() {
      ctx.applyAction({ type: 'auth_session_check_started' });
      try {
        const session = await requestJson(ctx.fetchImpl, '/api/auth/session');
        ctx.setAuthenticated(session?.required);
        return session;
      } catch (error) {
        if (error?.status === 401) {
          return ctx.handleUnauthorized();
        }

        ctx.applyAction({
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
        ctx.applyAction({
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

      ctx.applyAction({ type: 'auth_login_started' });
      try {
        await requestJson(ctx.fetchImpl, '/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password: normalizedPassword }),
        });
      } catch (error) {
        if (error?.status === 401) {
          ctx.applyAction({
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

      clearLoginPassword(ctx.documentRef);
      ctx.setAuthenticated(true);
      await ctx.controller.loadStatus();
      ctx.controller.startStatusPolling();
      await ctx.controller.loadSessions();
      await ctx.controller.loadApprovalMode();
      await ctx.controller.loadSessionOptions();
      return ctx.state.auth;
    },
    async logout() {
      await requestJson(ctx.fetchImpl, '/api/auth/logout', {
        method: 'POST',
      }).catch(() => null);
      return ctx.handleUnauthorized();
    },
    async loadSessions() {
      try {
        const projects = await ctx.requestProtectedJson('/api/sessions');
        if (!projects) {
          return null;
        }

        ctx.controller.connectEvents();
        ctx.applyAction({ type: 'projects_loaded', payload: projects });
        return projects;
      } catch (error) {
        ctx.applyAction({ type: 'projects_load_failed', payload: { error: error.message } });
        return null;
      }
    },
    async loadStatus() {
      try {
        const status = await ctx.requestProtectedJson('/api/status');
        if (!status) {
          return ctx.state.systemStatus;
        }

        if (!sameSystemStatus(status, ctx.state.systemStatus)) {
          ctx.applyAction({ type: 'system_status_loaded', payload: status });
        }
        if (ctx.state.loadError && status.backend?.status === 'connected') {
          await ctx.controller.loadSessions();
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
        ctx.applyAction({ type: 'system_status_loaded', payload: fallbackStatus });
        return fallbackStatus;
      }
    },
    async loadApprovalMode() {
      try {
        const approvalMode = await ctx.requestProtectedJson('/api/approval-mode');
        if (!approvalMode) {
          return ctx.state.approvalMode;
        }

        ctx.applyAction({ type: 'approval_mode_loaded', payload: approvalMode });
        return ctx.state.approvalMode;
      } catch {
        return ctx.state.approvalMode;
      }
    },
    async loadSessionOptions() {
      try {
        const sessionOptions = await ctx.requestProtectedJson('/api/session-options');
        if (!sessionOptions) {
          return ctx.state.sessionOptions;
        }

        ctx.applyAction({ type: 'session_options_loaded', payload: sessionOptions });
        return ctx.state.sessionOptions;
      } catch {
        return ctx.state.sessionOptions;
      }
    },
    async loadSessionSettings(sessionId = ctx.state.selectedSessionId) {
      if (!sessionId) {
        return null;
      }

      try {
        const settings = await ctx.requestProtectedJson(`/api/sessions/${sessionId}/settings`);
        if (!settings) {
          return ctx.state.sessionSettingsById[sessionId] ?? createInitialSessionSettings();
        }

        ctx.applyAction({
          type: 'session_settings_loaded',
          payload: { threadId: sessionId, settings },
        });
        return ctx.state.sessionSettingsById[sessionId] ?? createInitialSessionSettings();
      } catch {
        return ctx.state.sessionSettingsById[sessionId] ?? createInitialSessionSettings();
      }
    },
    async copyThreadItem(itemId, sessionId = ctx.state.selectedSessionId) {
      const normalizedSessionId = String(sessionId ?? '').trim();
      const normalizedItemId = String(itemId ?? '').trim();
      if (!normalizedSessionId || !normalizedItemId) {
        return null;
      }

      const thread = ctx.state.sessionDetailsById?.[normalizedSessionId] ?? null;
      const item = findThreadItemById(thread, normalizedItemId);
      const copyText = buildThreadItemCopyText(item);
      if (!copyText) {
        return null;
      }

      const copied = await copyTextToClipboard(ctx.documentRef, copyText);
      return copied ? copyText : null;
    },
    startStatusPolling(intervalMs = 3_000) {
      if (!isAuthenticatedAppState(ctx.state)) {
        return null;
      }

      if (ctx.statusTimer) {
        return ctx.statusTimer;
      }

      void ctx.controller.loadStatus();
      ctx.statusTimer = setInterval(() => {
        void ctx.controller.loadStatus();
      }, intervalMs);
      return ctx.statusTimer;
    },
    async selectSession(sessionId, { preserveComposerAttachments = false } = {}) {
      if (isMobileViewport(ctx.documentRef) && ctx.state.mobileDrawerOpen) {
        ctx.applyAction({ type: 'mobile_drawer_closed' });
      }

      ctx.applyAction({
        type: 'session_selected',
        payload: { id: sessionId, preserveComposerAttachments },
      });
      const detail = await ctx.loadSessionDetail(sessionId, { anchorLatest: true });
      if (!detail) {
        return null;
      }
      await ctx.controller.loadSessionSettings(sessionId);
      if (ctx.state.activityPanelTab === 'files') {
        await ctx.controller.loadWorkspaceFileBrowser();
      }

      scrollConversationToBottom(ctx.documentRef);
      return detail;
    },
    async sendTurn(text) {
      const draftText = typeof text === 'string' ? text : ctx.state.composerDraft;
      if (!canSendTurn(ctx.state, draftText)) {
        const attachmentError = getComposerAttachmentError(ctx.state);
        if (attachmentError) {
          ctx.applyAction({
            type: 'composer_attachment_error_changed',
            payload: { error: attachmentError },
          });
        }
        return null;
      }

      const draftAttachments = normalizeComposerAttachments(ctx.state.composerAttachments);
      const draftSettings = normalizeSessionSettings(
        ctx.state.sessionSettingsById[resolveSessionSettingsScopeId(ctx.state)],
      );
      let sessionId = ctx.state.selectedSessionId;
      if (!sessionId && ctx.state.pendingSessionProjectId) {
        ctx.applyAction({ type: 'project_session_creation_started' });
        let created = null;
        try {
          created = await ctx.requestProtectedJson(
            `/api/projects/${encodeURIComponent(ctx.state.pendingSessionProjectId)}/sessions`,
            {
              method: 'POST',
            },
          );
        } finally {
          ctx.applyAction({ type: 'project_session_creation_finished' });
        }
        if (!created?.thread?.id) {
          return null;
        }

        await ctx.controller.loadSessions();
        await ctx.controller.selectSession(created.thread.id, { preserveComposerAttachments: true });
        sessionId = created.thread.id;
        if (
          draftSettings.model ||
          draftSettings.reasoningEffort ||
          draftSettings.agentType ||
          draftSettings.sandboxMode
        ) {
          ctx.applyAction({
            type: 'session_settings_changed',
            payload: { threadId: sessionId, settings: draftSettings },
          });
        }
      }

      const sessionSettings = sessionId
        ? normalizeSessionSettings(ctx.state.sessionSettingsById[sessionId] ?? draftSettings)
        : draftSettings;
      const turnRequestBody = {
        text: draftText,
        model: sessionSettings.model,
        reasoningEffort: sessionSettings.reasoningEffort,
        attachments: draftAttachments.map((attachment) => ({
          name: attachment.name,
          mimeType: attachment.mimeType,
          size: attachment.size,
          dataBase64: attachment.dataBase64,
        })),
      };
      if (sessionSettings.agentType) {
        turnRequestBody.agentType = sessionSettings.agentType;
      }
      if (sessionSettings.sandboxMode) {
        turnRequestBody.sandboxMode = sessionSettings.sandboxMode;
      }

      const result = await ctx.requestProtectedJson(`/api/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(turnRequestBody),
      });
      if (!result) {
        return null;
      }

      ctx.applyAction({ type: 'composer_text_changed', payload: { text: '' } });
      ctx.applyAction({ type: 'composer_attachments_cleared' });
      if (result?.turnId) {
        ctx.applyAction({
          type: 'user_turn_submitted',
          payload: {
            threadId: sessionId,
            turnId: result.turnId,
            text: draftText,
            attachments: draftAttachments,
          },
        });
        ctx.applyAction({
          type: 'turn_started',
          payload: { threadId: sessionId, turnId: result.turnId },
        });
      }
      ctx.controller.lastPostedTurn = { sessionId, text: draftText };
      return result;
    },
    async interruptTurn() {
      const sessionId = ctx.state.selectedSessionId;
      const turnId = ctx.state.activeTurnIdBySession[sessionId];
      if (!sessionId || !turnId || !canInterruptTurn(ctx.state)) {
        return null;
      }

      const result = await ctx.requestProtectedJson(`/api/sessions/${sessionId}/interrupt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ turnId }),
      });
      if (!result) {
        return null;
      }

      if (result?.thread?.runtime) {
        ctx.applyAction({
          type: 'session_runtime_reconciled',
          payload: {
            threadId: sessionId,
            runtime: result.thread.runtime,
          },
        });
      } else if (result?.interrupted === true) {
        const realtime = ctx.state.realtimeBySession[sessionId] ?? null;
        ctx.applyAction({
          type: 'session_runtime_reconciled',
          payload: {
            threadId: sessionId,
            runtime: {
              turnStatus: 'interrupted',
              activeTurnId: null,
              diff: ctx.state.diffBySession[sessionId] ?? null,
              realtime: realtime
                ? {
                    ...realtime,
                    status: 'interrupted',
                    closeReason: realtime.closeReason ?? '中断当前回合',
                  }
                : {
                    status: 'interrupted',
                    sessionId: null,
                    items: [],
                    audioChunkCount: 0,
                    audioByteCount: 0,
                    lastAudio: null,
                    lastError: null,
                    closeReason: '中断当前回合',
                  },
            },
          },
        });
      } else {
        ctx.applyAction({
          type: 'turn_interrupt_requested',
          payload: { threadId: sessionId, turnId },
        });
      }
      return result;
    },
    openHistoryDialog(projectId) {
      ctx.applyAction({ type: 'history_dialog_opened', payload: { projectId } });
      return ctx.state.historyDialogProjectId;
    },
    closeHistoryDialog() {
      ctx.applyAction({ type: 'history_dialog_closed' });
      return null;
    },
    selectHistoryDialogTab(tab) {
      ctx.applyAction({ type: 'history_dialog_tab_selected', payload: { tab } });
      return ctx.state.historyDialogTab;
    },
    async openProjectDialog() {
      ctx.applyAction({ type: 'project_dialog_opened' });
      openDialog(ctx.documentRef?.querySelector?.('#project-dialog'));
      focusProjectInput(ctx.documentRef);
      await ctx.controller.loadProjectDialogDirectory('');
      return ctx.state.projectDialog;
    },
    closeProjectDialog() {
      ctx.applyAction({ type: 'project_dialog_closed' });
      closeDialog(ctx.documentRef?.querySelector?.('#project-dialog'));
      return null;
    },
    setProjectDialogCwdDraft(cwdDraft) {
      ctx.applyAction({
        type: 'project_dialog_cwd_draft_changed',
        payload: {
          cwdDraft: String(cwdDraft ?? ''),
          invalidateDirectoryRequest: true,
        },
      });
      return ctx.state.projectDialog?.cwdDraft ?? '';
    },
    async selectProjectDialogTab(tab) {
      const previousTab = ctx.state.projectDialog?.tab ?? null;
      const nextTab = normalizeProjectDialogTab(tab);
      ctx.applyAction({
        type: 'project_dialog_tab_selected',
        payload: { tab: nextTab },
      });
      if (
        nextTab === 'browse' &&
        previousTab !== 'browse' &&
        shouldReloadProjectDialogBrowse(ctx.state.projectDialog)
      ) {
        await ctx.controller.loadProjectDialogDirectory();
      }
      return ctx.state.projectDialog?.tab ?? null;
    },
    async loadProjectDialogDirectory(path = null) {
      if (!ctx.state.projectDialog) {
        return null;
      }

      const requestedPath = String(path ?? ctx.state.projectDialog.cwdDraft ?? '').trim();
      const existingRootPath = ctx.state.projectDialog.directoryBrowser?.rootPath ?? null;
      ctx.projectDialogDirectoryRequestSeq = (ctx.projectDialogDirectoryRequestSeq ?? 0) + 1;
      const requestId = ctx.projectDialogDirectoryRequestSeq;
      ctx.applyAction({
        type: 'project_dialog_directory_requested',
        payload: {
          requestId,
          rootPath: existingRootPath,
          path: requestedPath || null,
          cwdDraft: requestedPath,
        },
      });

      try {
        const directory = await ctx.requestProtectedJson(buildLocalFileListUrl(requestedPath));
        if (!directory) {
          return null;
        }

        ctx.applyAction({
          type: 'project_dialog_directory_loaded',
          payload: {
            requestId,
            rootPath: existingRootPath ?? directory.path ?? null,
            cwdDraft: directory.path ?? requestedPath,
            directory,
          },
        });
        return ctx.state.projectDialog?.directoryBrowser ?? null;
      } catch (error) {
        ctx.applyAction({
          type: 'project_dialog_directory_load_failed',
          payload: {
            requestId,
            rootPath: existingRootPath,
            path: requestedPath || null,
            cwdDraft: requestedPath,
            error: error?.message ?? '无法加载目录。',
          },
        });
        return ctx.state.projectDialog?.directoryBrowser ?? null;
      }
    },
    async openProjectDialogDirectoryEntry(path, kind) {
      const normalizedPath = String(path ?? '').trim();
      if (!normalizedPath) {
        return null;
      }

      if (String(kind ?? '').trim() !== 'directory') {
        return ctx.state.projectDialog?.cwdDraft ?? null;
      }

      return ctx.controller.loadProjectDialogDirectory(normalizedPath);
    },
    async openProjectDialogParentDirectory(path = null) {
      const normalizedPath = String(
        path ?? ctx.state.projectDialog?.directoryBrowser?.parentPath ?? '',
      ).trim();
      if (!normalizedPath) {
        return null;
      }

      return ctx.controller.loadProjectDialogDirectory(normalizedPath);
    },
    setComposerDraft(text) {
      ctx.applyAction({ type: 'composer_text_changed', payload: { text } });
      return ctx.state.composerDraft;
    },
    toggleComposerCollapsed(collapsed = !ctx.state.composerCollapsed) {
      ctx.applyAction({
        type: 'composer_visibility_toggled',
        payload: { collapsed: Boolean(collapsed) },
      });
      return ctx.state.composerCollapsed;
    },
    async addComposerFiles(files) {
      const draftAttachments = [];
      try {
        for (const file of files ?? []) {
          draftAttachments.push(await createDraftAttachment(file));
        }
      } catch (error) {
        ctx.applyAction({
          type: 'composer_attachment_error_changed',
          payload: { error: error?.message ?? '读取附件失败' },
        });
        return ctx.state.composerAttachments;
      }

      if (draftAttachments.length === 0) {
        return ctx.state.composerAttachments;
      }

      ctx.applyAction({
        type: 'composer_attachments_added',
        payload: { attachments: draftAttachments },
      });
      return ctx.state.composerAttachments;
    },
    async handleComposerPaste(items) {
      try {
        const draftAttachments = await ingestClipboardItems(items);
        if (draftAttachments.length === 0) {
          return ctx.state.composerAttachments;
        }

        ctx.applyAction({
          type: 'composer_attachments_added',
          payload: { attachments: draftAttachments },
        });
        return ctx.state.composerAttachments;
      } catch (error) {
        ctx.applyAction({
          type: 'composer_attachment_error_changed',
          payload: { error: error?.message ?? '读取剪贴板附件失败' },
        });
        return ctx.state.composerAttachments;
      }
    },
    removeComposerAttachment(id) {
      ctx.applyAction({ type: 'composer_attachment_removed', payload: { id } });
      return ctx.state.composerAttachments;
    },
    toggleProjectPanel() {
      if (isMobileViewport(ctx.documentRef)) {
        ctx.applyAction({ type: 'mobile_drawer_opened', payload: { mode: 'sessions' } });
        return ctx.state.mobileDrawerOpen;
      }

      ctx.applyAction({ type: 'project_panel_toggled' });
      return ctx.state.projectPanelCollapsed;
    },
    toggleActivityPanel() {
      if (isMobileViewport(ctx.documentRef)) {
        ctx.applyAction({ type: 'mobile_drawer_opened', payload: { mode: 'activity' } });
        return ctx.state.mobileDrawerOpen;
      }

      ctx.applyAction({ type: 'activity_panel_toggled' });
      return ctx.state.activityPanelCollapsed;
    },
    async selectActivityPanelTab(tab) {
      const normalizedTab = normalizeActivityPanelTab(tab);
      ctx.applyAction({ type: 'activity_panel_tab_selected', payload: { tab: normalizedTab } });
      if (normalizedTab === 'files') {
        await ctx.controller.loadWorkspaceFileBrowser();
      }
      return ctx.state.activityPanelTab;
    },
    resolveWorkspaceFileBrowserRoot() {
      const selectedSessionId = ctx.state.selectedSessionId;
      if (!selectedSessionId) {
        return null;
      }

      const detail = ctx.state.sessionDetailsById?.[selectedSessionId] ?? null;
      const meta = findThreadMeta(ctx.state.projects ?? [], selectedSessionId);
      const rootPath = String(detail?.cwd ?? meta?.cwd ?? '').trim();
      return rootPath || null;
    },
    async loadWorkspaceFileBrowser(path = null) {
      const rootPath = ctx.controller.resolveWorkspaceFileBrowserRoot();
      if (!rootPath) {
        return null;
      }

      const requestedPath = normalizeWorkspaceFileBrowserPath(path, rootPath);
      ctx.applyAction({
        type: 'file_browser_requested',
        payload: { rootPath, path: requestedPath },
      });

      try {
        const directory = await ctx.requestProtectedJson(buildLocalFileListUrl(requestedPath));
        if (!directory) {
          return null;
        }

        ctx.applyAction({
          type: 'file_browser_loaded',
          payload: { rootPath, directory },
        });
        return ctx.state.fileBrowser;
      } catch (error) {
        ctx.applyAction({
          type: 'file_browser_load_failed',
          payload: {
            rootPath,
            path: requestedPath,
            error: error?.message ?? '无法加载工作区文件。',
          },
        });
        return ctx.state.fileBrowser;
      }
    },
    async openWorkspaceFileBrowserEntry(path, kind) {
      const normalizedKind = String(kind ?? '').trim();
      const normalizedPath = String(path ?? '').trim();
      if (!normalizedPath) {
        return null;
      }

      if (normalizedKind === 'directory') {
        return ctx.controller.loadWorkspaceFileBrowser(normalizedPath);
      }

      return ctx.controller.openLocalFilePreview(normalizedPath);
    },
    async openWorkspaceFileBrowserParent(path = null) {
      const normalizedPath = String(path ?? ctx.state.fileBrowser?.parentPath ?? '').trim();
      if (!normalizedPath) {
        return null;
      }

      return ctx.controller.loadWorkspaceFileBrowser(normalizedPath);
    },
    setPersistPanelPreference(enabled) {
      ctx.applyAction({ type: 'panel_preference_changed', payload: { enabled } });
      return ctx.state.persistPanelPreference;
    },
    setProjectPanelWidth(width) {
      ctx.applyAction({ type: 'project_panel_resized', payload: { width } });
      return ctx.state.projectPanelWidth;
    },
    setActivityPanelWidth(width) {
      ctx.applyAction({ type: 'activity_panel_resized', payload: { width } });
      return ctx.state.activityPanelWidth;
    },
    setConversationNavVisible(visible) {
      ctx.applyAction({ type: 'conversation_nav_visibility_toggled', payload: { visible } });
      return ctx.state.showConversationNav;
    },
    toggleTheme(nextTheme = null) {
      const resolvedTheme =
        typeof nextTheme === 'string' && nextTheme.trim()
          ? normalizeTheme(nextTheme)
          : ctx.state.theme === 'dark'
            ? 'light'
            : 'dark';
      ctx.applyAction({ type: 'theme_changed', payload: { theme: resolvedTheme } });
      return ctx.state.theme;
    },
    toggleTaskSummary(sessionId = ctx.state.selectedSessionId) {
      const targetSessionId = String(sessionId ?? '').trim();
      if (!targetSessionId) {
        return null;
      }

      const collapsed = !isTaskSummaryCollapsed(
        ctx.state,
        targetSessionId,
        isMobileViewport(ctx.documentRef),
      );
      ctx.applyAction({
        type: 'task_summary_visibility_toggled',
        payload: { sessionId: targetSessionId, collapsed },
      });
      return ctx.state.taskSummaryCollapsedBySession[targetSessionId] ?? collapsed;
    },
    toggleComposerSettings(scopeId = getComposerSettingsScopeId(ctx.state)) {
      const targetScopeId = String(scopeId ?? '').trim() || getComposerSettingsScopeId(ctx.state);
      if (!targetScopeId) {
        return null;
      }

      const collapsed = !isComposerSettingsCollapsed(
        ctx.state,
        targetScopeId,
        isMobileViewport(ctx.documentRef),
      );
      ctx.applyAction({
        type: 'composer_settings_visibility_toggled',
        payload: { scopeId: targetScopeId, collapsed },
      });
      return ctx.state.composerSettingsCollapsedByScope[targetScopeId] ?? collapsed;
    },
    setComposerAttachmentMenuOpen(open) {
      ctx.applyAction({ type: 'composer_attachment_menu_toggled', payload: { open } });
      return ctx.state.composerAttachmentMenuOpen;
    },
    setMobileDrawerMode(mode) {
      ctx.applyAction({ type: 'mobile_drawer_mode_changed', payload: { mode } });
      return ctx.state.mobileDrawerMode;
    },
    closeMobileDrawer() {
      ctx.applyAction({ type: 'mobile_drawer_closed' });
      return ctx.state.mobileDrawerOpen;
    },
    async toggleProjectCollapsed(projectId) {
      const project = findProject(ctx.state.projects, projectId);
      if (!project) {
        return null;
      }

      const collapsed = !project.collapsed;
      const result = await ctx.requestProtectedJson(`/api/projects/${encodeURIComponent(projectId)}/collapse`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ collapsed }),
      });
      if (!result) {
        return null;
      }

      ctx.applyAction({
        type: 'project_collapsed_updated',
        payload: { projectId, collapsed },
      });
      return collapsed;
    },
    async addFocusedSession(projectId, threadId) {
      const result = await ctx.requestProtectedJson(
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

      ctx.applyAction({ type: 'history_dialog_closed' });
      await ctx.controller.loadSessions();
      return threadId;
    },
    async openLocalFilePreview(filePath, line = null, column = null) {
      const normalizedPath = String(filePath ?? '').trim();
      if (!normalizedPath) {
        return null;
      }

      try {
        const preview = await ctx.requestProtectedJson(buildLocalFilePreviewUrl(normalizedPath));
        if (!preview) {
          return null;
        }

        if (preview.kind === 'text') {
          ctx.filePreviewState = {
            open: true,
            kind: 'text',
            name: preview.name,
            path: preview.path,
            mimeType: preview.mimeType,
            content: preview.content,
            line,
            column,
          };
          ctx.render();
          return ctx.filePreviewState;
        }

        if (preview.kind === 'image') {
          ctx.filePreviewState = {
            open: true,
            kind: 'image',
            name: preview.name,
            path: preview.path,
            mimeType: preview.mimeType,
            imageUrl: preview.contentUrl,
            line,
            column,
          };
          ctx.render();
          return ctx.filePreviewState;
        }

        ctx.controller.triggerDownload(preview.downloadUrl, preview.name);
        return preview;
      } catch (error) {
        ctx.filePreviewState = {
          open: true,
          kind: 'error',
          title: '文件预览失败',
          message: error?.message ?? '无法打开本地文件。',
          name: getDisplayName(normalizedPath),
          path: normalizedPath,
          line,
          column,
        };
        ctx.render();
        return ctx.filePreviewState;
      }
    },
    openConversationAttachment(itemId, attachmentIndex) {
      const detail = ctx.state.sessionDetailsById?.[ctx.state.selectedSessionId] ?? null;
      const attachment = findConversationAttachment(detail, itemId, attachmentIndex);
      if (!attachment) {
        return null;
      }

      if (isImageFile(attachment)) {
        const imageUrl = buildAttachmentDownloadUrl(attachment);
        if (!imageUrl) {
          return null;
        }

        ctx.filePreviewState = {
          open: true,
          kind: 'image',
          name: attachment.name,
          path: null,
          mimeType: attachment.mimeType,
          imageUrl,
          line: null,
          column: null,
        };
        ctx.render();
        return ctx.filePreviewState;
      }

      if (isTextLikeFile(attachment)) {
        ctx.filePreviewState = {
          open: true,
          kind: 'text',
          name: attachment.name,
          path: null,
          mimeType: attachment.mimeType,
          content: readAttachmentTextContent(attachment) ?? '',
          line: null,
          column: null,
        };
        ctx.render();
        return ctx.filePreviewState;
      }

      const downloadUrl = buildAttachmentDownloadUrl(attachment);
      if (!downloadUrl) {
        return null;
      }

      ctx.controller.triggerDownload(downloadUrl, attachment.name);
      return { downloadUrl, name: attachment.name };
    },
    closeFilePreview() {
      ctx.filePreviewState = null;
      ctx.render();
      return null;
    },
    triggerDownload(url, name = 'download') {
      if (!url) {
        return null;
      }

      const link = ctx.documentRef?.createElement?.('a');
      if (!link) {
        return null;
      }

      link.href = url;
      link.download = name;
      link.target = '';
      link.rel = '';
      link.style.display = 'none';
      ctx.documentRef?.body?.appendChild?.(link);
      link.click?.();
      ctx.documentRef?.body?.removeChild?.(link);
      return { url, name };
    },
    openRenameDialog(sessionId = ctx.state.selectedSessionId) {
      const renameId = sessionId ?? ctx.state.selectedSessionId;
      const session =
        ctx.state.sessionDetailsById[renameId] ?? findThreadMeta(ctx.state.projects ?? [], renameId);
      if (!renameId || !session) {
        return null;
      }

      ctx.pendingRenameSessionId = renameId;
      setRenameDialogSession(ctx.documentRef, session);
      openDialog(ctx.documentRef?.querySelector?.('#rename-dialog'));
      focusRenameInput(ctx.documentRef);
      return renameId;
    },
    openRewriteDialog(userMessageId = null, sessionId = ctx.state.selectedSessionId) {
      const targetSessionId = String(sessionId ?? ctx.state.selectedSessionId ?? '').trim();
      const action = getRewriteLastQuestionAction(ctx.state);
      const detail = ctx.state.sessionDetailsById?.[targetSessionId] ?? null;
      const selectedQuestion = userMessageId
        ? findUserQuestionById(detail, userMessageId)
        : findLatestUserQuestion(detail);
      const selectedQuestionAction = userMessageId
        ? getRewriteQuestionAction(ctx.state, selectedQuestion)
        : action;
      if (!targetSessionId || selectedQuestionAction.disabled || !selectedQuestion?.text?.trim()) {
        return null;
      }

      const project =
        findProjectBySessionId(ctx.state.projects ?? [], targetSessionId) ??
        findProject(ctx.state.projects ?? [], detail?.cwd ?? '');
      if (!project) {
        return null;
      }

      const rewriteCapabilities = getRewriteCapabilities(ctx.state);
      const availableModes = {
        branch: rewriteCapabilities.branch,
        inPlace:
          rewriteCapabilities.inPlace && canRewriteQuestionInPlace(detail, selectedQuestion),
      };
      if (!availableModes.branch && !availableModes.inPlace) {
        return null;
      }

      const primaryMode = availableModes.branch ? 'branch' : 'in-place';
      const secondaryMode =
        availableModes.branch && availableModes.inPlace
          ? 'in-place'
          : null;

      ctx.pendingRewriteQuestion = {
        sessionId: targetSessionId,
        projectId: project.id ?? project.cwd ?? detail.cwd,
        userMessageId: selectedQuestion.item.id,
        sourceTurnIndex: selectedQuestion.turnIndex,
        originalText: selectedQuestion.text,
        primaryMode,
        secondaryMode,
      };

      const titleNode = ctx.documentRef?.querySelector?.('#rewrite-dialog-session-title');
      if (titleNode && titleNode.textContent !== (detail?.name ?? detail?.id ?? '当前会话')) {
        titleNode.textContent = detail?.name ?? detail?.id ?? '当前会话';
      }

      const input = ctx.documentRef?.querySelector?.('#rewrite-dialog-input');
      if (input) {
        input.value = selectedQuestion.text;
      }

      syncRewriteDialogActions(ctx.documentRef, ctx.pendingRewriteQuestion);

      openDialog(ctx.documentRef?.querySelector?.('#rewrite-dialog'));
      input?.focus?.();
      input?.select?.();
      return ctx.pendingRewriteQuestion;
    },
    closeRewriteDialog() {
      ctx.pendingRewriteQuestion = null;
      const input = ctx.documentRef?.querySelector?.('#rewrite-dialog-input');
      if (input) {
        input.value = '';
      }
      syncRewriteDialogActions(ctx.documentRef, null);
      closeDialog(ctx.documentRef?.querySelector?.('#rewrite-dialog'));
      return null;
    },
    async submitRewrittenQuestion(text, mode = null) {
      const pendingRewrite = ctx.pendingRewriteQuestion;
      const normalizedText = String(text ?? '').trim();
      const rewriteMode = mode ?? pendingRewrite?.primaryMode ?? null;
      if (!pendingRewrite || !normalizedText || !rewriteMode) {
        return null;
      }

      const sourceDetail = ctx.state.sessionDetailsById?.[pendingRewrite.sessionId] ?? null;
      if (!sourceDetail) {
        return null;
      }

      const requestPath =
        rewriteMode === 'in-place'
          ? `/api/sessions/${encodeURIComponent(pendingRewrite.sessionId)}/rewrite`
          : `/api/sessions/${encodeURIComponent(pendingRewrite.sessionId)}/branch`;
      const created = await ctx.requestProtectedJson(
        requestPath,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            userMessageId: pendingRewrite.userMessageId,
            text: normalizedText,
          }),
        },
      );
      if (!created?.thread?.id || !created?.turnId) {
        return null;
      }

      await ctx.controller.loadSessions();
      await ctx.controller.selectSession(created.thread.id);
      if (rewriteMode === 'in-place') {
        ctx.applyAction({
          type: 'historical_question_rewrite_submitted',
          payload: {
            threadId: created.thread.id,
            turnId: created.turnId,
            sourceTurnIndex: pendingRewrite.sourceTurnIndex,
            text: normalizedText,
          },
        });
      } else {
        ctx.applyAction({
          type: 'user_turn_submitted',
          payload: {
            threadId: created.thread.id,
            turnId: created.turnId,
            text: normalizedText,
            attachments: [],
          },
        });
      }
      ctx.applyAction({
        type: 'turn_started',
        payload: { threadId: created.thread.id, turnId: created.turnId },
      });

      ctx.controller.closeRewriteDialog();
      return created;
    },
    closeRenameDialog() {
      ctx.pendingRenameSessionId = null;
      closeDialog(ctx.documentRef?.querySelector?.('#rename-dialog'));
      clearRenameInput(ctx.documentRef);
      return null;
    },
  };
}

function normalizeWorkspaceFileBrowserPath(path, rootPath) {
  const normalizedRootPath = String(rootPath ?? '').trim();
  const normalizedPath = String(path ?? '').trim();
  if (
    normalizedPath &&
    (normalizedPath === normalizedRootPath || normalizedPath.startsWith(`${normalizedRootPath}/`))
  ) {
    return normalizedPath;
  }

  return normalizedRootPath;
}

function syncRewriteDialogActions(documentRef, pendingRewriteQuestion) {
  const primaryButton = documentRef?.querySelector?.('#rewrite-dialog-submit-primary');
  const secondaryButton = documentRef?.querySelector?.('#rewrite-dialog-submit-secondary');

  const primaryMode = pendingRewriteQuestion?.primaryMode ?? null;
  const secondaryMode = pendingRewriteQuestion?.secondaryMode ?? null;

  if (primaryButton) {
    primaryButton.hidden = !primaryMode;
    primaryButton.dataset.rewriteMode = primaryMode ?? '';
    primaryButton.textContent = formatRewriteDialogButtonLabel(primaryMode, true);
  }

  if (secondaryButton) {
    secondaryButton.hidden = !secondaryMode;
    secondaryButton.dataset.rewriteMode = secondaryMode ?? '';
    secondaryButton.textContent = formatRewriteDialogButtonLabel(secondaryMode, false);
  }
}

function formatRewriteDialogButtonLabel(mode, primary) {
  if (mode === 'in-place') {
    return primary ? '在当前会话重跑' : '在当前会话重跑';
  }

  if (mode === 'branch') {
    return primary ? '新开分支重跑' : '新开分支重跑';
  }

  return '';
}

function findThreadItemById(thread, itemId) {
  const normalizedItemId = String(itemId ?? '').trim();
  if (!thread || !normalizedItemId) {
    return null;
  }

  for (const turn of thread.turns ?? []) {
    for (const item of turn.items ?? []) {
      if (String(item?.id ?? '').trim() === normalizedItemId) {
        return item;
      }
    }
  }

  return null;
}
