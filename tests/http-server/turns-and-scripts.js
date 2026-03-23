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
      agentType: 'plan',
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
        agentType: 'plan',
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
      agentType: 'default',
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
        agentType: 'default',
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
