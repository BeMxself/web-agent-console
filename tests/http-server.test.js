import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { createFakeCodexServer } from './helpers/fake-codex-app-server.js';
import { JsonRpcClient } from '../src/lib/json-rpc-client.js';
import { CodexSessionService } from '../src/lib/codex-session-service.js';
import { createHttpServer } from '../src/lib/http-server.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const pocDir = join(testDir, '..');
const repoRoot = join(pocDir, '..', '..');
const execFileAsync = promisify(execFile);

test('http server exposes session list, thread detail, turn start, and sse stream', async () => {
  const fakeServer = await createFakeCodexServer();
  const client = new JsonRpcClient(fakeServer.url);
  await client.connect();
  const sessionService = toHttpProvider(new CodexSessionService({ client }));
  const server = createHttpServer({ provider: sessionService, publicDir: null });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const listResponse = await fetch(`${baseUrl}/api/sessions`);
  assert.equal(listResponse.status, 200);

  const statusResponse = await fetch(`${baseUrl}/api/status`);
  assert.equal(statusResponse.status, 200);

  const detailResponse = await fetch(`${baseUrl}/api/sessions/thread-1`);
  assert.equal(detailResponse.status, 200);

  const turnResponse = await fetch(`${baseUrl}/api/sessions/thread-1/turns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'continue' }),
  });
  assert.equal(turnResponse.status, 202);

  const eventsResponse = await fetch(`${baseUrl}/api/events`, {
    signal: AbortSignal.timeout(500),
  }).catch((error) => error);

  if (eventsResponse instanceof Response) {
    assert.equal(eventsResponse.status, 200);
    assert.match(eventsResponse.headers.get('content-type'), /text\/event-stream/);
    await eventsResponse.body?.cancel();
  }

  await client.close();
  await fakeServer.close();
  await new Promise((resolve) => server.close(resolve));
});

test('http server shutdown force-closes active sse clients so local start scripts can exit promptly', async () => {
  const sessionService = createStubSessionService();
  const server = createHttpServer({ provider: sessionService, publicDir: null });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const eventsResponse = await fetch(`${baseUrl}/api/events`);
  assert.equal(eventsResponse.status, 200);

  let shutdownResult = 'missing';
  let shutdownPromise = null;
  if (typeof server.shutdown === 'function') {
    shutdownPromise = server.shutdown();
    shutdownResult = await Promise.race([
      shutdownPromise.then(() => 'closed'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 150)),
    ]);
  }

  await eventsResponse.body?.cancel().catch(() => {});
  if (shutdownPromise) {
    await shutdownPromise;
  } else {
    await new Promise((resolve) => server.close(resolve));
  }

  assert.equal(shutdownResult, 'closed');
});

test('http server requires login for protected routes when shared password auth is enabled', async () => {
  const sessionService = createStubSessionService();
  const server = createHttpServer({
    provider: sessionService,
    publicDir: null,
    config: {
      authEnabled: true,
      authPassword: 'demo-password',
      authCookieSecret: 'test-secret',
    },
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const listResponse = await fetch(`${baseUrl}/api/sessions`);
  const statusResponse = await fetch(`${baseUrl}/api/status`);
  const eventsResponse = await fetch(`${baseUrl}/api/events`, {
    signal: AbortSignal.timeout(500),
  }).catch((error) => error);

  assert.equal(listResponse.status, 401);
  assert.equal(statusResponse.status, 401);
  if (eventsResponse instanceof Response) {
    assert.equal(eventsResponse.status, 401);
    await eventsResponse.body?.cancel();
  } else {
    assert.fail(eventsResponse);
  }

  const authSessionResponse = await fetch(`${baseUrl}/api/auth/session`);
  assert.equal(authSessionResponse.status, 401);

  const wrongPasswordResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'wrong-password' }),
  });
  assert.equal(wrongPasswordResponse.status, 401);

  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'demo-password' }),
  });
  assert.equal(loginResponse.status, 204);
  const authCookie = loginResponse.headers.get('set-cookie');
  assert.match(authCookie ?? '', /web-agent-auth=/);

  const authenticatedListResponse = await fetch(`${baseUrl}/api/sessions`, {
    headers: { cookie: authCookie },
  });
  assert.equal(authenticatedListResponse.status, 200);

  const authenticatedSessionResponse = await fetch(`${baseUrl}/api/auth/session`, {
    headers: { cookie: authCookie },
  });
  assert.equal(authenticatedSessionResponse.status, 200);
  const authenticatedSessionBody = await authenticatedSessionResponse.json();
  assert.equal(authenticatedSessionBody.authenticated, true);

  const logoutResponse = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: { cookie: authCookie },
  });
  assert.equal(logoutResponse.status, 204);
  const clearedCookie = logoutResponse.headers.get('set-cookie');
  assert.match(clearedCookie ?? '', /Max-Age=0/);

  const listAfterLogoutResponse = await fetch(`${baseUrl}/api/sessions`, {
    headers: { cookie: clearedCookie },
  });
  assert.equal(listAfterLogoutResponse.status, 401);

  await new Promise((resolve) => server.close(resolve));
});

test('http server returns grouped active and archived sessions from /api/sessions', async () => {
  const calls = [];
  const sessionService = toHttpProvider({
    getStatus() {
      return {
        overall: 'connected',
        backend: { status: 'connected' },
        relay: { status: 'online' },
        lastError: null,
      };
    },
    async listProjects() {
      return {
        projects: [
          {
            cwd: '/tmp/workspace-a',
            displayName: 'workspace-a',
            collapsed: true,
            focusedSessions: [{ id: 'thread-1', name: 'Focused thread', updatedAt: 5 }],
            historySessions: {
              active: [],
              archived: [{ id: 'thread-2', name: 'Archived thread', updatedAt: 4 }],
            },
          },
        ],
      };
    },
    async addFocusedSession(projectId, threadId) {
      calls.push({ method: 'addFocusedSession', projectId, threadId });
      return { ok: true };
    },
    async removeFocusedSession(projectId, threadId) {
      calls.push({ method: 'removeFocusedSession', projectId, threadId });
      return { ok: true };
    },
    async setProjectCollapsed(projectId, collapsed) {
      calls.push({ method: 'setProjectCollapsed', projectId, collapsed });
      return { ok: true };
    },
    async closeProject(projectId) {
      calls.push({ method: 'closeProject', projectId });
      return { ok: true };
    },
    async addProject(projectId) {
      calls.push({ method: 'addProject', projectId });
      return { ok: true };
    },
    async createSessionInProject(projectId) {
      calls.push({ method: 'createSessionInProject', projectId });
      return {
        thread: {
          id: 'thread-3',
          cwd: projectId,
          name: 'Project session',
        },
      };
    },
    async renameSession(threadId, name) {
      calls.push({ method: 'renameSession', threadId, name });
      return {
        thread: {
          id: threadId,
          cwd: '/tmp/workspace-a',
          name,
        },
      };
    },
    subscribe() {
      return () => {};
    },
  });
  const server = createHttpServer({ provider: sessionService, publicDir: null });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const listResponse = await fetch(`${baseUrl}/api/sessions`);
  const listBody = await listResponse.json();
  const statusResponse = await fetch(`${baseUrl}/api/status`);
  const statusBody = await statusResponse.json();

  assert.equal(listResponse.status, 200);
  assert.equal(Array.isArray(listBody.projects), true);
  assert.equal(statusResponse.status, 200);
  assert.equal(statusBody.backend.status, 'connected');
  assert.equal(listBody.projects[0].collapsed, true);
  assert.equal(listBody.projects[0].focusedSessions[0].id, 'thread-1');
  assert.equal(listBody.projects[0].historySessions.archived[0].id, 'thread-2');

  const addResponse = await fetch(
    `${baseUrl}/api/projects/${encodeURIComponent('/tmp/workspace-a')}/focused-sessions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 'thread-2' }),
    },
  );
  assert.equal(addResponse.status, 200);

  const removeResponse = await fetch(
    `${baseUrl}/api/projects/${encodeURIComponent('/tmp/workspace-a')}/focused-sessions/thread-2`,
    {
      method: 'DELETE',
    },
  );
  assert.equal(removeResponse.status, 200);

  const collapseResponse = await fetch(
    `${baseUrl}/api/projects/${encodeURIComponent('/tmp/workspace-a')}/collapse`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ collapsed: false }),
    },
  );
  assert.equal(collapseResponse.status, 200);

  const closeProjectResponse = await fetch(
    `${baseUrl}/api/projects/${encodeURIComponent('/tmp/workspace-a')}`,
    {
      method: 'DELETE',
    },
  );
  assert.equal(closeProjectResponse.status, 200);

  const addProjectResponse = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: '/tmp/workspace-b' }),
  });
  assert.equal(addProjectResponse.status, 201);

  const startSessionResponse = await fetch(
    `${baseUrl}/api/projects/${encodeURIComponent('/tmp/workspace-a')}/sessions`,
    {
      method: 'POST',
    },
  );
  assert.equal(startSessionResponse.status, 201);
  const startSessionBody = await startSessionResponse.json();
  assert.equal(startSessionBody.thread.id, 'thread-3');

  const renameSessionResponse = await fetch(`${baseUrl}/api/sessions/thread-1/name`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Renamed thread' }),
  });
  assert.equal(renameSessionResponse.status, 200);
  const renameSessionBody = await renameSessionResponse.json();
  assert.equal(renameSessionBody.thread.name, 'Renamed thread');

  assert.deepEqual(calls, [
    {
      method: 'addFocusedSession',
      projectId: '/tmp/workspace-a',
      threadId: 'thread-2',
    },
    {
      method: 'removeFocusedSession',
      projectId: '/tmp/workspace-a',
      threadId: 'thread-2',
    },
    {
      method: 'setProjectCollapsed',
      projectId: '/tmp/workspace-a',
      collapsed: false,
    },
    {
      method: 'closeProject',
      projectId: '/tmp/workspace-a',
    },
    {
      method: 'addProject',
      projectId: '/tmp/workspace-b',
    },
    {
      method: 'createSessionInProject',
      projectId: '/tmp/workspace-a',
    },
    {
      method: 'renameSession',
      threadId: 'thread-1',
      name: 'Renamed thread',
    },
  ]);

  await new Promise((resolve) => server.close(resolve));
});

test('http server exposes approval mode and approval resolution routes', async () => {
  const calls = [];
  const sessionService = toHttpProvider({
    subscribe() {
      return () => {};
    },
    async getApprovalMode() {
      calls.push({ method: 'getApprovalMode' });
      return { mode: 'manual' };
    },
    async setApprovalMode(mode) {
      calls.push({ method: 'setApprovalMode', mode });
      return { mode };
    },
    async approveRequest(approvalId) {
      calls.push({ method: 'approveRequest', approvalId });
      return { decision: 'approved' };
    },
    async denyRequest(approvalId) {
      calls.push({ method: 'denyRequest', approvalId });
      return { decision: 'denied' };
    },
  });
  const server = createHttpServer({ provider: sessionService, publicDir: null });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const modeResponse = await fetch(`${baseUrl}/api/approval-mode`);
  assert.equal(modeResponse.status, 200);
  assert.equal((await modeResponse.json()).mode, 'manual');

  const updateResponse = await fetch(`${baseUrl}/api/approval-mode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'auto-approve' }),
  });
  assert.equal(updateResponse.status, 200);
  assert.equal((await updateResponse.json()).mode, 'auto-approve');

  const approveResponse = await fetch(`${baseUrl}/api/approvals/approval-1/approve`, {
    method: 'POST',
  });
  assert.equal(approveResponse.status, 200);
  assert.equal((await approveResponse.json()).decision, 'approved');

  const denyResponse = await fetch(`${baseUrl}/api/approvals/approval-2/deny`, {
    method: 'POST',
  });
  assert.equal(denyResponse.status, 200);
  assert.equal((await denyResponse.json()).decision, 'denied');

  assert.deepEqual(calls, [
    { method: 'getApprovalMode' },
    { method: 'setApprovalMode', mode: 'auto-approve' },
    { method: 'approveRequest', approvalId: 'approval-1' },
    { method: 'denyRequest', approvalId: 'approval-2' },
  ]);

  await new Promise((resolve) => server.close(resolve));
});

test('http server exposes a route for resolving non-approval pending actions', async () => {
  const calls = [];
  const sessionService = toHttpProvider({
    subscribe() {
      return () => {};
    },
    async resolvePendingAction(actionId, resolution) {
      calls.push({ method: 'resolvePendingAction', actionId, resolution });
      return {
        id: actionId,
        kind: 'ask_user_question',
        status: 'answered',
        payload: {
          response: resolution?.response ?? null,
        },
      };
    },
  });
  const server = createHttpServer({ provider: sessionService, publicDir: null });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const response = await fetch(`${baseUrl}/api/pending-actions/question-1/respond`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ response: 'yes, continue' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    id: 'question-1',
    kind: 'ask_user_question',
    status: 'answered',
    payload: {
      response: 'yes, continue',
    },
  });
  assert.deepEqual(calls, [
    {
      method: 'resolvePendingAction',
      actionId: 'question-1',
      resolution: { response: 'yes, continue' },
    },
  ]);

  await new Promise((resolve) => server.close(resolve));
});

test('http server accepts local Claude hook events with a hook secret even when browser auth is enabled', async () => {
  const calls = [];
  const sessionService = toHttpProvider({
    subscribe() {
      return () => {};
    },
    async ingestExternalBridgeEvent(payload) {
      calls.push(payload);
      return {
        accepted: true,
        provider: payload.provider,
      };
    },
  });
  sessionService.getIngressRoutes = () => [
    {
      method: 'POST',
      path: '/api/providers/claude/hooks',
      allowUnauthenticated: true,
      async handle(context) {
        context.assertLocalLoopback('Claude hook ingress only accepts local loopback traffic');
        context.assertHeaderValue({
          headerName: 'x-web-agent-hook-secret',
          expectedValue: context.config.claudeHookSecret,
          errorMessage: 'Invalid Claude hook secret',
        });
        const event = await context.readJsonBody();
        const data = await sessionService.ingestExternalBridgeEvent({
          provider: 'claude',
          event,
          waitForResolution: context.req.headers['x-web-agent-wait-for-resolution'] === '1',
          remoteAddress: context.req.socket.remoteAddress ?? null,
        });
        return {
          statusCode: 202,
          body: data,
        };
      },
    },
  ];
  const server = createHttpServer({
    provider: sessionService,
    publicDir: null,
    config: {
      authEnabled: true,
      authPassword: 'demo-password',
      authCookieSecret: 'test-auth-secret',
      claudeHookSecret: 'test-hook-secret',
    },
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const rejected = await fetch(`${baseUrl}/api/providers/claude/hooks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-web-agent-hook-secret': 'wrong-secret',
    },
    body: JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: 'session-1',
    }),
  });
  assert.equal(rejected.status, 403);

  const accepted = await fetch(`${baseUrl}/api/providers/claude/hooks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-web-agent-hook-secret': 'test-hook-secret',
    },
    body: JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: 'session-1',
    }),
  });
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), {
    accepted: true,
    provider: 'claude',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'claude');
  assert.deepEqual(calls[0].event, {
    hook_event_name: 'SessionStart',
    session_id: 'session-1',
  });
  assert.equal(
    ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(calls[0].remoteAddress),
    true,
  );

  await new Promise((resolve) => server.close(resolve));
});

test('http server mounts provider-declared ingress routes without provider-specific hardcoding', async () => {
  const calls = [];
  const sessionService = toHttpProvider({
    subscribe() {
      return () => {};
    },
    getIngressRoutes() {
      return [
        {
          method: 'POST',
          path: '/api/providers/test/hooks',
          allowUnauthenticated: true,
          async handle(context) {
            const body = await context.readJsonBody();
            calls.push({
              remoteAddress: context.req.socket.remoteAddress ?? null,
              header: context.req.headers['x-test-secret'],
              configValue: context.config.testSecret ?? null,
              body,
            });

            if (context.req.headers['x-test-secret'] !== context.config.testSecret) {
              throw context.createHttpError(403, 'Invalid test hook secret');
            }

            return {
              statusCode: 202,
              body: {
                accepted: true,
                provider: 'test',
                body,
              },
            };
          },
        },
      ];
    },
  });
  const server = createHttpServer({
    provider: sessionService,
    publicDir: null,
    config: {
      authEnabled: true,
      authPassword: 'demo-password',
      authCookieSecret: 'test-auth-secret',
      testSecret: 'expected-secret',
    },
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const rejected = await fetch(`${baseUrl}/api/providers/test/hooks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-test-secret': 'wrong-secret',
    },
    body: JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: 'session-1',
    }),
  });
  assert.equal(rejected.status, 403);
  assert.deepEqual(await rejected.json(), {
    error: 'Invalid test hook secret',
  });

  const accepted = await fetch(`${baseUrl}/api/providers/test/hooks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-test-secret': 'expected-secret',
    },
    body: JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: 'session-1',
    }),
  });
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), {
    accepted: true,
    provider: 'test',
    body: {
      hook_event_name: 'SessionStart',
      session_id: 'session-1',
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].configValue, 'expected-secret');
  assert.equal(
    ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(calls[1].remoteAddress),
    true,
  );

  await new Promise((resolve) => server.close(resolve));
});

test('http server exposes session options and session settings routes', async () => {
  const calls = [];
  const sessionService = toHttpProvider({
    subscribe() {
      return () => {};
    },
    async getSessionOptions() {
      calls.push({ method: 'getSessionOptions' });
      return {
        providerId: 'codex',
        attachmentCapabilities: {
          maxAttachments: 10,
          maxBytesPerAttachment: 20 * 1024 * 1024,
          acceptedMimePatterns: ['image/*'],
          supportsNonImageFiles: false,
        },
        modelOptions: [
          { value: '', label: '默认' },
          { value: 'gpt-5.4', label: 'gpt-5.4' },
        ],
        reasoningEffortOptions: [
          { value: '', label: '默认' },
          { value: 'medium', label: '中' },
        ],
        defaults: {
          model: null,
          reasoningEffort: null,
        },
        runtimeContext: {
          sandboxMode: 'danger-full-access',
        },
      };
    },
    async getSessionSettings(threadId) {
      calls.push({ method: 'getSessionSettings', threadId });
      return {
        model: 'gpt-5.4',
        reasoningEffort: null,
      };
    },
    async setSessionSettings(threadId, settings) {
      calls.push({ method: 'setSessionSettings', threadId, settings });
      return settings;
    },
  });
  const server = createHttpServer({ provider: sessionService, publicDir: null });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const optionsResponse = await fetch(`${baseUrl}/api/session-options`);
  assert.equal(optionsResponse.status, 200);
  assert.deepEqual(await optionsResponse.json(), {
    providerId: 'codex',
    attachmentCapabilities: {
      maxAttachments: 10,
      maxBytesPerAttachment: 20 * 1024 * 1024,
      acceptedMimePatterns: ['image/*'],
      supportsNonImageFiles: false,
    },
    modelOptions: [
      { value: '', label: '默认' },
      { value: 'gpt-5.4', label: 'gpt-5.4' },
    ],
    reasoningEffortOptions: [
      { value: '', label: '默认' },
      { value: 'medium', label: '中' },
    ],
    defaults: {
      model: null,
      reasoningEffort: null,
    },
    runtimeContext: {
      sandboxMode: 'danger-full-access',
    },
  });

  const settingsResponse = await fetch(`${baseUrl}/api/sessions/thread-1/settings`);
  assert.equal(settingsResponse.status, 200);
  assert.deepEqual(await settingsResponse.json(), {
    model: 'gpt-5.4',
    reasoningEffort: null,
  });

  const updateResponse = await fetch(`${baseUrl}/api/sessions/thread-1/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: null, reasoningEffort: 'medium' }),
  });
  assert.equal(updateResponse.status, 200);
  assert.deepEqual(await updateResponse.json(), {
    model: null,
    reasoningEffort: 'medium',
  });

  assert.deepEqual(calls, [
    { method: 'getSessionOptions' },
    { method: 'getSessionSettings', threadId: 'thread-1' },
    {
      method: 'setSessionSettings',
      threadId: 'thread-1',
      settings: {
        model: null,
        reasoningEffort: 'medium',
      },
    },
  ]);

  await new Promise((resolve) => server.close(resolve));
});

test('http server forwards normalized turn requests to the provider', async () => {
  const calls = [];
  const sessionService = toHttpProvider({
    async startTurn(...args) {
      calls.push(args);
      return { turnId: 'turn-7', status: 'started' };
    },
  });
  const server = createHttpServer({ provider: sessionService, publicDir: null });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const turnResponse = await fetch(`${baseUrl}/api/sessions/thread-1/turns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: 'Review these files',
      model: null,
      reasoningEffort: null,
      attachments: [
        {
          name: 'diagram.png',
          mimeType: 'image/png',
          size: 3,
          dataBase64: 'Zm9v',
        },
      ],
    }),
  });
  assert.equal(turnResponse.status, 202);
  assert.deepEqual(await turnResponse.json(), { turnId: 'turn-7', status: 'started' });
  assert.deepEqual(calls, [
    [
      'thread-1',
      {
        text: 'Review these files',
        model: null,
        reasoningEffort: null,
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
  ]);

  await new Promise((resolve) => server.close(resolve));
});

test('http server normalizes missing turn attachments to an empty array', async () => {
  const calls = [];
  const sessionService = toHttpProvider({
    async startTurn(...args) {
      calls.push(args);
      return { turnId: 'turn-8', status: 'started' };
    },
  });
  const server = createHttpServer({ provider: sessionService, publicDir: null });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const turnResponse = await fetch(`${baseUrl}/api/sessions/thread-1/turns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: 'continue',
      model: null,
      reasoningEffort: null,
    }),
  });
  assert.equal(turnResponse.status, 202);
  assert.deepEqual(calls, [
    [
      'thread-1',
      {
        text: 'continue',
        model: null,
        reasoningEffort: null,
        attachments: [],
      },
    ],
  ]);

  await new Promise((resolve) => server.close(resolve));
});

test('http server rejects malformed turn attachments and does not call provider.startTurn', async () => {
  const calls = [];
  const sessionService = toHttpProvider({
    async startTurn(...args) {
      calls.push(args);
      return { turnId: 'turn-9', status: 'started' };
    },
  });
  const server = createHttpServer({ provider: sessionService, publicDir: null });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const turnResponse = await fetch(`${baseUrl}/api/sessions/thread-1/turns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: 'continue',
      attachments: [
        {
          name: 'diagram.png',
          mimeType: 'image/png',
          size: '3',
          dataBase64: 'Zm9v',
        },
      ],
    }),
  });
  assert.equal(turnResponse.status, 400);
  assert.equal(calls.length, 0);

  await new Promise((resolve) => server.close(resolve));
});

test('http server serves static assets with browser-safe content types and missing files return 404', async () => {
  const sessionService = toHttpProvider({
    subscribe() {
      return () => {};
    },
    getStatus() {
      return {
        overall: 'disconnected',
        backend: { status: 'disconnected' },
        relay: { status: 'online' },
        lastError: 'backend unavailable',
      };
    },
  });
  const server = createHttpServer({ provider: sessionService, publicDir: join(pocDir, 'public') });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const jsResponse = await fetch(`${baseUrl}/app.js`);
  const cssResponse = await fetch(`${baseUrl}/app.css`);
  const faviconResponse = await fetch(`${baseUrl}/favicon.ico`);

  assert.equal(jsResponse.status, 200);
  assert.match(jsResponse.headers.get('content-type') ?? '', /javascript/);
  assert.equal(cssResponse.status, 200);
  assert.match(cssResponse.headers.get('content-type') ?? '', /text\/css/);
  assert.equal(faviconResponse.status, 404);

  await new Promise((resolve) => server.close(resolve));
});

test('smoke script documents required codex prerequisites and README points to the PoC', () => {
  const smoke = readFileSync(join(pocDir, 'scripts', 'smoke-local.sh'), 'utf8');
  const startScript = readFileSync(join(pocDir, 'scripts', 'start-local-4533.sh'), 'utf8');
  const readme = readFileSync(join(pocDir, 'README.md'), 'utf8');
  const rootReadmePath = join(repoRoot, 'README.md');
  const rootReadme = existsSync(rootReadmePath) ? readFileSync(rootReadmePath, 'utf8') : null;

  assert.match(smoke, /codex app-server/);
  assert.match(smoke, /WEB_AGENT_PROVIDER="\$\{WEB_AGENT_PROVIDER:-codex\}"/);
  assert.match(smoke, /WEB_AGENT_PROVIDER=claude-sdk/);
  assert.match(smoke, /codex is required.*WEB_AGENT_PROVIDER=codex/i);
  assert.match(smoke, /existing Claude Code \/ Agent SDK auth/i);
  assert.match(smoke, /claude-hook-relay/);
  assert.match(smoke, /WEB_AGENT_HOOK_SECRET/);
  assert.match(smoke, /Manual verification/i);
  assert.match(smoke, /Create session/i);
  assert.match(smoke, /task\/todo progress/i);
  assert.match(smoke, /Approval/i);
  assert.match(smoke, /AskUserQuestion/i);
  assert.match(smoke, /Refresh recovery/i);
  assert.match(smoke, /Interrupt/i);
  assert.match(startScript, /RELAY_HOST="\$\{RELAY_HOST:-0\.0\.0\.0\}"/);
  assert.match(startScript, /RELAY_PORT="\$\{RELAY_PORT:-4533\}"/);
  assert.match(startScript, /CODEX_APP_SERVER_PORT="\$\{CODEX_APP_SERVER_PORT:-4534\}"/);
  assert.match(startScript, /CODEX_APPROVAL_POLICY="\$\{CODEX_APPROVAL_POLICY:-on-request\}"/);
  assert.match(startScript, /WEB_AGENT_AUTH_PASSWORD="\$\{WEB_AGENT_AUTH_PASSWORD:-\}"/);
  assert.match(startScript, /exec node \.\/src\/server\.js/);
  assert.match(readme, /npm install/);
  if (rootReadme) {
    assert.match(rootReadme, /web-agent-console-codex/);
  }
});

test('smoke script allows claude-sdk startup without forcing ANTHROPIC_API_KEY', async () => {
  const scriptPath = join(pocDir, 'scripts', 'smoke-local.sh');
  const { stdout, stderr } = await execFileAsync('bash', [scriptPath], {
    cwd: pocDir,
    env: {
      ...process.env,
      WEB_AGENT_PROVIDER: 'claude-sdk',
      ANTHROPIC_API_KEY: '',
    },
  });

  assert.equal(stderr, '');
  assert.match(stdout, /Preparing Claude SDK Web Console PoC smoke run/);
  assert.match(stdout, /Smoke run passed\. Relay is ready/);
  assert.match(stdout, /claude-hook-relay/);
  assert.match(stdout, /WEB_AGENT_HOOK_SECRET/);
});

test('local start script prints help with sandbox and approval options', async () => {
  const scriptPath = join(pocDir, 'scripts', 'start-local-4533.sh');
  const { stdout, stderr } = await execFileAsync('bash', [scriptPath, '--help'], {
    cwd: pocDir,
    env: {
      ...process.env,
      WEB_AGENT_AUTH_PASSWORD: '',
    },
  });

  assert.equal(stderr, '');
  assert.match(stdout, /Usage:\s+\.\/scripts\/start-local-4533\.sh \[options\]/);
  assert.match(stdout, /--approval <policy>/);
  assert.match(stdout, /--sandbox <mode>/);
  assert.match(stdout, /auth\s+= disabled unless WEB_AGENT_AUTH_PASSWORD is set/);
  assert.match(stdout, /on-request\s+Let Codex decide when to route approval to the frontend/);
  assert.match(stdout, /never\s+Never ask for approval; execution failures return directly to Codex/);
  assert.match(stdout, /read-only\s+No filesystem writes allowed/);
  assert.match(stdout, /workspace-write\s+Allow writes in the workspace but keep sandboxing/);
  assert.match(stdout, /danger-full-access\s+Disable sandbox restrictions entirely/);
});

test('convergence guardrails remove session-service compatibility shells from transport and providers', () => {
  const httpServerSource = readFileSync(join(pocDir, 'src', 'lib', 'http-server.js'), 'utf8');
  const serverSource = readFileSync(join(pocDir, 'src', 'server.js'), 'utf8');
  const claudeProviderSource = readFileSync(
    join(pocDir, 'src', 'lib', 'claude-sdk-provider.js'),
    'utf8',
  );
  const codexProviderSource = readFileSync(join(pocDir, 'src', 'lib', 'codex-provider.js'), 'utf8');
  const providerFactorySource = readFileSync(
    join(pocDir, 'src', 'lib', 'provider-factory.js'),
    'utf8',
  );

  assert.doesNotMatch(httpServerSource, /\bsessionService\b/);
  assert.doesNotMatch(httpServerSource, /typeof sessionService\./);
  assert.match(serverSource, /createHttpServer\(\{\s*provider,/);
  assert.doesNotMatch(serverSource, /sessionService:\s*provider/);
  assert.doesNotMatch(claudeProviderSource, /sessionService\.[^(]+\?\./);
  assert.doesNotMatch(codexProviderSource, /sessionService\.[^(]+\?\./);
  assert.doesNotMatch(providerFactorySource, /new SessionService\(/);
});

function createStubSessionService() {
  return toHttpProvider({
    getIngressRoutes() {
      return [];
    },
    async listProjects() {
      return {
        projects: [
          {
            cwd: '/tmp/workspace-a',
            displayName: 'workspace-a',
            collapsed: false,
            focusedSessions: [{ id: 'thread-1', name: 'Focused thread', updatedAt: 5 }],
            historySessions: {
              active: [],
              archived: [],
            },
          },
        ],
      };
    },
    async readSession(threadId) {
      return {
        thread: {
          id: threadId,
          name: 'Focused thread',
          cwd: '/tmp/workspace-a',
          turns: [],
        },
      };
    },
    async getStatus() {
      return {
        overall: 'connected',
        backend: { status: 'connected' },
        relay: { status: 'online' },
        requests: { status: 'idle' },
        lastError: null,
      };
    },
    subscribe() {
      return () => {};
    },
  });
}

function toHttpProvider(service = {}) {
  const defaultMethods = {
    getStatus() {
      return {
        overall: 'connected',
        backend: { status: 'connected' },
        relay: { status: 'online' },
        requests: { status: 'idle' },
        lastError: null,
      };
    },
    getIngressRoutes() {
      return [];
    },
    subscribe() {
      return () => {};
    },
  };

  return new Proxy(service, {
    get(target, prop, receiver) {
      if (prop in target) {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }

      const fallback = defaultMethods[prop];
      return typeof fallback === 'function' ? fallback.bind(defaultMethods) : fallback;
    },
  });
}
