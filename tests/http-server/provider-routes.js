import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { createFakeCodexServer } from '../helpers/fake-codex-app-server.js';
import { JsonRpcClient } from '../../src/lib/json-rpc-client.js';
import { CodexSessionService } from '../../src/lib/codex-session-service.js';
import { createHttpServer } from '../../src/lib/http-server.js';

const testDir = fileURLToPath(new URL('..', import.meta.url));
const pocDir = join(testDir, '..');
const repoRoot = join(pocDir, '..', '..');
const execFileAsync = promisify(execFile);

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
        sandboxModeOptions: [
          { value: 'read-only', label: '只读' },
          { value: 'workspace-write', label: '工作区可写' },
          { value: 'danger-full-access', label: '完全访问' },
        ],
        defaults: {
          model: null,
          reasoningEffort: null,
          sandboxMode: 'danger-full-access',
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
        sandboxMode: 'workspace-write',
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
    sandboxModeOptions: [
      { value: 'read-only', label: '只读' },
      { value: 'workspace-write', label: '工作区可写' },
      { value: 'danger-full-access', label: '完全访问' },
    ],
    defaults: {
      model: null,
      reasoningEffort: null,
      sandboxMode: 'danger-full-access',
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
    sandboxMode: 'workspace-write',
  });

  const updateResponse = await fetch(`${baseUrl}/api/sessions/thread-1/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: null, reasoningEffort: 'medium', sandboxMode: 'read-only' }),
  });
  assert.equal(updateResponse.status, 200);
  assert.deepEqual(await updateResponse.json(), {
    model: null,
    reasoningEffort: 'medium',
    sandboxMode: 'read-only',
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
        sandboxMode: 'read-only',
      },
    },
  ]);

  await new Promise((resolve) => server.close(resolve));
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
