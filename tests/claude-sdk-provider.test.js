import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeSdkProvider } from '../src/lib/claude-sdk-provider.js';

test('claude sdk provider reconciles active turns on start and forwards subscriptions, turn settings, and interrupts', async () => {
  const calls = [];
  let subscriber = null;
  const sessionService = {
    async markActiveSessionsInterrupted(reason) {
      calls.push(['markActiveSessionsInterrupted', reason]);
      return { ok: true, threadIds: [] };
    },
    subscribe(handler) {
      calls.push(['subscribe']);
      subscriber = handler;
      return () => {
        calls.push(['unsubscribe']);
      };
    },
    async startTurn(threadId, turnRequest) {
      calls.push(['startTurn', threadId, turnRequest]);
      return {
        turnId: 'turn-1',
        status: 'started',
      };
    },
    async interruptTurn(threadId, turnId) {
      calls.push(['interruptTurn', threadId, turnId]);
      return {
        interrupted: true,
      };
    },
  };
  const provider = new ClaudeSdkProvider({
    activityStore: {},
    runtimeStore: {},
    sessionIndex: {},
    sessionService,
  });
  const seenEvents = [];

  const startedStatus = await provider.start();
  const unsubscribe = provider.subscribe((event) => seenEvents.push(event));
  subscriber?.({
    type: 'turn_started',
    threadId: 'thread-1',
    payload: {
      threadId: 'thread-1',
      turnId: 'turn-1',
    },
  });

  const started = await provider.startTurn('thread-1', 'Inspect the repo', {
    model: 1234,
    reasoningEffort: 'not-valid',
    agentType: 'Plan',
  });
  const startedObjectForm = await provider.startTurn('thread-1', {
    text: 'Inspect the repo attachments',
    model: 'claude-opus-4-1',
    reasoningEffort: 'high',
    agentType: 'Explore',
    attachments: [
      {
        name: 'diagram.png',
        mimeType: 'image/png',
        size: 3,
        dataBase64: 'Zm9v',
      },
    ],
  });
  const interrupted = await provider.interruptTurn('thread-1', 'turn-1');
  unsubscribe();

  assert.equal(startedStatus.backend.status, 'connected');
  assert.deepEqual(started, {
    turnId: 'turn-1',
    status: 'started',
  });
  assert.deepEqual(startedObjectForm, {
    turnId: 'turn-1',
    status: 'started',
  });
  assert.deepEqual(interrupted, {
    interrupted: true,
  });
  assert.deepEqual(calls, [
    ['markActiveSessionsInterrupted', 'claude-sdk backend restarted'],
    ['subscribe'],
    [
      'startTurn',
      'thread-1',
      {
        text: 'Inspect the repo',
        model: '1234',
        reasoningEffort: null,
        agentType: 'Plan',
        attachments: [],
      },
    ],
    [
      'startTurn',
      'thread-1',
      {
        text: 'Inspect the repo attachments',
        model: 'claude-opus-4-1',
        reasoningEffort: 'high',
        agentType: 'Explore',
        attachments: [
          {
            name: 'diagram.png',
            mimeType: 'image/png',
            size: 3,
            dataBase64: 'Zm9v',
          },
        ],
      },
    ],
    ['interruptTurn', 'thread-1', 'turn-1'],
    ['unsubscribe'],
  ]);
  assert.equal(seenEvents[0].type, 'turn_started');
  assert.equal(provider.getStatus().backend.status, 'connected');
});

test('claude sdk provider forwards approval, pending-action, and session settings operations', async () => {
  const calls = [];
  const sessionService = {
    async renameSession(threadId, name) {
      calls.push(['renameSession', threadId, name]);
      return {
        thread: {
          id: threadId,
          name,
        },
      };
    },
    async getApprovalMode() {
      calls.push(['getApprovalMode']);
      return { mode: 'manual' };
    },
    async setApprovalMode(mode) {
      calls.push(['setApprovalMode', mode]);
      return { mode };
    },
    async getSessionOptions() {
      calls.push(['getSessionOptions']);
      return {
        modelOptions: [{ value: '', label: '默认' }],
        reasoningEffortOptions: [{ value: '', label: '默认' }],
        agentTypeOptions: [{ value: 'Explore', label: 'Explore' }],
        defaults: { model: null, reasoningEffort: null, agentType: null },
      };
    },
    async getSessionSettings(threadId) {
      calls.push(['getSessionSettings', threadId]);
      return { model: 'sonnet', reasoningEffort: 'high', agentType: 'Plan' };
    },
    async setSessionSettings(threadId, settings) {
      calls.push(['setSessionSettings', threadId, settings]);
      return settings;
    },
    async approveRequest(approvalId) {
      calls.push(['approveRequest', approvalId]);
      return { decision: 'approved' };
    },
    async denyRequest(approvalId) {
      calls.push(['denyRequest', approvalId]);
      return { decision: 'denied' };
    },
    async resolvePendingAction(actionId, resolution) {
      calls.push(['resolvePendingAction', actionId, resolution]);
      return { id: actionId, status: 'answered', payload: resolution };
    },
  };
  const provider = new ClaudeSdkProvider({
    activityStore: {},
    runtimeStore: {},
    sessionIndex: {},
    sessionService,
  });

  assert.deepEqual(await provider.renameSession('thread-1', 'Renamed thread'), {
    thread: {
      id: 'thread-1',
      name: 'Renamed thread',
    },
  });
  assert.deepEqual(await provider.getApprovalMode(), { mode: 'manual' });
  assert.deepEqual(await provider.setApprovalMode('auto'), { mode: 'auto' });
  assert.deepEqual(await provider.getSessionOptions(), {
    providerId: 'claude-sdk',
    attachmentCapabilities: {
      maxAttachments: 10,
      maxBytesPerAttachment: 20 * 1024 * 1024,
      acceptedMimePatterns: ['image/*', 'text/*', 'application/pdf'],
      supportsNonImageFiles: true,
    },
    modelOptions: [{ value: '', label: '默认' }],
    reasoningEffortOptions: [{ value: '', label: '默认' }],
    agentTypeOptions: [{ value: 'Explore', label: 'Explore' }],
    defaults: { model: null, reasoningEffort: null, agentType: null },
  });
  assert.deepEqual(await provider.getSessionSettings('thread-1'), {
    model: 'sonnet',
    reasoningEffort: 'high',
    agentType: 'Plan',
  });
  assert.deepEqual(
    await provider.setSessionSettings('thread-1', {
      model: 'opus',
      reasoningEffort: 'medium',
      agentType: 'Explore',
    }),
    {
      model: 'opus',
      reasoningEffort: 'medium',
      agentType: 'Explore',
    },
  );
  assert.deepEqual(await provider.approveRequest('approval-1'), { decision: 'approved' });
  assert.deepEqual(await provider.denyRequest('approval-2'), { decision: 'denied' });
  assert.deepEqual(
    await provider.resolvePendingAction('question-1', { response: 'continue' }),
    {
      id: 'question-1',
      status: 'answered',
      payload: { response: 'continue' },
    },
  );

  assert.deepEqual(calls, [
    ['renameSession', 'thread-1', 'Renamed thread'],
    ['getApprovalMode'],
    ['setApprovalMode', 'auto'],
    ['getSessionOptions'],
    ['getSessionSettings', 'thread-1'],
    ['setSessionSettings', 'thread-1', { model: 'opus', reasoningEffort: 'medium', agentType: 'Explore' }],
    ['approveRequest', 'approval-1'],
    ['denyRequest', 'approval-2'],
    ['resolvePendingAction', 'question-1', { response: 'continue' }],
  ]);
});

test('claude sdk provider forwards external bridge events to the session service', async () => {
  const calls = [];
  const sessionService = {
    async ingestExternalBridgeEvent(payload) {
      calls.push(['ingestExternalBridgeEvent', payload]);
      return {
        accepted: true,
        provider: payload.provider,
      };
    },
  };
  const provider = new ClaudeSdkProvider({
    activityStore: {},
    runtimeStore: {},
    sessionIndex: {},
    sessionService,
  });

  const result = await provider.ingestExternalBridgeEvent({
    provider: 'claude',
    event: {
      hookEventName: 'SessionStart',
      sessionId: 'session-1',
    },
    remoteAddress: '127.0.0.1',
  });

  assert.deepEqual(result, {
    accepted: true,
    provider: 'claude',
  });
  assert.deepEqual(calls, [
    [
      'ingestExternalBridgeEvent',
      {
        provider: 'claude',
        event: {
          hookEventName: 'SessionStart',
          sessionId: 'session-1',
        },
        remoteAddress: '127.0.0.1',
      },
    ],
  ]);
});

test('claude sdk provider declares its hook ingress route', async () => {
  const calls = [];
  const sessionService = {
    async ingestExternalBridgeEvent(payload) {
      calls.push(payload);
      return {
        accepted: true,
        provider: payload.provider,
        resolution: null,
      };
    },
  };
  const provider = new ClaudeSdkProvider({
    activityStore: {},
    runtimeStore: {},
    sessionIndex: {},
    sessionService,
  });

  const [route] = provider.getIngressRoutes();
  const context = {
    req: {
      headers: {
        'x-web-agent-hook-secret': 'test-hook-secret',
        'x-web-agent-wait-for-resolution': '1',
      },
      socket: {
        remoteAddress: '127.0.0.1',
      },
    },
    config: {
      claudeHookSecret: 'test-hook-secret',
    },
    readJsonBody: async () => ({
      hook_event_name: 'SessionStart',
      session_id: 'session-1',
    }),
    assertLocalLoopback() {},
    createHttpError(statusCode, message) {
      const error = new Error(message);
      error.statusCode = statusCode;
      return error;
    },
  };
  context.assertHeaderValue = ({ headerName, expectedValue, errorMessage }) => {
    if (expectedValue && context.req.headers[headerName] !== expectedValue) {
      throw context.createHttpError(403, errorMessage);
    }
  };

  const result = await route.handle(context);

  assert.equal(route.method, 'POST');
  assert.equal(route.path, '/api/providers/claude/hooks');
  assert.equal(route.allowUnauthenticated, true);
  assert.deepEqual(result, {
    statusCode: 202,
    body: {
      accepted: true,
      provider: 'claude',
      resolution: null,
    },
  });
  assert.deepEqual(calls, [
    {
      provider: 'claude',
      event: {
        hook_event_name: 'SessionStart',
        session_id: 'session-1',
      },
      waitForResolution: true,
      remoteAddress: '127.0.0.1',
    },
  ]);
});
