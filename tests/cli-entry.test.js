import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCliArgs } from '../src/lib/cli.js';
import { startWebAgentConsole } from '../src/lib/web-agent-console-runtime.js';

test('parseCliArgs maps CLI flags into environment overrides', () => {
  const parsed = parseCliArgs([
    'start',
    '--provider',
    'claude-sdk',
    '--host',
    '0.0.0.0',
    '--port',
    '4545',
    '--password',
    'demo-password',
    '--codex-bin',
    '/usr/local/bin/codex',
    '--sandbox',
    'workspace-write',
    '--approval',
    'never',
    '--open',
  ]);

  assert.equal(parsed.command, 'start');
  assert.deepEqual(parsed.env, {
    WEB_AGENT_PROVIDER: 'claude-sdk',
    RELAY_HOST: '0.0.0.0',
    RELAY_PORT: '4545',
    WEB_AGENT_AUTH_PASSWORD: 'demo-password',
    CODEX_BIN: '/usr/local/bin/codex',
    CODEX_SANDBOX_MODE: 'workspace-write',
    CODEX_APPROVAL_POLICY: 'never',
  });
  assert.equal(parsed.openBrowser, true);
  assert.equal(parsed.showHelp, false);
  assert.equal(parsed.showVersion, false);
});

test('parseCliArgs supports the doctor subcommand and safe fix flag', () => {
  const parsed = parseCliArgs(['doctor', '--fix']);

  assert.equal(parsed.command, 'doctor');
  assert.equal(parsed.fix, true);
  assert.deepEqual(parsed.env, {});
});

test('parseCliArgs supports help/version and rejects unknown flags', () => {
  assert.equal(parseCliArgs(['--help']).showHelp, true);
  assert.equal(parseCliArgs(['--version']).showVersion, true);
  assert.throws(
    () => parseCliArgs(['--wat']),
    /Unknown option: --wat/,
  );
  assert.throws(
    () => parseCliArgs(['--port', '--open']),
    /Missing value for --port/,
  );
  assert.throws(
    () => parseCliArgs(['doctor', 'wat']),
    /Unknown command: wat/,
  );
});

test('startWebAgentConsole starts the provider and listens on the configured relay port', async () => {
  const calls = [];
  const provider = {
    start: async () => {
      calls.push('provider.start');
    },
    shutdown: async () => {
      calls.push('provider.shutdown');
    },
  };
  const server = {
    listen: (port, host) => {
      calls.push(['server.listen', host, port]);
    },
    shutdown: async () => {
      calls.push('server.shutdown');
    },
  };

  const runtime = await startWebAgentConsole({
    cwd: '/tmp/runtime-workspace',
    env: {
      HOME: '/tmp/home',
      RELAY_HOST: '127.0.0.1',
      RELAY_PORT: '4777',
    },
    createProviderImpl: ({ cwd }) => {
      calls.push(['createProvider', cwd]);
      return provider;
    },
    createHttpServerImpl: () => {
      calls.push('createHttpServer');
      return server;
    },
    activityStoreFactory: () => ({ filePath: '/tmp/activity-store.json' }),
    runtimeStoreFactory: () => ({ filePath: '/tmp/runtime-store.json' }),
  });

  assert.deepEqual(calls, [
    ['createProvider', '/tmp/runtime-workspace'],
    'createHttpServer',
    'provider.start',
    ['server.listen', '127.0.0.1', 4777],
  ]);
  assert.equal(runtime.url, 'http://127.0.0.1:4777');

  await runtime.shutdown();

  assert.deepEqual(calls, [
    ['createProvider', '/tmp/runtime-workspace'],
    'createHttpServer',
    'provider.start',
    ['server.listen', '127.0.0.1', 4777],
    'provider.shutdown',
    'server.shutdown',
  ]);
});
