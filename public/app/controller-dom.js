import {
  ACTIVITY_PANEL_LABEL,
  PROJECT_PANEL_LABEL,
} from './constants.js';
import {
  closeDialog,
  escapeSelectorValue,
  getCachedMarkup,
  isAuthenticatedAppState,
  isMobileViewport,
  openDialog,
  setupPanelResizer,
} from './dom-utils.js';
import { normalizePositiveInteger } from './file-preview-utils.js';
import {
  findProject,
  getPendingSessionProject,
  resolveSelectedSessionTitle,
} from './project-utils.js';
import { getSelectedSessionSettings } from './session-utils.js';
import {
  renderActivityPanel,
  getComposerSettingsScopeId,
  resolveComposerPrimaryAction,
  syncComposerAttachmentActions,
  syncComposerAttachmentError,
  syncComposerAttachmentsStrip,
  syncComposerButtons,
  syncComposerInlineFeedback,
  syncComposerInput,
  syncTaskSummaryBand,
} from './render-activity.js';
import {
  renderConversationDetail,
  renderMobileDrawer,
  renderProjectSidebar,
  shouldRenderConversationNav,
  syncApprovalModeControls,
  syncAuthGate,
  syncConversationNavToggle,
  syncConversationStatus,
  syncConversationTitle,
  syncPanelLayout,
  syncPanelResizer,
  syncPanelToggleButton,
  syncTheme,
} from './render-shell.js';
import { renderApprovalModeControls } from './render-settings.js';
import {
  collectProjectHistoryProjects,
  renderHistoryDialogContent,
  renderProjectDialogContent,
} from './render-projects.js';
import { renderFilePreviewDialog } from './render-file-preview.js';
import { renderConversationNavigation } from './render-turn-items.js';

export function bindProjectSidebarActions(ctx, root) {
  if (!root?.querySelectorAll) {
    return;
  }

  for (const button of root.querySelectorAll('[data-session-id]')) {
    button.addEventListener('click', () => {
      void ctx.controller.selectSession(button.dataset.sessionId);
    });
  }

  for (const button of root.querySelectorAll('[data-project-dialog-open]')) {
    button.addEventListener('click', () => {
      ctx.controller.openProjectDialog();
    });
  }

  for (const button of root.querySelectorAll('[data-project-collapse]')) {
    button.addEventListener('click', () => {
      void ctx.controller.toggleProjectCollapsed(button.dataset.projectCollapse);
    });
  }

  for (const button of root.querySelectorAll('[data-project-close]')) {
    button.addEventListener('click', () => {
      void ctx.controller.closeProject(button.dataset.projectClose);
    });
  }

  for (const button of root.querySelectorAll('[data-project-session-start]')) {
    button.addEventListener('click', () => {
      void ctx.controller.startSessionInProject(button.dataset.projectSessionStart);
    });
  }

  for (const button of root.querySelectorAll('[data-project-history-open]')) {
    button.addEventListener('click', () => {
      ctx.controller.openHistoryDialog(button.dataset.projectHistoryOpen);
    });
  }

  for (const button of root.querySelectorAll('[data-focused-remove]')) {
    button.addEventListener('click', () => {
      void ctx.controller.removeFocusedSession(
        button.dataset.projectId,
        button.dataset.focusedRemove,
      );
    });
  }

  for (const button of root.querySelectorAll('[data-logout-button]')) {
    button.addEventListener('click', () => {
      void ctx.controller.logout();
    });
  }

  for (const button of root.querySelectorAll('[data-theme-toggle]')) {
    button.addEventListener('click', () => {
      ctx.controller.toggleTheme(button.dataset.themeNextTheme);
    });
  }
}

export function bindApprovalModeControlsActions(ctx, root) {
  if (!root?.querySelectorAll) {
    return;
  }

  for (const button of root.querySelectorAll('[data-composer-settings-toggle]')) {
    button.addEventListener('click', () => {
      ctx.controller.toggleComposerSettings(button.dataset.composerSettingsScope);
    });
  }

  const select = root.querySelector('[data-approval-mode-select]');
  if (select) {
    select.addEventListener('change', () => {
      if (select.disabled) {
        return;
      }
      void ctx.controller.setApprovalMode(select.value);
    });
  }

  const modelSelect = root.querySelector('[data-session-model-select]');
  if (modelSelect) {
    modelSelect.addEventListener('change', () => {
      if (modelSelect.disabled) {
        return;
      }

      const currentSettings = getSelectedSessionSettings(ctx.state);
      void ctx.controller.setSessionSettings(ctx.state.selectedSessionId, {
        ...currentSettings,
        model: modelSelect.value || null,
      });
    });
  }

  const reasoningSelect = root.querySelector('[data-session-reasoning-select]');
  if (reasoningSelect) {
    reasoningSelect.addEventListener('change', () => {
      if (reasoningSelect.disabled) {
        return;
      }

      const currentSettings = getSelectedSessionSettings(ctx.state);
      void ctx.controller.setSessionSettings(ctx.state.selectedSessionId, {
        ...currentSettings,
        reasoningEffort: reasoningSelect.value || null,
      });
    });
  }

  const agentSelect = root.querySelector('[data-session-agent-select]');
  if (agentSelect) {
    agentSelect.addEventListener('change', () => {
      if (agentSelect.disabled) {
        return;
      }

      const currentSettings = getSelectedSessionSettings(ctx.state);
      void ctx.controller.setSessionSettings(ctx.state.selectedSessionId, {
        ...currentSettings,
        agentType: agentSelect.value || null,
      });
    });
  }

  const sandboxSelect = root.querySelector('[data-session-sandbox-select]');
  if (sandboxSelect) {
    sandboxSelect.addEventListener('change', () => {
      if (sandboxSelect.disabled) {
        return;
      }

      const currentSettings = getSelectedSessionSettings(ctx.state);
      void ctx.controller.setSessionSettings(ctx.state.selectedSessionId, {
        ...currentSettings,
        sandboxMode: sandboxSelect.value || null,
      });
    });
  }
}

export function bindActivityPanelActions(ctx, root) {
  if (!root?.addEventListener) {
    return;
  }

  root.addEventListener('click', (event) => {
    const tabButton = event?.target?.closest?.('[data-activity-panel-tab]');
    if (tabButton) {
      event.preventDefault?.();
      void ctx.controller.selectActivityPanelTab(tabButton.dataset.activityPanelTab);
      return;
    }

    const parentButton = event?.target?.closest?.('[data-file-browser-parent-path]');
    if (parentButton) {
      event.preventDefault?.();
      void ctx.controller.openWorkspaceFileBrowserParent(parentButton.dataset.fileBrowserParentPath);
      return;
    }

    const entryButton = event?.target?.closest?.('[data-file-browser-entry-path]');
    if (entryButton) {
      event.preventDefault?.();
      void ctx.controller.openWorkspaceFileBrowserEntry(
        entryButton.dataset.fileBrowserEntryPath,
        entryButton.dataset.fileBrowserEntryKind,
      );
    }
  });
}

function captureProjectDialogContinuity(documentRef, projectDialog) {
  const dialogInput =
    projectDialog?.querySelector?.('#project-dialog-input') ??
    documentRef?.querySelector?.('#project-dialog-input') ??
    null;
  const dialogBody = projectDialog?.querySelector?.('.project-dialog-browser-body') ?? null;
  const activeElement = documentRef?.activeElement ?? null;

  return {
    restoreInputFocus: dialogInput != null && activeElement === dialogInput,
    selectionStart: Number(dialogInput?.selectionStart ?? 0),
    selectionEnd: Number(dialogInput?.selectionEnd ?? dialogInput?.selectionStart ?? 0),
    bodyScrollTop: Number(dialogBody?.scrollTop ?? 0),
  };
}

function restoreProjectDialogContinuity(projectDialog, dialogInput, continuity) {
  if (!continuity) {
    return;
  }

  const dialogBody = projectDialog?.querySelector?.('.project-dialog-browser-body') ?? null;
  if (dialogBody && Number.isFinite(continuity.bodyScrollTop)) {
    dialogBody.scrollTop = continuity.bodyScrollTop;
  }

  if (!continuity.restoreInputFocus || !dialogInput?.focus) {
    return;
  }

  dialogInput.focus();
  if (typeof dialogInput.setSelectionRange === 'function') {
    const valueLength = String(dialogInput.value ?? '').length;
    const nextSelectionStart = Math.max(0, Math.min(continuity.selectionStart, valueLength));
    const nextSelectionEnd = Math.max(
      nextSelectionStart,
      Math.min(continuity.selectionEnd, valueLength),
    );
    dialogInput.setSelectionRange(nextSelectionStart, nextSelectionEnd);
  }
}

export function renderApp(ctx) {
  if (!ctx.documentRef) {
    return;
  }

    const appLayout = ctx.documentRef.querySelector('#app-layout');
    const authGate = ctx.documentRef.querySelector('#auth-gate');
    const loginError = ctx.documentRef.querySelector('#login-error');
    const loginButton = ctx.documentRef.querySelector('#login-button');
    const loginPassword = ctx.documentRef.querySelector('#login-password');
    const logoutButton = ctx.documentRef.querySelector('#logout-button');
    const sessionList = ctx.documentRef.querySelector('#session-list');
    const conversationScroll = ctx.documentRef.querySelector('#conversation-scroll');
    const conversationBody = ctx.documentRef.querySelector('#conversation-body');
    const conversationNav = ctx.documentRef.querySelector('#conversation-nav');
    const activityPanel = ctx.documentRef.querySelector('#activity-panel');
    const mobileDrawer = ctx.documentRef.querySelector('#mobile-drawer');
    const historyDialog = ctx.documentRef.querySelector('#history-dialog');
    const filePreviewDialog = ctx.documentRef.querySelector('#file-preview-dialog');
    const projectDialog = ctx.documentRef.querySelector('#project-dialog');
    const renameDialog = ctx.documentRef.querySelector('#rename-dialog');
    const projectPanelToggle = ctx.documentRef.querySelector('#project-panel-toggle');
    const activityPanelToggle = ctx.documentRef.querySelector('#activity-panel-toggle');
    const projectPanelResizer = ctx.documentRef.querySelector('#project-panel-resizer');
    const activityPanelResizer = ctx.documentRef.querySelector('#activity-panel-resizer');
    const conversationStatus = ctx.documentRef.querySelector('#conversation-status');
    const conversationTitle = ctx.documentRef.querySelector('#conversation-title');
    const sessionDockPlanSummary = ctx.documentRef.querySelector('#session-dock-plan-summary');
    const composerAttachmentsStrip = ctx.documentRef.querySelector('#composer-attachments');
    const composerAttachmentError = ctx.documentRef.querySelector('#composer-attachment-error');
    const composerInlineFeedback = ctx.documentRef.querySelector('#composer-inline-feedback');
    const composerInput = ctx.documentRef.querySelector('#composer-input');
    const approvalModeControls = ctx.documentRef.querySelector('#approval-mode-controls');
    const composerUploadFileButton = ctx.documentRef.querySelector('#composer-upload-file');
    const composerUploadFileAction = ctx.documentRef.querySelector('#composer-upload-file-action');
    const composerUploadImageButton = ctx.documentRef.querySelector('#composer-upload-image');
    const composerAttachmentMenu = ctx.documentRef.querySelector('#composer-attachment-menu');
    const composerFileInput = ctx.documentRef.querySelector('#composer-file-input');
    const composerImageInput = ctx.documentRef.querySelector('#composer-image-input');
    const composerCollapseToggle = ctx.documentRef.querySelector('#composer-collapse-toggle');
    const conversationNavToggle = ctx.documentRef.querySelector('#conversation-nav-toggle');
    const rewriteLastQuestionButton = ctx.documentRef.querySelector('#rewrite-last-question-button');
    const sendButton = ctx.documentRef.querySelector('#send-button');
    const interruptButton = ctx.documentRef.querySelector('#interrupt-button');
    const composer = ctx.documentRef.querySelector('#composer');
    const detail = ctx.state.sessionDetailsById[ctx.state.selectedSessionId];
    const conversationWindow = ctx.getConversationWindow(ctx.state.selectedSessionId, detail);
    const mobileViewport = isMobileViewport(ctx.documentRef);
    const authLocked = !isAuthenticatedAppState(ctx.state);
    const approvalUiState = {
      approvalModePending: ctx.approvalModeRequestInFlight,
      pendingApprovalIds: ctx.approvalRequestIdsInFlight,
      error: ctx.approvalUiError,
    };
    const pendingActionUiState = {
      pendingActionIds: ctx.pendingActionRequestIdsInFlight,
      error: ctx.pendingActionUiError,
    };
    const sessionSettingsUiState = {
      pending: ctx.sessionSettingsRequestInFlight,
      pendingThreadId: ctx.sessionSettingsPendingThreadId,
      error: ctx.sessionSettingsUiError,
    };

    syncTheme(ctx.documentRef, appLayout, ctx.state);
    syncPanelLayout(appLayout, ctx.state);
    syncPanelResizer(projectPanelResizer, {
      hidden: ctx.state.projectPanelCollapsed,
      label: PROJECT_PANEL_LABEL,
      width: ctx.state.projectPanelWidth,
    });
    syncPanelResizer(activityPanelResizer, {
      hidden: ctx.state.activityPanelCollapsed,
      label: ACTIVITY_PANEL_LABEL,
      width: ctx.state.activityPanelWidth,
    });
    syncPanelToggleButton(projectPanelToggle, {
      collapsed: ctx.state.projectPanelCollapsed,
      label: PROJECT_PANEL_LABEL,
    });
    syncPanelToggleButton(activityPanelToggle, {
      collapsed: ctx.state.activityPanelCollapsed,
      label: ACTIVITY_PANEL_LABEL,
    });
    syncConversationStatus(conversationStatus, ctx.state.systemStatus);
    syncConversationTitle(
      conversationTitle,
      authLocked ? '访问控制' : resolveSelectedSessionTitle(ctx.state, detail),
    );
    syncTaskSummaryBand(sessionDockPlanSummary, detail, ctx.state, mobileViewport);
    syncComposerInput(composerInput, ctx.state);
    syncComposerAttachmentsStrip(composerAttachmentsStrip, ctx.state);
    syncComposerAttachmentError(composerAttachmentError, ctx.state);
    syncComposerInlineFeedback(composerInlineFeedback, ctx.state);
    syncConversationNavToggle(conversationNavToggle, ctx.state.showConversationNav);
    syncComposerButtons(sendButton, interruptButton, rewriteLastQuestionButton, ctx.state);
    syncComposerAttachmentActions(
      composerUploadFileButton,
      composerUploadFileAction,
      composerUploadImageButton,
      composerAttachmentMenu,
      composerFileInput,
      composerImageInput,
      ctx.state,
    );
    syncAuthGate(authGate, loginError, loginButton, loginPassword, logoutButton, ctx.state.auth);
    if (composer?.dataset) {
      const nextCollapsed = String(Boolean(ctx.state.composerCollapsed));
      if (composer.dataset.collapsed !== nextCollapsed) {
        composer.dataset.collapsed = nextCollapsed;
      }
    }
    if (composerCollapseToggle) {
      const collapsed = Boolean(ctx.state.composerCollapsed);
      if (composerCollapseToggle.dataset?.collapsed !== String(collapsed)) {
        composerCollapseToggle.dataset.collapsed = String(collapsed);
      }
      const nextTitle = collapsed ? '展开底栏' : '压缩底栏';
      if (composerCollapseToggle.title !== nextTitle) {
        composerCollapseToggle.title = nextTitle;
      }
      if (composerCollapseToggle.getAttribute?.('aria-label') !== nextTitle) {
        composerCollapseToggle.setAttribute?.('aria-label', nextTitle);
      }
    }
    const composerSettingsScopeId = getComposerSettingsScopeId(ctx.state);
    const approvalControlsMarkup = getCachedMarkup(
      ctx.renderCache.approvalModeControls,
      [
        authLocked,
        mobileViewport,
        ctx.state.selectedSessionId,
        ctx.state.approvalMode,
        ctx.state.sessionOptions,
        ctx.state.sessionSettingsById[ctx.state.selectedSessionId] ?? null,
        ctx.state.turnStatusBySession[ctx.state.selectedSessionId] ?? null,
        ctx.state.realtimeBySession[ctx.state.selectedSessionId] ?? null,
        ctx.state.composerSettingsCollapsedByScope[composerSettingsScopeId] ?? null,
        ctx.approvalModeRequestInFlight,
        ctx.approvalUiError,
        ctx.sessionSettingsRequestInFlight,
        ctx.sessionSettingsPendingThreadId,
        ctx.sessionSettingsUiError,
      ],
      () => renderApprovalModeControls(
        ctx.state,
        approvalUiState,
        sessionSettingsUiState,
        { mobileViewport },
      ),
    );
    const approvalControlsChanged = syncApprovalModeControls(
      approvalModeControls,
      approvalControlsMarkup.html,
      authLocked,
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
          ctx.controller.removeComposerAttachment(button.dataset.composerAttachmentRemove);
        });
      }
    }

    if (sessionDockPlanSummary) {
      for (const button of sessionDockPlanSummary.querySelectorAll('[data-task-summary-toggle]')) {
        button.addEventListener('click', () => {
          ctx.controller.toggleTaskSummary(button.dataset.taskSummarySessionId || ctx.state.selectedSessionId);
        });
      }
    }

    if (approvalModeControls && approvalControlsChanged) {
      bindApprovalModeControlsActions(ctx, approvalModeControls);
    }

    if (conversationScroll) {
      conversationScroll.hidden = false;
      ctx.bindConversationScroll(conversationScroll);
    }

    if (sessionList) {
      sessionList.hidden = ctx.state.projectPanelCollapsed;
      const sidebarMarkup = getCachedMarkup(
        ctx.renderCache.sessionList,
        [
          ctx.state.projects,
          ctx.state.selectedSessionId,
          ctx.state.unreadBySession,
          ctx.state.turnStatusBySession,
          ctx.state.pendingSessionProjectId,
          ctx.state.theme,
          ctx.state.auth?.authenticated ?? false,
          ctx.state.loadError,
          ctx.state.loadError ? ctx.state.systemStatus : null,
        ],
        () => renderProjectSidebar(ctx.state),
      );
      if (sidebarMarkup.changed) {
        sessionList.innerHTML = sidebarMarkup.html;
        bindProjectSidebarActions(ctx, sessionList);
      }
    }

    if (conversationBody) {
      const conversationMarkup = getCachedMarkup(
        ctx.renderCache.conversationBody,
        [
          detail,
          ctx.state.selectedSessionId,
          ctx.state.realtimeBySession[ctx.state.selectedSessionId] ?? null,
          getPendingSessionProject(ctx.state),
          ctx.approvalModeRequestInFlight,
          ctx.approvalUiError,
          ctx.approvalRequestIdsInFlight.size,
          ctx.pendingActionUiError,
          ctx.pendingActionRequestIdsInFlight.size,
          conversationWindow?.startTurnIndex ?? null,
          conversationWindow?.endTurnIndex ?? null,
        ],
        () => renderConversationDetail(ctx.state, detail, approvalUiState, pendingActionUiState, conversationWindow),
      );
      if (conversationMarkup.changed) {
        conversationBody.innerHTML = conversationMarkup.html;

        for (const button of conversationBody.querySelectorAll('[data-subagent-turn-index]')) {
          button.addEventListener('click', () => {
            ctx.controller.jumpConversationToTurnIndex(Number(button.dataset.subagentTurnIndex));
          });
        }

        for (const button of conversationBody.querySelectorAll('[data-session-rename-open]')) {
          button.addEventListener('click', () => {
            ctx.controller.openRenameDialog(button.dataset.sessionRenameOpen);
          });
        }

        for (const button of conversationBody.querySelectorAll('[data-approval-approve]')) {
          button.disabled = ctx.approvalRequestIdsInFlight.has(button.dataset.approvalApprove);
          button.addEventListener('click', () => {
            if (button.disabled) {
              return;
            }
            void ctx.controller.approveRequest(button.dataset.approvalApprove);
          });
        }

        for (const button of conversationBody.querySelectorAll('[data-approval-deny]')) {
          button.disabled = ctx.approvalRequestIdsInFlight.has(button.dataset.approvalDeny);
          button.addEventListener('click', () => {
            if (button.disabled) {
              return;
            }
            void ctx.controller.denyRequest(button.dataset.approvalDeny);
          });
        }

        for (const button of conversationBody.querySelectorAll('[data-pending-action-submit]')) {
          const pendingActionId = button.dataset.pendingActionSubmit;
          button.disabled = ctx.pendingActionRequestIdsInFlight.has(pendingActionId);
          button.addEventListener('click', () => {
            if (button.disabled) {
              return;
            }

            const input = conversationBody.querySelector(
              `[data-pending-action-input="${escapeSelectorValue(pendingActionId)}"]`,
            );
            const response = input?.value ?? '';
            void ctx.controller.resolvePendingAction(pendingActionId, { response });
          });
        }
      }
    }

    if (conversationNav) {
      const navMarkup = !authLocked && shouldRenderConversationNav(ctx.state, detail)
        ? renderConversationNavigation()
        : '';
      conversationNav.hidden = !navMarkup;
      conversationNav.innerHTML = navMarkup;

      for (const button of conversationNav.querySelectorAll('[data-conversation-nav]')) {
        button.addEventListener('click', () => {
          const direction = button.dataset.conversationNav;
          if (direction === 'top') {
            ctx.controller.jumpConversationToTop();
            return;
          }

          if (direction === 'bottom') {
            ctx.controller.jumpConversationToBottom();
            return;
          }

          ctx.controller.jumpConversationByTurn(direction);
        });
      }
    }

    if (activityPanel) {
      activityPanel.hidden = ctx.state.activityPanelCollapsed;
      const activityMarkup = getCachedMarkup(
        ctx.renderCache.activityPanel,
        [
          ctx.state.selectedSessionId,
          ctx.state.activityPanelTab,
          ctx.state.turnStatusBySession,
          ctx.state.diffBySession,
          ctx.state.realtimeBySession,
          ctx.state.sessionDetailsById[ctx.state.selectedSessionId] ?? null,
          ctx.state.pendingSessionProjectId,
          ctx.state.fileBrowser,
        ],
        () => renderActivityPanel(ctx.state),
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
        mobileDrawer.innerHTML = ctx.state.mobileDrawerOpen
          ? renderMobileDrawer(ctx.state)
          : '';
      }

      if (mobileViewport && ctx.state.mobileDrawerOpen) {
        openDialog(mobileDrawer);

        for (const button of mobileDrawer.querySelectorAll('[data-mobile-drawer-close]')) {
          button.addEventListener('click', () => {
            ctx.controller.closeMobileDrawer();
          });
        }

        for (const button of mobileDrawer.querySelectorAll('[data-mobile-drawer-mode]')) {
          button.addEventListener('click', () => {
            ctx.controller.setMobileDrawerMode(button.dataset.mobileDrawerMode);
          });
        }

        bindProjectSidebarActions(ctx, mobileDrawer);
      } else if (mobileDrawer.open) {
        closeDialog(mobileDrawer);
      }
    }

    if (historyDialog) {
      const dialogProject = findProject(ctx.state.projects, ctx.state.historyDialogProjectId);
      historyDialog.innerHTML = dialogProject
        ? renderHistoryDialogContent(dialogProject, ctx.state.historyDialogTab, ctx.state.persistPanelPreference)
        : '';

      if (dialogProject) {
        if (typeof historyDialog.showModal === 'function' && !historyDialog.open) {
          historyDialog.showModal();
        } else {
          historyDialog.open = true;
        }

        for (const button of historyDialog.querySelectorAll('[data-history-dialog-close]')) {
          button.addEventListener('click', () => {
            ctx.controller.closeHistoryDialog();
          });
        }

        for (const button of historyDialog.querySelectorAll('[data-history-dialog-tab]')) {
          button.addEventListener('click', () => {
            ctx.controller.selectHistoryDialogTab(button.dataset.historyDialogTab);
          });
        }

        for (const button of historyDialog.querySelectorAll('[data-project-history-add]')) {
          button.addEventListener('click', () => {
            void ctx.controller.addFocusedSession(
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

    if (projectDialog) {
      if (ctx.state.projectDialog) {
        const projectDialogCache =
          ctx.renderCache.projectDialog ?? {
            keyParts: null,
            html: '',
          };
        ctx.renderCache.projectDialog = projectDialogCache;
        const projectDialogMarkup = getCachedMarkup(
          projectDialogCache,
          ctx.state.projectDialog.tab === 'manual'
            ? [
                ctx.state.projectDialog.tab,
                ctx.state.projectDialog.cwdDraft ?? '',
                JSON.stringify(collectProjectHistoryProjects(ctx.state.projects)),
              ]
            : [
                ctx.state.projectDialog.tab,
                ctx.state.projectDialog.cwdDraft ?? '',
                ctx.state.projectDialog.directoryBrowser?.currentPath ?? null,
                ctx.state.projectDialog.directoryBrowser?.parentPath ?? null,
                ctx.state.projectDialog.directoryBrowser?.entries ?? null,
                ctx.state.projectDialog.directoryBrowser?.loading ?? false,
                ctx.state.projectDialog.directoryBrowser?.error ?? null,
              ],
          () => renderProjectDialogContent(ctx.state),
        );
        const dialogContinuity = projectDialogMarkup.changed
          ? captureProjectDialogContinuity(ctx.documentRef, projectDialog)
          : null;
        if (projectDialogMarkup.changed) {
          projectDialog.innerHTML = projectDialogMarkup.html;
        }

        const renderedProjectDialogInput =
          projectDialog.querySelector?.('#project-dialog-input') ??
          ctx.documentRef.querySelector('#project-dialog-input');
        if (renderedProjectDialogInput) {
          const nextProjectDialogDraft = ctx.state.projectDialog.cwdDraft ?? '';
          if (renderedProjectDialogInput.value !== nextProjectDialogDraft) {
            renderedProjectDialogInput.value = nextProjectDialogDraft;
          }
        }

        openDialog(projectDialog);
        restoreProjectDialogContinuity(
          projectDialog,
          renderedProjectDialogInput,
          dialogContinuity,
        );
      } else {
        if (ctx.renderCache.projectDialog) {
          ctx.renderCache.projectDialog.keyParts = null;
          ctx.renderCache.projectDialog.html = '';
        }
        const renderedProjectDialogInput =
          projectDialog.querySelector?.('#project-dialog-input') ??
          ctx.documentRef.querySelector('#project-dialog-input');
        if (renderedProjectDialogInput) {
          renderedProjectDialogInput.value = '';
        }
        projectDialog.innerHTML = '';
        if (projectDialog.open) {
          closeDialog(projectDialog);
        }
      }
    }

    if (filePreviewDialog) {
      filePreviewDialog.innerHTML = ctx.filePreviewState
        ? renderFilePreviewDialog(ctx.filePreviewState)
        : '';

      if (ctx.filePreviewState) {
        openDialog(filePreviewDialog);

        for (const button of filePreviewDialog.querySelectorAll('[data-file-preview-close]')) {
          button.addEventListener('click', () => {
            ctx.controller.closeFilePreview();
          });
        }

        const highlightedLine = filePreviewDialog.querySelector?.('[data-file-preview-highlight="true"]');
        highlightedLine?.scrollIntoView?.({ block: 'center' });
      } else if (filePreviewDialog.open) {
        closeDialog(filePreviewDialog);
      }
    }
}

export function bindControllerDocumentEvents(ctx) {
  if (ctx.documentRef) {
    const authThemeToggle = ctx.documentRef.querySelector('#auth-theme-toggle');
    const loginForm = ctx.documentRef.querySelector('#login-form');
    const loginPassword = ctx.documentRef.querySelector('#login-password');
    const composer = ctx.documentRef.querySelector('#composer');
    const composerAttachmentsStrip = ctx.documentRef.querySelector('#composer-attachments');
    const composerInput = ctx.documentRef.querySelector('#composer-input');
    const composerUploadFileButton = ctx.documentRef.querySelector('#composer-upload-file');
    const composerUploadFileAction = ctx.documentRef.querySelector('#composer-upload-file-action');
    const composerUploadImageButton = ctx.documentRef.querySelector('#composer-upload-image');
    const composerFileInput = ctx.documentRef.querySelector('#composer-file-input');
    const composerImageInput = ctx.documentRef.querySelector('#composer-image-input');
    const composerCollapseToggle = ctx.documentRef.querySelector('#composer-collapse-toggle');
    const rewriteLastQuestionButton = ctx.documentRef.querySelector('#rewrite-last-question-button');
    const interruptButton = ctx.documentRef.querySelector('#interrupt-button');
    const conversationBody = ctx.documentRef.querySelector('#conversation-body');
    const activityPanel = ctx.documentRef.querySelector('#activity-panel');
    const historyDialog = ctx.documentRef.querySelector('#history-dialog');
    const filePreviewDialog = ctx.documentRef.querySelector('#file-preview-dialog');
    const mobileDrawer = ctx.documentRef.querySelector('#mobile-drawer');
    const projectDialog = ctx.documentRef.querySelector('#project-dialog');
    const projectDialogForm = ctx.documentRef.querySelector('#project-dialog-form');
    const projectDialogInput = ctx.documentRef.querySelector('#project-dialog-input');
    const renameDialog = ctx.documentRef.querySelector('#rename-dialog');
    const renameDialogForm = ctx.documentRef.querySelector('#rename-dialog-form');
    const renameDialogInput = ctx.documentRef.querySelector('#rename-dialog-input');
    const rewriteDialog = ctx.documentRef.querySelector('#rewrite-dialog');
    const rewriteDialogForm = ctx.documentRef.querySelector('#rewrite-dialog-form');
    const rewriteDialogInput = ctx.documentRef.querySelector('#rewrite-dialog-input');
    const projectPanelToggle = ctx.documentRef.querySelector('#project-panel-toggle');
    const activityPanelToggle = ctx.documentRef.querySelector('#activity-panel-toggle');
    const conversationNavToggle = ctx.documentRef.querySelector('#conversation-nav-toggle');
    const projectPanelResizer = ctx.documentRef.querySelector('#project-panel-resizer');
    const activityPanelResizer = ctx.documentRef.querySelector('#activity-panel-resizer');

    loginForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      void ctx.controller.login(loginPassword?.value ?? '');
    });

    authThemeToggle?.addEventListener('click', () => {
      ctx.controller.toggleTheme(authThemeToggle.dataset.themeNextTheme);
    });

    composer?.addEventListener('submit', (event) => {
      event.preventDefault();
      const primaryAction = resolveComposerPrimaryAction(ctx.state);
      if (primaryAction.kind === 'interrupt') {
        void ctx.controller.interruptTurn();
        return;
      }

      if (primaryAction.kind === 'send') {
        void ctx.controller.sendTurn(ctx.state.composerDraft);
      }
    });

    composerInput?.addEventListener('input', () => {
      ctx.controller.setComposerDraft(composerInput.value);
    });

    composerInput?.addEventListener('paste', (event) => {
      void ctx.controller.handleComposerPaste(event?.clipboardData?.items ?? []);
    });

    composerUploadFileButton?.addEventListener('click', () => {
      ctx.controller.setComposerAttachmentMenuOpen(!ctx.state.composerAttachmentMenuOpen);
    });

    composerUploadFileAction?.addEventListener('click', () => {
      ctx.controller.setComposerAttachmentMenuOpen(false);
      composerFileInput?.click?.();
    });

    composerUploadImageButton?.addEventListener('click', () => {
      ctx.controller.setComposerAttachmentMenuOpen(false);
      composerImageInput?.click?.();
    });

    composerCollapseToggle?.addEventListener('click', () => {
      ctx.controller.toggleComposerCollapsed();
    });

    composerFileInput?.addEventListener('change', () => {
      void ctx.controller.addComposerFiles(Array.from(composerFileInput.files ?? []));
      composerFileInput.value = '';
    });

    composerImageInput?.addEventListener('change', () => {
      void ctx.controller.addComposerFiles(Array.from(composerImageInput.files ?? []));
      composerImageInput.value = '';
    });

    interruptButton?.addEventListener('click', () => {
      void ctx.controller.interruptTurn();
    });

    rewriteLastQuestionButton?.addEventListener('click', () => {
      void ctx.controller.openRewriteDialog();
    });

    conversationBody?.addEventListener('click', (event) => {
      const rewriteUserMessageButton = event?.target?.closest?.('[data-rewrite-user-message]');
      if (rewriteUserMessageButton) {
        event.preventDefault?.();
        void ctx.controller.openRewriteDialog(rewriteUserMessageButton.dataset.rewriteUserMessage);
        return;
      }

      const localFileLink = event?.target?.closest?.('[data-local-file-path]');
      if (localFileLink) {
        event.preventDefault?.();
        void ctx.controller.openLocalFilePreview(
          localFileLink.dataset.localFilePath,
          normalizePositiveInteger(localFileLink.dataset.localFileLine),
          normalizePositiveInteger(localFileLink.dataset.localFileColumn),
        );
        return;
      }

      const attachmentButton = event?.target?.closest?.('[data-message-attachment-item]');
      if (attachmentButton) {
        event.preventDefault?.();
        ctx.controller.openConversationAttachment(
          attachmentButton.dataset.messageAttachmentItem,
          Number(attachmentButton.dataset.messageAttachmentIndex),
        );
      }
    });

    projectPanelToggle?.addEventListener('click', () => {
      ctx.controller.toggleProjectPanel();
    });

    activityPanelToggle?.addEventListener('click', () => {
      ctx.controller.toggleActivityPanel();
    });

    bindActivityPanelActions(ctx, activityPanel);
    bindActivityPanelActions(ctx, mobileDrawer);

    conversationNavToggle?.addEventListener('change', () => {
      ctx.controller.setConversationNavVisible(Boolean(conversationNavToggle.checked));
    });

    setupPanelResizer(projectPanelResizer, {
      side: 'project',
      controller: ctx.controller,
      getState: () => ctx.state,
      documentRef: ctx.documentRef,
    });

    setupPanelResizer(activityPanelResizer, {
      side: 'activity',
      controller: ctx.controller,
      getState: () => ctx.state,
      documentRef: ctx.documentRef,
    });

    historyDialog?.addEventListener?.('close', () => {
      if (ctx.state.historyDialogProjectId) {
        ctx.controller.closeHistoryDialog();
      }
    });

    filePreviewDialog?.addEventListener?.('close', () => {
      if (ctx.filePreviewState) {
        ctx.controller.closeFilePreview();
      }
    });

    renameDialog?.addEventListener?.('close', () => {
      if (ctx.pendingRenameSessionId) {
        ctx.controller.closeRenameDialog();
      }
    });

    rewriteDialog?.addEventListener?.('close', () => {
      if (ctx.pendingRewriteQuestion) {
        ctx.controller.closeRewriteDialog();
      }
    });

    mobileDrawer?.addEventListener?.('close', () => {
      if (ctx.state.mobileDrawerOpen) {
        ctx.controller.closeMobileDrawer();
      }
    });

    projectDialog?.addEventListener?.('click', (event) => {
      const closeButton = event?.target?.closest?.('[data-project-dialog-close]');
      if (closeButton) {
        event.preventDefault?.();
        ctx.controller.closeProjectDialog();
        return;
      }

      const tabButton = event?.target?.closest?.('[data-project-dialog-tab]');
      if (tabButton) {
        event.preventDefault?.();
        void ctx.controller.selectProjectDialogTab(tabButton.dataset.projectDialogTab);
        return;
      }

      const historyButton = event?.target?.closest?.('[data-project-dialog-history-path]');
      if (historyButton) {
        event.preventDefault?.();
        ctx.controller.setProjectDialogCwdDraft(historyButton.dataset.projectDialogHistoryPath);
        return;
      }

      const parentButton = event?.target?.closest?.('[data-project-dialog-parent-path]');
      if (parentButton) {
        event.preventDefault?.();
        void ctx.controller.openProjectDialogParentDirectory(
          parentButton.dataset.projectDialogParentPath,
        );
        return;
      }

      const entryButton = event?.target?.closest?.('[data-project-dialog-entry-path]');
      if (entryButton) {
        event.preventDefault?.();
        void ctx.controller.openProjectDialogDirectoryEntry(
          entryButton.dataset.projectDialogEntryPath,
          entryButton.dataset.projectDialogEntryKind,
        );
      }
    });

    projectDialog?.addEventListener?.('input', (event) => {
      if (event?.target?.id !== 'project-dialog-input') {
        return;
      }

      ctx.controller.setProjectDialogCwdDraft(event.target.value);
    });

    projectDialogInput?.addEventListener('input', () => {
      ctx.controller.setProjectDialogCwdDraft(projectDialogInput.value);
    });

    projectDialog?.addEventListener?.('submit', (event) => {
      if (event?.target?.id !== 'project-dialog-form') {
        return;
      }

      event.preventDefault();
      void ctx.controller.createProject().then((created) => {
        if (!created) {
          return;
        }

        ctx.controller.closeProjectDialog();
      });
    });

    projectDialogForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      void ctx.controller.createProject().then((created) => {
        if (!created) {
          return;
        }

        ctx.controller.closeProjectDialog();
      });
    });

    projectDialog?.addEventListener?.('close', () => {
      if (ctx.state.projectDialog) {
        ctx.controller.closeProjectDialog();
      }
    });

    for (const button of renameDialog?.querySelectorAll?.('[data-rename-dialog-close]') ?? []) {
      button.addEventListener('click', () => {
        ctx.controller.closeRenameDialog();
      });
    }

    renameDialogForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      void ctx.controller.renameSession(ctx.pendingRenameSessionId, renameDialogInput?.value ?? '');
    });

    for (const button of rewriteDialog?.querySelectorAll?.('[data-rewrite-dialog-close]') ?? []) {
      button.addEventListener('click', () => {
        ctx.controller.closeRewriteDialog();
      });
    }

    rewriteDialogForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      void ctx.controller.submitRewrittenQuestion(rewriteDialogInput?.value ?? '');
    });
  }
}
