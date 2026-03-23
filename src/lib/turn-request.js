export function normalizeTurnRequest(body) {
  if (!isObject(body)) {
    throw createTurnRequestError('Turn request body must be a JSON object');
  }

  const normalized = {
    text: normalizeTurnText(body.text),
    model: normalizeOptionalString(body.model),
    reasoningEffort: normalizeOptionalString(body.reasoningEffort),
    attachments: normalizeTurnAttachments(body.attachments),
  };

  const sandboxMode = normalizeOptionalSandboxMode(body.sandboxMode);
  if (sandboxMode) {
    normalized.sandboxMode = sandboxMode;
  }

  return normalized;
}

export function normalizeTurnRequestInput(turnRequestOrText, settings = null) {
  if (typeof turnRequestOrText === 'string') {
    const normalized = {
      text: turnRequestOrText,
      model: normalizeLegacySessionModel(settings?.model),
      reasoningEffort: normalizeLegacySessionReasoningEffort(settings?.reasoningEffort),
      attachments: [],
    };

    const sandboxMode = normalizeLegacySessionSandboxMode(settings?.sandboxMode);
    if (sandboxMode) {
      normalized.sandboxMode = sandboxMode;
    }

    return normalized;
  }

  return normalizeTurnRequest(turnRequestOrText);
}

export function normalizeTurnAttachment(input, index = 0) {
  if (!isObject(input)) {
    throw createTurnRequestError(`attachments[${index}] must be an object`);
  }

  const name = normalizeRequiredString(input.name, `attachments[${index}].name`);
  const mimeType = normalizeRequiredString(input.mimeType, `attachments[${index}].mimeType`);
  const dataBase64 = normalizeRequiredString(input.dataBase64, `attachments[${index}].dataBase64`);
  const size = normalizeAttachmentSize(input.size, `attachments[${index}].size`);

  return {
    name,
    mimeType,
    size,
    dataBase64,
  };
}

function normalizeTurnText(value) {
  if (typeof value !== 'string') {
    throw createTurnRequestError('text must be a string');
  }

  return value;
}

function normalizeTurnAttachments(value) {
  if (value == null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw createTurnRequestError('attachments must be an array');
  }

  return value.map((attachment, index) => normalizeTurnAttachment(attachment, index));
}

function normalizeOptionalString(value) {
  if (value == null || value === '') {
    return null;
  }

  if (typeof value !== 'string') {
    throw createTurnRequestError('optional turn setting values must be strings or null');
  }

  return value;
}

function normalizeLegacySessionModel(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function normalizeLegacySessionReasoningEffort(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'xhigh') {
    return normalized;
  }

  return null;
}

function normalizeLegacySessionSandboxMode(value) {
  const normalized = String(value ?? '').trim();
  if (
    normalized === 'read-only' ||
    normalized === 'workspace-write' ||
    normalized === 'danger-full-access'
  ) {
    return normalized;
  }

  return null;
}

function normalizeOptionalSandboxMode(value) {
  if (value == null || value === '') {
    return null;
  }

  if (typeof value !== 'string') {
    throw createTurnRequestError('optional turn setting values must be strings or null');
  }

  const normalized = value.trim();
  if (
    normalized === 'read-only' ||
    normalized === 'workspace-write' ||
    normalized === 'danger-full-access'
  ) {
    return normalized;
  }

  return null;
}

function normalizeRequiredString(value, fieldName) {
  if (typeof value !== 'string' || value.length === 0) {
    throw createTurnRequestError(`${fieldName} must be a non-empty string`);
  }

  return value;
}

function normalizeAttachmentSize(value, fieldName) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw createTurnRequestError(`${fieldName} must be a non-negative integer`);
  }

  return value;
}

function createTurnRequestError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
