export function firstNonEmptyText(...values) {
  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (normalized) {
      return normalized;
    }
  }

  return '';
}

const REWRITE_PROMPT_PREFIX = '<!-- web-agent-console-rewrite-v1 ';
const REWRITE_PROMPT_SUFFIX = ' -->';

export function buildRewritePromptEnvelope({ displayText, prompt, metadata = {} }) {
  const normalizedDisplayText = String(displayText ?? '').trim();
  const normalizedPrompt = String(prompt ?? '');
  const payload = JSON.stringify({
    ...metadata,
    displayText: normalizedDisplayText,
  });
  return `${REWRITE_PROMPT_PREFIX}${payload}${REWRITE_PROMPT_SUFFIX}\n${normalizedPrompt}`;
}

export function parseRewritePromptEnvelope(text) {
  const normalizedText = String(text ?? '');
  const match = normalizedText.match(
    /^<!-- web-agent-console-rewrite-v1 (?<payload>[\s\S]*?) -->\n?(?<prompt>[\s\S]*)$/u,
  );
  if (!match?.groups?.payload) {
    return null;
  }

  try {
    const metadata = JSON.parse(match.groups.payload);
    return {
      metadata,
      prompt: match.groups.prompt ?? '',
    };
  } catch {
    return null;
  }
}

export function getDisplayTextFromPrompt(text) {
  const rewritten = parseRewritePromptEnvelope(text);
  const displayText = String(rewritten?.metadata?.displayText ?? '').trim();
  if (displayText) {
    return displayText;
  }

  return firstNonEmptyText(text);
}

export function omitObjectKeys(value, keysToSkip) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const skippedKeys = new Set(keysToSkip);
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !skippedKeys.has(key)),
  );
}

export function preferThreadText(primary, fallback) {
  if (typeof primary === 'string' && primary.trim()) {
    return primary;
  }

  return fallback ?? primary ?? null;
}
