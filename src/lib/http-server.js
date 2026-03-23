import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { createAuth } from './auth.js';
import { normalizeTurnRequest } from './turn-request.js';

export function createHttpServer({ provider, publicDir, config = {} }) {
  const eventClients = new Set();
  const sockets = new Set();
  const auth = createAuth(config);
  const ingressRoutes = provider.getIngressRoutes();

  const unsubscribe = provider.subscribe((event) => {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of eventClients) {
      client.write(payload);
    }
  });

  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url) {
        res.writeHead(400).end();
        return;
      }

      const requestUrl = new URL(req.url, 'http://127.0.0.1');
      const pathname = requestUrl.pathname;
      const isAuthenticated = auth.isAuthenticated(req);

      if (req.method === 'POST' && pathname === '/api/auth/login') {
        if (!auth.enabled) {
          writeJson(res, 200, { authenticated: true, required: false });
          return;
        }

        const body = await readJsonBody(req);
        const sessionCookie = auth.createLoginCookie(body.password);
        if (!sessionCookie) {
          writeJson(res, 401, { authenticated: false, error: '密码不正确' });
          return;
        }

        res.writeHead(204, {
          'set-cookie': sessionCookie,
        });
        res.end();
        return;
      }

      if (req.method === 'GET' && pathname === '/api/auth/session') {
        if (!auth.enabled) {
          writeJson(res, 200, { authenticated: true, required: false });
          return;
        }

        if (!isAuthenticated) {
          writeJson(res, 401, { authenticated: false, required: true });
          return;
        }

        writeJson(res, 200, { authenticated: true, required: true });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/auth/logout') {
        res.writeHead(204, {
          'set-cookie': auth.createLogoutCookie(),
        });
        res.end();
        return;
      }

      const ingressRoute = findIngressRoute(ingressRoutes, req.method, pathname);
      if (ingressRoute) {
        if (auth.enabled && ingressRoute.allowUnauthenticated !== true && !isAuthenticated) {
          writeJson(res, 401, { error: 'Authentication required', authenticated: false });
          return;
        }

        const routeResult = await ingressRoute.handle({
          req,
          res,
          pathname,
          requestUrl,
          config,
          provider,
          readJsonBody: () => readJsonBody(req),
          writeJson: (statusCode, body) => writeJson(res, statusCode, body),
          createHttpError,
          assertLocalLoopback: (errorMessage) => assertLocalLoopback(req, errorMessage),
          assertHeaderValue: ({ headerName, expectedValue, errorMessage }) =>
            assertHeaderValue(req, headerName, expectedValue, errorMessage),
        });

        if (!res.writableEnded) {
          if (routeResult === undefined) {
            res.writeHead(204).end();
          } else if (
            routeResult &&
            typeof routeResult === 'object' &&
            Object.prototype.hasOwnProperty.call(routeResult, 'body')
          ) {
            writeJson(res, routeResult.statusCode ?? 200, routeResult.body);
          } else {
            writeJson(res, 200, routeResult);
          }
        }

        return;
      }

      if (auth.enabled && pathname.startsWith('/api/') && !isAuthenticated) {
        writeJson(res, 401, { error: 'Authentication required', authenticated: false });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/sessions') {
        const data = await provider.listProjects();
        writeJson(res, 200, data);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/status') {
        const data = await provider.getStatus();
        writeJson(res, 200, data);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/approval-mode') {
        const data = await provider.getApprovalMode();
        writeJson(res, 200, data);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/session-options') {
        const data = await provider.getSessionOptions();
        writeJson(res, 200, data);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/approval-mode') {
        const body = await readJsonBody(req);
        const data = await provider.setApprovalMode(body.mode);
        writeJson(res, 200, data);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/projects') {
        const body = await readJsonBody(req);
        const data = await provider.addProject(body.cwd);
        writeJson(res, 201, data);
        return;
      }

      if (req.method === 'GET' && /^\/api\/sessions\/[^/]+$/.test(pathname)) {
        const sessionId = decodeURIComponent(pathname.slice('/api/sessions/'.length));
        const data = await provider.readSession(sessionId);
        writeJson(res, 200, data);
        return;
      }

      if (req.method === 'GET' && /^\/api\/sessions\/[^/]+\/settings$/.test(pathname)) {
        const sessionId = decodeURIComponent(pathname.split('/')[3]);
        const data = await provider.getSessionSettings(sessionId);
        writeJson(res, 200, data);
        return;
      }

      if (req.method === 'POST' && /^\/api\/sessions\/[^/]+\/settings$/.test(pathname)) {
        const sessionId = decodeURIComponent(pathname.split('/')[3]);
        const body = await readJsonBody(req);
        const settings = {
          model: body.model ?? null,
          reasoningEffort: body.reasoningEffort ?? null,
          agentType: body.agentType ?? null,
        };
        if (Object.prototype.hasOwnProperty.call(body, 'sandboxMode')) {
          settings.sandboxMode = body.sandboxMode ?? null;
        }

        const data = await provider.setSessionSettings(sessionId, settings);
        writeJson(res, 200, data);
        return;
      }

      if (req.method === 'POST' && /^\/api\/sessions\/[^/]+\/turns$/.test(pathname)) {
        const sessionId = decodeURIComponent(pathname.split('/')[3]);
        const body = await readJsonBody(req);
        const turnRequest = normalizeTurnRequest(body);
        const data = await provider.startTurn(sessionId, turnRequest);
        writeJson(res, 202, data);
        return;
      }

      if (req.method === 'POST' && /^\/api\/sessions\/[^/]+\/name$/.test(pathname)) {
        const sessionId = decodeURIComponent(pathname.split('/')[3]);
        const body = await readJsonBody(req);
        const data = await provider.renameSession(sessionId, body.name);
        writeJson(res, 200, data);
        return;
      }

      if (req.method === 'POST' && /^\/api\/sessions\/[^/]+\/interrupt$/.test(pathname)) {
        const sessionId = decodeURIComponent(pathname.split('/')[3]);
        const body = await readJsonBody(req);
        const data = await provider.interruptTurn(sessionId, body.turnId);
        writeJson(res, 202, data);
        return;
      }

      if (req.method === 'POST' && /^\/api\/approvals\/[^/]+\/approve$/.test(pathname)) {
        const approvalId = decodeURIComponent(pathname.split('/')[3]);
        const data = await provider.approveRequest(approvalId);
        writeJson(res, 200, data);
        return;
      }

      if (req.method === 'POST' && /^\/api\/approvals\/[^/]+\/deny$/.test(pathname)) {
        const approvalId = decodeURIComponent(pathname.split('/')[3]);
        const data = await provider.denyRequest(approvalId);
        writeJson(res, 200, data);
        return;
      }

      if (req.method === 'POST' && /^\/api\/pending-actions\/[^/]+\/respond$/.test(pathname)) {
        const pendingActionId = decodeURIComponent(pathname.split('/')[3]);
        const body = await readJsonBody(req);
        const data = await provider.resolvePendingAction(pendingActionId, body);
        writeJson(res, 200, data);
        return;
      }

      if (req.method === 'POST' && /^\/api\/projects\/[^/]+\/focused-sessions$/.test(pathname)) {
        const projectId = decodeURIComponent(pathname.split('/')[3]);
        const body = await readJsonBody(req);
        const data = await provider.addFocusedSession(projectId, body.threadId);
        writeJson(res, 200, data);
        return;
      }

      if (req.method === 'POST' && /^\/api\/projects\/[^/]+\/sessions$/.test(pathname)) {
        const projectId = decodeURIComponent(pathname.split('/')[3]);
        const data = await provider.createSessionInProject(projectId);
        writeJson(res, 201, data);
        return;
      }

      if (req.method === 'DELETE' && /^\/api\/projects\/[^/]+$/.test(pathname)) {
        const projectId = decodeURIComponent(pathname.split('/')[3]);
        const data = await provider.closeProject(projectId);
        writeJson(res, 200, data);
        return;
      }

      if (req.method === 'DELETE' && /^\/api\/projects\/[^/]+\/focused-sessions\/[^/]+$/.test(pathname)) {
        const parts = pathname.split('/');
        const projectId = decodeURIComponent(parts[3]);
        const threadId = decodeURIComponent(parts[5]);
        const data = await provider.removeFocusedSession(projectId, threadId);
        writeJson(res, 200, data);
        return;
      }

      if (req.method === 'POST' && /^\/api\/projects\/[^/]+\/collapse$/.test(pathname)) {
        const projectId = decodeURIComponent(pathname.split('/')[3]);
        const body = await readJsonBody(req);
        const data = await provider.setProjectCollapsed(projectId, body.collapsed);
        writeJson(res, 200, data);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write('\n');
        eventClients.add(res);
        req.on('close', () => {
          eventClients.delete(res);
        });
        return;
      }

      if (req.method === 'GET' && publicDir) {
        const assetPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        const filePath = join(publicDir, assetPath);
        const file = await readFile(filePath).catch((error) => {
          if (error.code === 'ENOENT') {
            return null;
          }

          throw error;
        });
        if (!file) {
          res.writeHead(404).end();
          return;
        }

        res.writeHead(200, {
          'content-type': getContentType(filePath),
        });
        res.end(file);
        return;
      }

      res.writeHead(404).end();
    } catch (error) {
      writeJson(res, error?.statusCode ?? 500, { error: error.message });
    }
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
  });

  server.once('close', () => {
    unsubscribe();
  });

  server.shutdown = async () => {
    for (const client of eventClients) {
      client.end();
    }

    await new Promise((resolve) => {
      server.close(resolve);

      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
        return;
      }

      for (const socket of sockets) {
        socket.destroy();
      }
    });
  };

  return server;
}

function assertLocalLoopback(
  req,
  errorMessage = 'Ingress route only accepts local loopback traffic',
) {
  if (isLoopbackAddress(req.socket.remoteAddress ?? null)) {
    return;
  }

  throw createHttpError(403, errorMessage);
}

function assertHeaderValue(req, headerName, expectedValue, errorMessage = 'Invalid request header') {
  if (!expectedValue) {
    return;
  }

  const actualValue = req.headers[headerName];
  if (actualValue === expectedValue) {
    return;
  }

  throw createHttpError(403, errorMessage);
}

function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function findIngressRoute(routes, method, path) {
  return routes.find((route) => route.method === method && route.path === path) ?? null;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function writeJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function getContentType(filePath) {
  switch (extname(filePath)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.ico':
      return 'image/x-icon';
    default:
      return 'application/octet-stream';
  }
}
