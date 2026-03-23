import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexRuntime } from '../src/lib/codex-runtime.js';

test('codex runtime retries a request by reconnecting before restarting the backend', async () => {
  const appServerCalls = [];
  const clientCalls = [];
  let managedRunning = false;
  const appServer = {
    isManagedProcessRunning() {
      return managedRunning;
    },
    async start() {
      appServerCalls.push('start');
      managedRunning = true;
    },
    async stop() {
      if (!managedRunning) {
        return;
      }
      appServerCalls.push('stop');
      managedRunning = false;
    },
  };

  const client = {
    connected: false,
    isConnected() {
      return this.connected;
    },
    async connect() {
      clientCalls.push('connect');
      this.connected = true;
    },
    async close() {
      clientCalls.push('close');
      this.connected = false;
    },
    async request(method) {
      clientCalls.push(`request:${method}`);
      return { ok: true };
    },
  };

  let listProjectsCalls = 0;
  const runtime = new CodexRuntime({
    appServer,
    client,
    initializeParams: {
      clientInfo: { name: 'web-agent-console-codex', version: '0.0.0' },
      capabilities: {},
    },
    sessionService: {
      subscribe() {
        return () => {};
      },
      async markActiveSessionsInterrupted() {},
      async refreshExternalRuntimeSnapshots() {},
      async listProjects() {
        listProjectsCalls += 1;
        if (listProjectsCalls === 1) {
          client.connected = false;
          throw new Error('WebSocket is not open: readyState 3 (CLOSED)');
        }

        return { projects: [{ id: '/tmp/workspace-a' }] };
      },
    },
  });

  await runtime.start();
  const result = await runtime.listProjects();

  assert.deepEqual(result.projects, [{ id: '/tmp/workspace-a' }]);
  assert.equal(listProjectsCalls, 2);
  assert.equal(appServerCalls.filter((call) => call === 'start').length, 1);
  assert.equal(appServerCalls.filter((call) => call === 'stop').length, 0);
  assert.equal(clientCalls.filter((call) => call === 'connect').length, 2);
  assert.equal(clientCalls.filter((call) => call === 'request:initialize').length, 2);
  assert.equal(runtime.getStatus().backend.status, 'connected');
});

test('codex runtime restarts the managed app-server and reconciles inflight sessions when reconnect fails', async () => {
  const appServerCalls = [];
  const clientCalls = [];
  let managedRunning = false;
  let connectAttempts = 0;
  const appServer = {
    isManagedProcessRunning() {
      return managedRunning;
    },
    async start() {
      appServerCalls.push('start');
      managedRunning = true;
    },
    async stop() {
      if (!managedRunning) {
        return;
      }
      appServerCalls.push('stop');
      managedRunning = false;
    },
  };

  const client = {
    connected: false,
    isConnected() {
      return this.connected;
    },
    async connect() {
      clientCalls.push('connect');
      connectAttempts += 1;
      if (connectAttempts === 2) {
        throw new Error('connect ECONNREFUSED 127.0.0.1:4321');
      }
      this.connected = true;
    },
    async close() {
      clientCalls.push('close');
      this.connected = false;
    },
    async request(method) {
      clientCalls.push(`request:${method}`);
      return { ok: true };
    },
  };

  let listProjectsCalls = 0;
  const reconciliationCalls = [];
  const runtime = new CodexRuntime({
    appServer,
    client,
    initializeParams: {
      clientInfo: { name: 'web-agent-console-codex', version: '0.0.0' },
      capabilities: {},
    },
    sessionService: {
      subscribe() {
        return () => {};
      },
      async markActiveSessionsInterrupted(reason) {
        reconciliationCalls.push(reason);
      },
      async refreshExternalRuntimeSnapshots() {},
      async listProjects() {
        listProjectsCalls += 1;
        if (listProjectsCalls === 1) {
          client.connected = false;
          throw new Error('WebSocket is not open: readyState 3 (CLOSED)');
        }

        return { projects: [{ id: '/tmp/workspace-a' }] };
      },
    },
  });

  await runtime.start();
  const result = await runtime.listProjects();

  assert.deepEqual(result.projects, [{ id: '/tmp/workspace-a' }]);
  assert.deepEqual(reconciliationCalls, ['app-server restarted', 'app-server restarted']);
  assert.equal(appServerCalls.filter((call) => call === 'start').length, 2);
  assert.equal(appServerCalls.filter((call) => call === 'stop').length, 1);
});

test('codex runtime exposes disconnected status when recovery fails', async () => {
  const runtime = new CodexRuntime({
    appServer: {
      async start() {
        throw new Error('codex binary not available');
      },
      async stop() {},
    },
    client: {
      isConnected() {
        return false;
      },
      async connect() {},
      async close() {},
      async request() {
        return { ok: true };
      },
    },
    initializeParams: {
      clientInfo: { name: 'web-agent-console-codex', version: '0.0.0' },
      capabilities: {},
    },
    sessionService: {
      subscribe() {
        return () => {};
      },
      async markActiveSessionsInterrupted() {},
      async refreshExternalRuntimeSnapshots() {},
    },
  });

  await assert.rejects(runtime.start(), /codex binary not available/);

  const status = runtime.getStatus();
  assert.equal(status.backend.status, 'disconnected');
  assert.match(status.lastError, /codex binary not available/);
});

test('codex runtime status polling asks the session service to refresh external rollout runtimes', async () => {
  let refreshCalls = 0;
  const runtime = new CodexRuntime({
    appServer: {
      isManagedProcessRunning() {
        return true;
      },
      async start() {},
      async stop() {},
    },
    client: {
      isConnected() {
        return true;
      },
      async connect() {},
      async close() {},
      async request() {
        return { ok: true };
      },
    },
    initializeParams: {
      clientInfo: { name: 'web-agent-console-codex', version: '0.0.0' },
      capabilities: {},
    },
    sessionService: {
      subscribe() {
        return () => {};
      },
      async markActiveSessionsInterrupted() {},
      async refreshExternalRuntimeSnapshots() {
        refreshCalls += 1;
      },
    },
  });

  runtime.backendStatus = 'connected';
  runtime.getStatus();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(refreshCalls, 1);
});
