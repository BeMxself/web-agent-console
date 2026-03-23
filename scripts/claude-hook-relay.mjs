#!/usr/bin/env node

const DEFAULT_RELAY_PORT = 4318;

class RelayError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RelayError';
  }
}

try {
  const payloadText = await readStdin();
  if (!payloadText.trim()) {
    throw new RelayError('missing_payload');
  }

  let payload = null;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    throw new RelayError('invalid_json');
  }

  const relayUrl = resolveRelayUrl(process.env);
  const hookSecret = resolveHookSecret(process.env);
  const response = await fetch(new URL('/api/providers/claude/hooks', relayUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-web-agent-wait-for-resolution': '1',
      ...(hookSecret ? { 'x-web-agent-hook-secret': hookSecret } : {}),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new RelayError(`http_${response.status}`);
  }

  const body = await response.json().catch(() => null);
  if (body?.resolution) {
    process.stdout.write(`${JSON.stringify(body.resolution)}\n`);
  }

  process.exit(0);
} catch (error) {
  const message =
    error instanceof RelayError
      ? error.message
      : error?.name === 'TypeError'
        ? 'fetch_failed'
        : 'unexpected_failure';
  process.stderr.write(`relay_error:${message}\n`);
  process.exit(1);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  }
  return chunks.join('');
}

function resolveRelayUrl(env) {
  const explicitUrl = String(env.WEB_AGENT_RELAY_URL ?? '').trim();
  if (explicitUrl) {
    return explicitUrl;
  }

  const relayPort = Number(env.RELAY_PORT ?? DEFAULT_RELAY_PORT);
  return `http://127.0.0.1:${Number.isFinite(relayPort) && relayPort > 0 ? relayPort : DEFAULT_RELAY_PORT}`;
}

function resolveHookSecret(env) {
  const explicitSecret = String(env.WEB_AGENT_HOOK_SECRET ?? '').trim();
  if (explicitSecret) {
    return explicitSecret;
  }

  const sharedSecret = String(env.CLAUDE_HOOK_SECRET ?? '').trim();
  return sharedSecret || null;
}
