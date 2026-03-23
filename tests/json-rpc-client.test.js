import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeCodexServer } from './helpers/fake-codex-app-server.js';
import { JsonRpcClient } from '../src/lib/json-rpc-client.js';

test('json-rpc client connects and receives initialize response', async () => {
  const fakeServer = await createFakeCodexServer();
  const client = new JsonRpcClient(fakeServer.url);

  await client.connect();
  const result = await client.request('initialize', {
    clientInfo: { name: 'test', version: '0.0.0' },
    capabilities: {},
  });

  assert.equal(result.protocolVersion, '2');

  await client.close();
  await fakeServer.close();
});

test('json-rpc client resolves responses and dispatches notifications', async () => {
  const fakeServer = await createFakeCodexServer({
    notifications: [
      { method: 'thread/started', params: { threadId: 'thread-1' } },
    ],
  });
  const client = new JsonRpcClient(fakeServer.url);
  const notificationPromise = new Promise((resolve) => {
    client.onNotification(resolve);
  });

  await client.connect();
  await client.request('thread/list', {});
  const notification = await notificationPromise;

  assert.equal(notification.method, 'thread/started');

  await client.close();
  await fakeServer.close();
});

test('json-rpc client rejects request promises when codex returns an error payload', async () => {
  const fakeServer = await createFakeCodexServer({
    errorByMethod: {
      'turn/start': { code: -32600, message: 'thread not found: thread-1' },
    },
  });
  const client = new JsonRpcClient(fakeServer.url);

  await client.connect();

  await assert.rejects(
    client.request('turn/start', { threadId: 'thread-1', input: [] }),
    /thread not found: thread-1/,
  );

  await client.close();
  await fakeServer.close();
});

test('json-rpc client routes server requests to registered request handlers and replies', async () => {
  const fakeServer = await createFakeCodexServer({
    serverRequests: [
      {
        id: 1,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          command: ['npm', 'test'],
          cwd: '/tmp/workspace',
        },
      },
    ],
  });
  const client = new JsonRpcClient(fakeServer.url);
  const seen = [];

  client.onRequest(async (message) => {
    seen.push(message);
    return { decision: 'approved' };
  });

  await client.connect();
  const list = await client.request('thread/list', { archived: false });
  await fakeServer.waitForResolvedRequests(1);

  assert.equal(list.data[0].id, 'thread-1');
  assert.equal(seen[0].method, 'item/commandExecution/requestApproval');
  assert.deepEqual(fakeServer.takeResolvedRequests(), [
    { id: 1, result: { decision: 'approved' } },
  ]);

  await client.close();
  await fakeServer.close();
});

test('json-rpc client responds with an error when no request handler can handle a server request', async () => {
  const fakeServer = await createFakeCodexServer({
    serverRequests: [
      {
        id: 'approval-unhandled',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          command: ['npm', 'test'],
          cwd: '/tmp/workspace',
        },
      },
    ],
  });
  const client = new JsonRpcClient(fakeServer.url);

  await client.connect();
  const list = await client.request('thread/list', { archived: false });
  await fakeServer.waitForResolvedRequests(1);

  assert.equal(list.data[0].id, 'thread-1');
  assert.deepEqual(fakeServer.takeResolvedRequests(), [
    {
      id: 'approval-unhandled',
      error: {
        code: -32601,
        message:
          'No request handler registered for item/commandExecution/requestApproval',
      },
    },
  ]);

  await client.close();
  await fakeServer.close();
});
