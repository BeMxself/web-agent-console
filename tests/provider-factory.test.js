import test from 'node:test';
import assert from 'node:assert/strict';
import { getConfig } from '../src/config.js';
import { createProvider } from '../src/lib/provider-factory.js';
import { ClaudeSdkSessionIndex } from '../src/lib/claude-sdk-session-index.js';
import { CodexSessionService } from '../src/lib/codex-session-service.js';
import { ClaudeSdkSessionService } from '../src/lib/claude-sdk-session-service.js';
import { cloneSessionOptions } from '../src/lib/session-service.js';

test('config exposes provider selection with codex default', () => {
  const config = getConfig({
    HOME: '/tmp/home',
  });

  assert.equal(config.provider, 'codex');
  assert.equal(config.agentApiBaseUrl, null);
  assert.equal(config.codexSandboxMode, 'danger-full-access');
  assert.equal(config.codexApprovalPolicy, 'on-request');
});

test('config normalizes WEB_AGENT_PROVIDER=claude-sdk and exposes session index path', () => {
  const config = getConfig({
    HOME: '/tmp/home',
    WEB_AGENT_PROVIDER: 'claude-sdk',
    CLAUDE_HOOK_SECRET: 'test-hook-secret',
  });

  assert.equal(config.provider, 'claude-sdk');
  assert.match(config.claudeSessionIndexPath, /claude-session-index\.json$/);
  assert.equal(config.claudeHookSecret, 'test-hook-secret');
});

test('provider factory creates the codex provider by default', () => {
  const provider = createProvider({
    config: getConfig({
      HOME: '/tmp/home',
      CODEX_BIN: 'codex',
      CODEX_APP_SERVER_PORT: '4321',
    }),
    activityStore: {
      load: async () => ({ projects: {} }),
    },
    cwd: '/tmp/workspace',
  });

  assert.equal(provider.providerId, 'codex');
  assert.equal(typeof provider.start, 'function');
  assert.equal(typeof provider.listProjects, 'function');
  assert.equal(typeof provider.shutdown, 'function');
  assert.deepEqual(provider.appServer.codexArgs.slice(0, 6), [
    '-s',
    'danger-full-access',
    '-a',
    'on-request',
    'app-server',
    '--listen',
  ]);
  assert.equal(provider.sessionService.approvalPolicy, 'on-request');
  assert.equal(provider.sessionService.sandboxMode, 'danger-full-access');
});

test('provider factory creates a claude sdk provider with expected observable behavior', async () => {
  const activityStore = createMemoryActivityStore();
  await activityStore.addProject('/tmp/workspace-a');
  await activityStore.addFocusedSession('/tmp/workspace-a', 'focused-thread-1');

  const originalListThreadIdsByProject = ClaudeSdkSessionIndex.prototype.listThreadIdsByProject;
  ClaudeSdkSessionIndex.prototype.listThreadIdsByProject = async function listThreadIdsByProject() {
    return new Map([['/tmp/workspace-a', ['history-thread-1', 'history-thread-2']]]);
  };

  try {
    const provider = createProvider({
      config: getConfig({
        HOME: '/tmp/home',
        WEB_AGENT_PROVIDER: 'claude-sdk',
      }),
      activityStore,
      runtimeStore: {
        load: async () => ({}),
      },
      cwd: '/tmp/claude-workspace',
    });

    assert.equal(provider.providerId, 'claude-sdk');
    assert.equal(typeof provider.start, 'function');
    assert.equal(typeof provider.listProjects, 'function');
    assert.equal(typeof provider.readSession, 'function');
    assert.equal(typeof provider.startTurn, 'function');
    assert.equal(typeof provider.shutdown, 'function');

    const status = await provider.start();
    assert.equal(status.backend.status, 'connected');
    assert.equal(status.requests.status, 'idle');
    assert.equal(status.relay.status, 'online');

    const projects = await provider.listProjects();
    assert.equal(projects.projects.length, 1);
    assert.equal(projects.projects[0].id, '/tmp/workspace-a');
    assert.deepEqual(
      projects.projects[0].focusedSessions.map((session) => session.id),
      ['focused-thread-1'],
    );
    assert.deepEqual(
      projects.projects[0].historySessions.active.map((session) => session.id),
      ['history-thread-1', 'history-thread-2'],
    );
  } finally {
    ClaudeSdkSessionIndex.prototype.listThreadIdsByProject = originalListThreadIdsByProject;
  }
});

test('provider factory creates the agent api provider when configured', async () => {
  const provider = createProvider({
    config: getConfig({
      HOME: '/tmp/home',
      PROVIDER: 'agentapi',
      AGENT_API_BASE_URL: 'http://127.0.0.1:9000',
    }),
    activityStore: createMemoryActivityStore(),
    cwd: '/tmp/workspace',
  });

  assert.equal(provider.providerId, 'agentapi');
  assert.equal(typeof provider.startTurn, 'function');

  await provider.start();
  await provider.addProject('/tmp/workspace-a');
  await provider.addProject('/tmp/workspace-b');
  await provider.closeProject('/tmp/workspace-b');
  const projects = await provider.listProjects();

  assert.equal(projects.projects[0].id, '/tmp/workspace-a');
  assert.equal(projects.projects.some((project) => project.id === '/tmp/workspace-b'), false);
  assert.equal(provider.getStatus().backend.status, 'disconnected');
  assert.match(provider.getStatus().lastError ?? '', /not implemented/i);
});

test('session option cloning preserves provider metadata', () => {
  const cloned = cloneSessionOptions({
    providerId: 'codex',
    attachmentCapabilities: {
      maxAttachments: 10,
      maxBytesPerAttachment: 20 * 1024 * 1024,
      acceptedMimePatterns: ['image/*'],
      supportsNonImageFiles: false,
    },
    modelOptions: [{ value: '', label: 'default' }],
    reasoningEffortOptions: [{ value: '', label: 'default' }],
    defaults: {
      model: null,
      reasoningEffort: null,
    },
    runtimeContext: {
      sandboxMode: 'danger-full-access',
    },
  });

  assert.deepEqual(cloned, {
    providerId: 'codex',
    attachmentCapabilities: {
      maxAttachments: 10,
      maxBytesPerAttachment: 20 * 1024 * 1024,
      acceptedMimePatterns: ['image/*'],
      supportsNonImageFiles: false,
    },
    modelOptions: [{ value: '', label: 'default' }],
    reasoningEffortOptions: [{ value: '', label: 'default' }],
    defaults: {
      model: null,
      reasoningEffort: null,
    },
    runtimeContext: {
      sandboxMode: 'danger-full-access',
    },
  });
});

test('provider session option defaults include stable attachment capabilities', async () => {
  const codexProvider = createProvider({
    config: getConfig({
      HOME: '/tmp/home',
      CODEX_BIN: 'codex',
      CODEX_APP_SERVER_PORT: '4321',
    }),
    activityStore: createMemoryActivityStore(),
    runtimeStore: {
      load: async () => ({}),
    },
    cwd: '/tmp/codex-workspace',
  });
  const claudeProvider = createProvider({
    config: getConfig({
      HOME: '/tmp/home',
      WEB_AGENT_PROVIDER: 'claude-sdk',
    }),
    activityStore: createMemoryActivityStore(),
    runtimeStore: {
      load: async () => ({}),
    },
    cwd: '/tmp/claude-workspace',
  });
  const agentProvider = createProvider({
    config: getConfig({
      HOME: '/tmp/home',
      PROVIDER: 'agentapi',
      AGENT_API_BASE_URL: 'http://127.0.0.1:9000',
    }),
    activityStore: createMemoryActivityStore(),
    cwd: '/tmp/workspace',
  });

  const codexOptions = await codexProvider.sessionService.getSessionOptions();
  const claudeOptions = await claudeProvider.getSessionOptions();
  const agentOptions = await agentProvider.getSessionOptions();

  assert.equal(codexOptions.providerId, 'codex');
  assert.deepEqual(codexOptions.attachmentCapabilities, {
    maxAttachments: 10,
    maxBytesPerAttachment: 20 * 1024 * 1024,
    acceptedMimePatterns: ['image/*'],
    supportsNonImageFiles: false,
  });
  assert.deepEqual(codexOptions.runtimeContext, {
    sandboxMode: 'danger-full-access',
  });

  assert.equal(claudeOptions.providerId, 'claude-sdk');
  assert.deepEqual(claudeOptions.attachmentCapabilities, {
    maxAttachments: 10,
    maxBytesPerAttachment: 20 * 1024 * 1024,
    acceptedMimePatterns: ['image/*', 'text/*', 'application/pdf'],
    supportsNonImageFiles: true,
  });
  assert.equal(claudeOptions.runtimeContext ?? null, null);

  assert.equal(agentOptions.providerId, 'agentapi');
  assert.deepEqual(agentOptions.attachmentCapabilities, {
    maxAttachments: 0,
    maxBytesPerAttachment: 0,
    acceptedMimePatterns: [],
    supportsNonImageFiles: false,
  });
  assert.equal(agentOptions.runtimeContext ?? null, null);
});

test('codex and claude providers expose the same app-level session contract through shared session-service subclasses', () => {
  const codexProvider = createProvider({
    config: getConfig({
      HOME: '/tmp/home',
      CODEX_BIN: 'codex',
      CODEX_APP_SERVER_PORT: '4321',
    }),
    activityStore: {
      load: async () => ({ projects: {} }),
    },
    runtimeStore: {
      load: async () => ({}),
    },
    cwd: '/tmp/codex-workspace',
  });
  const claudeProvider = createProvider({
    config: getConfig({
      HOME: '/tmp/home',
      WEB_AGENT_PROVIDER: 'claude-sdk',
    }),
    activityStore: createMemoryActivityStore(),
    runtimeStore: {
      load: async () => ({}),
    },
    cwd: '/tmp/claude-workspace',
  });

  const requiredMethods = [
    'listProjects',
    'readSession',
    'startTurn',
    'interruptTurn',
    'addFocusedSession',
    'removeFocusedSession',
    'setProjectCollapsed',
    'addProject',
    'closeProject',
    'renameSession',
    'createSessionInProject',
    'getApprovalMode',
    'setApprovalMode',
    'getSessionOptions',
    'getSessionSettings',
    'setSessionSettings',
    'approveRequest',
    'denyRequest',
    'resolvePendingAction',
    'getIngressRoutes',
  ];

  assert.equal(codexProvider.sessionService instanceof CodexSessionService, true);
  assert.equal(claudeProvider.sessionService instanceof ClaudeSdkSessionService, true);

  for (const method of requiredMethods) {
    assert.equal(typeof codexProvider[method], 'function', `codexProvider.${method}`);
    assert.equal(typeof claudeProvider[method], 'function', `claudeProvider.${method}`);
  }
});

function createMemoryActivityStore() {
  const snapshot = {
    projects: {},
  };

  return {
    async load() {
      return snapshot;
    },
    async addProject(projectId) {
      snapshot.projects[projectId] ??= {
        collapsed: false,
        focusedThreadIds: [],
        hidden: false,
      };
      snapshot.projects[projectId].hidden = false;
      return snapshot.projects[projectId];
    },
    async addFocusedSession(projectId, threadId) {
      snapshot.projects[projectId] ??= {
        collapsed: false,
        focusedThreadIds: [],
        hidden: false,
      };
      snapshot.projects[projectId].hidden = false;
      if (!snapshot.projects[projectId].focusedThreadIds.includes(threadId)) {
        snapshot.projects[projectId].focusedThreadIds.push(threadId);
      }
      return snapshot.projects[projectId];
    },
    async removeFocusedSession(projectId, threadId) {
      snapshot.projects[projectId] ??= {
        collapsed: false,
        focusedThreadIds: [],
        hidden: false,
      };
      snapshot.projects[projectId].focusedThreadIds = snapshot.projects[projectId].focusedThreadIds.filter(
        (id) => id !== threadId,
      );
      return snapshot.projects[projectId];
    },
    async setCollapsed(projectId, collapsed) {
      snapshot.projects[projectId] ??= {
        collapsed: false,
        focusedThreadIds: [],
        hidden: false,
      };
      snapshot.projects[projectId].collapsed = Boolean(collapsed);
      return snapshot.projects[projectId];
    },
    async hideProject(projectId) {
      snapshot.projects[projectId] ??= {
        collapsed: false,
        focusedThreadIds: [],
        hidden: false,
      };
      snapshot.projects[projectId].hidden = true;
      snapshot.projects[projectId].collapsed = false;
      snapshot.projects[projectId].focusedThreadIds = [];
      return snapshot.projects[projectId];
    },
  };
}
