import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeCodexServer } from './helpers/fake-codex-app-server.js';
import { JsonRpcClient } from '../src/lib/json-rpc-client.js';
import { SessionService } from '../src/lib/session-service.js';
import { CodexSessionService } from '../src/lib/codex-session-service.js';
import { createProvider } from '../src/lib/provider-factory.js';
import { getConfig } from '../src/config.js';

test('codex session service extends the shared session service core', async () => {
  const fakeServer = await createFakeCodexServer();
  const client = new JsonRpcClient(fakeServer.url);
  await client.connect();

  try {
    const service = new CodexSessionService({ client });
    const list = await service.listSessions();

    assert.equal(service instanceof SessionService, true);
    assert.equal(list.data[0].id, 'thread-1');
  } finally {
    await client.close();
    await fakeServer.close();
  }
});

test('provider factory wires the default codex provider through CodexSessionService', () => {
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

  assert.equal(provider.sessionService instanceof CodexSessionService, true);
});
