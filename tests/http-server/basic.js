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
    async branchFromQuestion(threadId, userMessageId, text) {
      calls.push({ method: 'branchFromQuestion', threadId, userMessageId, text });
      return {
        thread: {
          id: 'thread-branch',
          cwd: '/tmp/workspace-a',
          name: 'Branched thread',
        },
        turnId: 'turn-branch',
        status: 'started',
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

  const branchResponse = await fetch(`${baseUrl}/api/sessions/thread-1/branch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userMessageId: 'user-msg-1:0', text: 'Edited question' }),
  });
  assert.equal(branchResponse.status, 202);
  const branchBody = await branchResponse.json();
  assert.equal(branchBody.thread.id, 'thread-branch');
  assert.equal(branchBody.turnId, 'turn-branch');

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
    {
      method: 'branchFromQuestion',
      threadId: 'thread-1',
      userMessageId: 'user-msg-1:0',
      text: 'Edited question',
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
