import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'node:url';

export async function createFakeCodexServer(options = {}) {
  const notifications = options.notifications ?? [];
  const serverRequests = options.serverRequests ?? [];
  const errorByMethod = options.errorByMethod ?? {};
  const resolvedRequests = [];
  const receivedRequests = [];
  const resolvedRequestWaiters = new Set();
  const threads = options.threads ?? [
    {
      id: 'thread-1',
      preview: 'hello from codex',
      ephemeral: false,
      modelProvider: 'openai',
      createdAt: 1,
      updatedAt: 1,
      status: { type: 'notLoaded' },
      path: null,
      cwd: '/tmp/workspace',
      cliVersion: '0.114.0',
      source: 'appServer',
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: 'Thread 1',
      turns: [],
    },
  ];
  const server = new WebSocketServer({ port: options.port ?? 0 });
  const sockets = new Set();
  let didSendServerRequests = false;

  function sendFollowUpMessages(socket) {
    if (!didSendServerRequests && serverRequests.length > 0) {
      didSendServerRequests = true;
      for (const serverRequest of serverRequests) {
        socket.send(JSON.stringify({ jsonrpc: '2.0', ...serverRequest }));
      }
    }

    for (const notification of notifications) {
      socket.send(JSON.stringify({ jsonrpc: '2.0', ...notification }));
    }
  }

  function notifyResolvedRequestWaiters() {
    for (const waiter of [...resolvedRequestWaiters]) {
      if (resolvedRequests.length < waiter.count) {
        continue;
      }

      clearTimeout(waiter.timeoutId);
      resolvedRequestWaiters.delete(waiter);
      waiter.resolve([...resolvedRequests]);
    }
  }

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => {
      sockets.delete(socket);
    });

    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (typeof message.method === 'undefined' && typeof message.id !== 'undefined') {
        if (Object.prototype.hasOwnProperty.call(message, 'result')) {
          resolvedRequests.push({ id: message.id, result: message.result });
        } else if (Object.prototype.hasOwnProperty.call(message, 'error')) {
          resolvedRequests.push({ id: message.id, error: message.error });
        }
        notifyResolvedRequestWaiters();
        return;
      }

      receivedRequests.push({
        id: message.id,
        method: message.method,
        params: message.params,
      });

      if (errorByMethod[message.method]) {
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            error: errorByMethod[message.method],
          }),
        );
        return;
      }

      if (message.method === 'initialize') {
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { protocolVersion: '2' },
          }),
        );
      } else if (message.method === 'thread/list') {
        sendFollowUpMessages(socket);
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { data: threads.map((thread) => ({ ...thread, turns: [] })), nextCursor: null },
          }),
        );
      } else if (message.method === 'thread/read') {
        const thread = threads.find((entry) => entry.id === message.params.threadId);
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { thread },
          }),
        );
      } else if (message.method === 'thread/start') {
        const thread = {
          id: `thread-${threads.length + 1}`,
          preview: 'new thread',
          ephemeral: false,
          modelProvider: 'openai',
          createdAt: 2,
          updatedAt: 2,
          status: { type: 'loaded' },
          path: null,
          cwd: message.params.cwd ?? '/tmp/workspace',
          cliVersion: '0.114.0',
          source: 'appServer',
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: 'New Thread',
          turns: [],
        };
        threads.push(thread);
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { thread },
          }),
        );
      } else if (message.method === 'thread/resume') {
        const thread = threads.find((entry) => entry.id === message.params.threadId);
        thread.status = { type: 'loaded' };
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { thread },
          }),
        );
      } else if (message.method === 'turn/start') {
        const thread = threads.find((entry) => entry.id === message.params.threadId);
        if (!thread || thread.status?.type === 'notLoaded') {
          socket.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              error: {
                code: -32600,
                message: `thread not found: ${message.params.threadId}`,
              },
            }),
          );
          return;
        }
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { turnId: 'turn-2', status: 'started' },
          }),
        );
      } else if (message.method === 'turn/interrupt') {
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { interrupted: true },
          }),
        );
      } else {
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { ok: true },
          }),
        );
      }

      if (message.method !== 'thread/list') {
        sendFollowUpMessages(socket);
      }
    });
  });

  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();

  return {
    url: `ws://127.0.0.1:${address.port}`,
    waitForResolvedRequests: (count = 1, timeoutMs = 1000) => {
      if (resolvedRequests.length >= count) {
        return Promise.resolve([...resolvedRequests]);
      }

      return new Promise((resolve, reject) => {
        const waiter = {
          count,
          resolve,
          timeoutId: setTimeout(() => {
            resolvedRequestWaiters.delete(waiter);
            reject(new Error(`Timed out waiting for ${count} resolved request(s)`));
          }, timeoutMs),
        };
        resolvedRequestWaiters.add(waiter);
      });
    },
    takeResolvedRequests: () => {
      const snapshot = [...resolvedRequests];
      resolvedRequests.length = 0;
      return snapshot;
    },
    takeReceivedRequests: () => {
      const snapshot = [...receivedRequests];
      receivedRequests.length = 0;
      return snapshot;
    },
    close: async () => {
      for (const waiter of resolvedRequestWaiters) {
        clearTimeout(waiter.timeoutId);
        waiter.resolve([...resolvedRequests]);
      }
      resolvedRequestWaiters.clear();
      for (const socket of sockets) {
        socket.close();
      }
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function runFromCli() {
  const portFlagIndex = process.argv.indexOf('--port');
  const port = portFlagIndex === -1 ? 0 : Number(process.argv[portFlagIndex + 1]);
  await createFakeCodexServer({ port });
}

const entryPath = fileURLToPath(import.meta.url);
if (process.argv[1] === entryPath) {
  await runFromCli();
}
