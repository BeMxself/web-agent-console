import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const testDir = dirname(fileURLToPath(import.meta.url));
const pocDir = join(testDir, '..');
const relayScriptPath = join(pocDir, 'scripts', 'claude-hook-relay.mjs');

test('claude hook relay forwards stdin JSON to the local bridge endpoint', async () => {
  let requestSnapshot = null;
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      requestSnapshot = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: JSON.parse(body || '{}'),
      };
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accepted: true }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const relayUrl = `http://127.0.0.1:${address.port}`;

  try {
    const result = await runRelay({
      stdin: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'external-session-1',
        cwd: '/tmp/workspace-a',
      }),
      env: {
        ...process.env,
        WEB_AGENT_RELAY_URL: relayUrl,
        WEB_AGENT_HOOK_SECRET: 'test-secret',
      },
    });

    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.deepEqual(requestSnapshot, {
      method: 'POST',
      url: '/api/providers/claude/hooks',
      headers: {
        ...requestSnapshot?.headers,
        host: requestSnapshot?.headers?.host,
        'content-type': 'application/json',
        'x-web-agent-hook-secret': 'test-secret',
      },
      body: {
        hook_event_name: 'SessionStart',
        session_id: 'external-session-1',
        cwd: '/tmp/workspace-a',
      },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('claude hook relay exits non-zero with a short machine-readable error when forwarding fails', () => {
  const resultPromise = runRelay({
    stdin: JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: 'external-session-2',
    }),
    env: {
      ...process.env,
      WEB_AGENT_RELAY_URL: 'http://127.0.0.1:1',
      WEB_AGENT_HOOK_SECRET: 'test-secret',
    },
  });

  return resultPromise.then((result) => {
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^relay_error:/);
  });
});

async function runRelay({ stdin, env }) {
  const child = spawn(process.execPath, [relayScriptPath], {
    cwd: pocDir,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  child.stdin.end(stdin);

  const status = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('relay timed out'));
    }, 5000);

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });

  return {
    status,
    stdout,
    stderr,
  };
}
