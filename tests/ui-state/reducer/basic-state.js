import { test, assert, reduceState } from '../shared.js';

test('ui reducer stores grouped projects, selected thread, and turn events', () => {
  let state = reduceState(undefined, {
    type: 'projects_loaded',
    payload: {
      projects: [
        {
          id: '/tmp/workspace-a',
          cwd: '/tmp/workspace-a',
          displayName: 'workspace-a',
          collapsed: false,
          focusedSessions: [{ id: 'thread-1', name: 'Focus thread' }],
          historySessions: {
            active: [{ id: 'thread-3', name: 'Working thread' }],
            archived: [{ id: 'thread-2', name: 'Older archived thread' }],
          },
        },
      ],
    },
  });

  state = reduceState(state, {
    type: 'history_dialog_opened',
    payload: { projectId: '/tmp/workspace-a' },
  });

  state = reduceState(state, {
    type: 'history_dialog_tab_selected',
    payload: { tab: 'archived' },
  });

  state = reduceState(state, {
    type: 'history_dialog_closed',
  });

  state = reduceState(state, {
    type: 'session_selected',
    payload: { id: 'thread-2' },
  });

  state = reduceState(state, {
    type: 'turn_diff_updated',
    payload: { threadId: 'thread-2', diff: 'diff --git a/file' },
  });

  state = reduceState(state, {
    type: 'composer_text_changed',
    payload: { text: 'continue' },
  });

  state = reduceState(state, {
    type: 'system_status_loaded',
    payload: {
      overall: 'connected',
      backend: { status: 'connected' },
      relay: { status: 'online' },
      lastError: null,
    },
  });

  state = reduceState(state, {
    type: 'project_panel_toggled',
  });

  state = reduceState(state, {
    type: 'activity_panel_toggled',
  });

  state = reduceState(state, {
    type: 'panel_preference_changed',
    payload: { enabled: true },
  });

  state = reduceState(state, {
    type: 'project_panel_resized',
    payload: { width: 412 },
  });

  state = reduceState(state, {
    type: 'activity_panel_resized',
    payload: { width: 286 },
  });

  state = reduceState(state, {
    type: 'conversation_nav_visibility_toggled',
  });

  state = reduceState(state, {
    type: 'mobile_drawer_opened',
    payload: { mode: 'activity' },
  });

  state = reduceState(state, {
    type: 'mobile_drawer_mode_changed',
    payload: { mode: 'sessions' },
  });

  state = reduceState(state, {
    type: 'mobile_drawer_closed',
  });

  state = reduceState(state, {
    type: 'project_session_drafted',
    payload: { projectId: '/tmp/workspace-a' },
  });

  assert.equal(state.projects[0].collapsed, false);
  assert.equal(state.historyDialogProjectId, null);
  assert.equal(state.historyDialogTab, 'active');
  assert.equal(state.selectedSessionId, null);
  assert.equal(state.pendingSessionProjectId, '/tmp/workspace-a');
  assert.match(state.diffBySession['thread-2'], /diff --git/);
  assert.equal(state.systemStatus.backend.status, 'connected');
  assert.equal(state.composerDraft, 'continue');
  assert.equal(state.projectPanelCollapsed, true);
  assert.equal(state.activityPanelCollapsed, false);
  assert.equal(state.persistPanelPreference, true);
  assert.equal(state.projectPanelWidth, 412);
  assert.equal(state.activityPanelWidth, 286);
  assert.equal(state.showConversationNav, false);
  assert.equal(state.mobileDrawerOpen, false);
  assert.equal(state.mobileDrawerMode, 'sessions');
});

test('ui reducer defaults to a collapsed activity panel', () => {
  const state = reduceState(undefined, { type: '__noop__' });

  assert.equal(state.projectPanelCollapsed, false);
  assert.equal(state.activityPanelCollapsed, true);
  assert.equal(state.approvalMode, 'auto-approve');
});

test('ui reducer stores composer attachments and clears them when switching sessions', () => {
  let state = reduceState(undefined, {
    type: 'composer_attachments_added',
    payload: {
      attachments: [
        {
          id: 'draft-1',
          name: 'diagram.png',
          mimeType: 'image/png',
          size: 3,
          dataBase64: 'Zm9v',
          preview: { kind: 'image', url: 'data:image/png;base64,Zm9v' },
        },
      ],
    },
  });

  state = reduceState(state, {
    type: 'composer_attachment_error_changed',
    payload: { error: 'Codex 不支持附件“report.pdf”（application/pdf）。' },
  });

  state = reduceState(state, {
    type: 'session_selected',
    payload: { id: 'thread-1' },
  });

  assert.deepEqual(state.composerAttachments, []);
  assert.equal(state.composerAttachmentError, null);
});

test('ui reducer syncs session titles into the project tree and tracks unread background updates', () => {
  let state = reduceState(undefined, {
    type: 'projects_loaded',
    payload: {
      projects: [
        {
          id: '/tmp/workspace-a',
          cwd: '/tmp/workspace-a',
          displayName: 'workspace-a',
          collapsed: false,
          focusedSessions: [
            { id: 'thread-1', name: 'Selected thread', preview: 'opened', updatedAt: 5 },
            { id: 'thread-2', name: 'Old background name', preview: 'stale', updatedAt: 4 },
          ],
          historySessions: {
            active: [],
            archived: [],
          },
        },
      ],
    },
  });

  state = reduceState(state, {
    type: 'session_selected',
    payload: { id: 'thread-1' },
  });

  state = reduceState(state, {
    type: 'turn_started',
    payload: { threadId: 'thread-2', turnId: 'turn-2' },
  });

  state = reduceState(state, {
    type: 'session_detail_loaded',
    payload: {
      thread: {
        id: 'thread-2',
        name: 'Renamed background thread',
        preview: 'fresh preview',
        cwd: '/tmp/workspace-a',
        turns: [],
      },
    },
  });

  assert.equal(state.projects[0].focusedSessions[1].name, 'Renamed background thread');
  assert.equal(state.projects[0].focusedSessions[1].preview, 'fresh preview');
  assert.equal(state.unreadBySession['thread-2'], 1);

  state = reduceState(state, {
    type: 'thread_name_updated',
    payload: { threadId: 'thread-1', name: 'Renamed selected thread' },
  });

  assert.equal(state.projects[0].focusedSessions[0].name, 'Renamed selected thread');

  state = reduceState(state, {
    type: 'session_selected',
    payload: { id: 'thread-2' },
  });

  assert.equal(state.unreadBySession['thread-2'], 0);
});
