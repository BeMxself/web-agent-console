const SUPPORTED_CLAUDE_HOOK_EVENTS = new Set([
  'SessionStart',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'Elicitation',
  'ElicitationResult',
  'Stop',
  'StopFailure',
]);

export class ClaudeExternalSessionBridge {
  ingest(payload) {
    const event = normalizeBridgePayload(payload);
    if (event.provider !== 'claude') {
      return {
        accepted: false,
        provider: event.provider,
      };
    }

    if (!SUPPORTED_CLAUDE_HOOK_EVENTS.has(event.hookEventName)) {
      return {
        accepted: false,
        provider: event.provider,
        ignored: true,
        reason: 'unsupported_hook_event',
      };
    }

    return {
      accepted: true,
      provider: event.provider,
      event,
    };
  }
}

export function createExternalTurnId(sessionId) {
  return `external-turn-${normalizeIdentifier(sessionId) || 'unknown'}`;
}

export function createExternalApprovalId(event) {
  return `external-approval-${normalizeIdentifier(event.sessionId)}-${normalizeIdentifier(
    event.toolUseId ?? event.toolName ?? String(Date.now()),
  )}`;
}

export function createExternalQuestionId(event) {
  return `external-question-${normalizeIdentifier(event.sessionId)}-${normalizeIdentifier(
    event.toolUseId ?? event.prompt ?? String(Date.now()),
  )}`;
}

export function summarizePermissionRequest(event) {
  if (event.toolName) {
    return `Allow ${event.toolName} usage`;
  }

  return 'Allow external Claude tool usage';
}

export function summarizeQuestion(event) {
  return event.prompt ?? 'Claude is waiting for input';
}

export function buildPermissionDetail(event) {
  return {
    toolName: event.toolName,
    transcriptPath: event.transcriptPath,
    hookEventName: event.hookEventName,
  };
}

export function normalizeEventQuestions(event) {
  if (!Array.isArray(event.options) || event.options.length === 0) {
    return [];
  }

  return [
    {
      header: 'Claude',
      question: summarizeQuestion(event),
      multiSelect: false,
      options: event.options
        .filter((option) => isPlainObject(option))
        .map((option) => ({
          label: normalizeText(option.label) ?? normalizeText(option.value) ?? '',
          description: normalizeText(option.description) ?? '',
          preview: normalizeText(option.preview),
        })),
    },
  ];
}

function normalizeBridgePayload(payload) {
  const provider = normalizeText(payload?.provider)?.toLowerCase() ?? 'claude';
  const event = isPlainObject(payload?.event) ? payload.event : {};
  return {
    provider,
    hookEventName:
      normalizeText(event.hookEventName) ??
      normalizeText(event.hook_event_name) ??
      normalizeText(event.event) ??
      null,
    sessionId:
      normalizeText(event.sessionId) ??
      normalizeText(event.session_id) ??
      null,
    cwd: normalizeText(event.cwd),
    transcriptPath:
      normalizeText(event.transcriptPath) ??
      normalizeText(event.transcript_path) ??
      null,
    toolName:
      normalizeText(event.toolName) ??
      normalizeText(event.tool_name) ??
      null,
    toolUseId:
      normalizeText(event.toolUseId) ??
      normalizeText(event.tool_use_id) ??
      null,
    prompt:
      normalizeText(event.prompt) ??
      normalizeText(event.question) ??
      normalizeText(event.message) ??
      null,
    options: Array.isArray(event.options) ? event.options : [],
    response: event.response ?? event.result ?? null,
    error:
      normalizeText(event.error) ??
      normalizeText(event.error_message) ??
      normalizeText(event.reason) ??
      null,
    waitForResolution: payload?.waitForResolution === true,
    rawEvent: event,
  };
}

function normalizeText(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function normalizeIdentifier(value) {
  return String(value ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
