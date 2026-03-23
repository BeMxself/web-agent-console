import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAppServer } from '../src/lib/codex-app-server.js';

test('codex app-server manager spawns the configured binary and waits for websocket readiness', async () => {
  const manager = new CodexAppServer({
    codexBin: 'node',
    codexArgs: ['./tests/helpers/fake-codex-app-server.js', '--port', '43219'],
    port: 43219,
  });

  await manager.start();
  assert.match(manager.url, /ws:\/\/127\.0\.0\.1:43219/);
  await manager.stop();
});
