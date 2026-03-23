import { createHash } from 'node:crypto';
import { join } from 'node:path';

export function getConfig(env = process.env) {
  const codexHome = env.CODEX_HOME ?? join(env.HOME ?? '.', '.codex');
  const authPassword = normalizeOptionalString(env.WEB_AGENT_AUTH_PASSWORD);
  const authEnabled = Boolean(authPassword);

  return {
    provider: normalizeProvider(env.WEB_AGENT_PROVIDER ?? env.PROVIDER ?? 'codex'),
    codexBin: env.CODEX_BIN ?? 'codex',
    codexSandboxMode: normalizeOptionalString(env.CODEX_SANDBOX_MODE) ?? 'danger-full-access',
    codexApprovalPolicy: normalizeOptionalString(env.CODEX_APPROVAL_POLICY) ?? 'on-request',
    relayHost: normalizeOptionalString(env.RELAY_HOST) ?? '127.0.0.1',
    relayPort: Number(env.RELAY_PORT ?? 4318),
    codexPort: Number(env.CODEX_APP_SERVER_PORT ?? 4321),
    agentApiBaseUrl: env.AGENT_API_BASE_URL ?? null,
    claudeHookSecret: normalizeOptionalString(env.CLAUDE_HOOK_SECRET),
    claudeSessionIndexPath:
      env.CLAUDE_SESSION_INDEX_PATH ?? join(codexHome, 'web-agent-console', 'claude-session-index.json'),
    activityStorePath: env.ACTIVITY_STORE_PATH ?? join(codexHome, 'web-agent-console', 'activity-store.json'),
    runtimeStorePath: env.RUNTIME_STORE_PATH ?? join(codexHome, 'web-agent-console', 'runtime-store.json'),
    authEnabled,
    authPassword,
    authCookieSecret:
      normalizeOptionalString(env.WEB_AGENT_AUTH_SECRET) ??
      (authEnabled ? createHash('sha256').update(`web-agent-console:${authPassword}`).digest('hex') : null),
  };
}

function normalizeProvider(provider) {
  const normalized = String(provider ?? 'codex')
    .trim()
    .toLowerCase();
  if (normalized === 'agent-api') {
    return 'agentapi';
  }

  return normalized || 'codex';
}

function normalizeOptionalString(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}
