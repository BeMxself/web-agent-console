const REWRITE_PROMPT_PREFIX = '<!-- web-agent-console-rewrite-v1 ';
const REWRITE_PROMPT_SUFFIX = ' -->';

export function buildBranchReplayPrompt(thread, userMessageId, rewrittenText, metadata = {}) {
  const branchPoint = findUserMessageBranchPoint(thread, userMessageId);
  const normalizedText = String(rewrittenText ?? '').trim();
  if (!branchPoint || !normalizedText) {
    return null;
  }

  const transcript = buildReplayTranscript(thread, branchPoint.turnIndex);
  const prompt = [
    transcript
      ? 'Continue this conversation branch from the transcript below. The final user message from the original thread has been replaced.'
      : 'Treat this as a replacement for the original first user message from another branch.',
    '',
    transcript ? `Conversation so far:\n${transcript}` : '',
    transcript ? '' : '',
    `Edited replacement message:\n${normalizedText}`,
  ]
    .filter(Boolean)
    .join('\n');

  return buildRewritePromptEnvelope({
    displayText: normalizedText,
    metadata,
    prompt,
  });
}

export function buildRewritePromptEnvelope({ displayText, prompt, metadata = {} }) {
  const payload = JSON.stringify({
    ...metadata,
    displayText: String(displayText ?? '').trim(),
  });
  return `${REWRITE_PROMPT_PREFIX}${payload}${REWRITE_PROMPT_SUFFIX}\n${String(prompt ?? '')}`;
}

export function findUserMessageBranchPoint(thread, userMessageId) {
  const normalizedTarget = String(userMessageId ?? '').trim();
  if (!normalizedTarget) {
    return null;
  }

  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    const turn = turns[turnIndex];
    for (const item of turn?.items ?? []) {
      if (item?.type !== 'userMessage') {
        continue;
      }

      if (!matchesUserMessageId(item.id, normalizedTarget)) {
        continue;
      }

      return {
        turnIndex,
        turn,
        item,
      };
    }
  }

  return null;
}

export function extractProviderMessageId(userMessageId) {
  const normalized = String(userMessageId ?? '').trim();
  if (!normalized) {
    return null;
  }

  return normalized.split(':', 1)[0] || normalized;
}

export function findPreviousProviderMessageId(thread, userMessageId) {
  const normalizedTarget = String(userMessageId ?? '').trim();
  if (!normalizedTarget) {
    return null;
  }

  let previousItemId = null;
  for (const turn of thread?.turns ?? []) {
    for (const item of turn?.items ?? []) {
      if (item?.id && matchesUserMessageId(item.id, normalizedTarget)) {
        return extractProviderMessageId(previousItemId);
      }

      if (item?.id) {
        previousItemId = item.id;
      }
    }
  }

  return null;
}

function matchesUserMessageId(itemId, expectedId) {
  const normalizedItemId = String(itemId ?? '').trim();
  if (!normalizedItemId) {
    return false;
  }

  return (
    normalizedItemId === expectedId ||
    normalizedItemId.startsWith(`${expectedId}:`) ||
    expectedId.startsWith(`${normalizedItemId}:`)
  );
}

function buildReplayTranscript(thread, beforeTurnIndex) {
  const turns = Array.isArray(thread?.turns) ? thread.turns.slice(0, beforeTurnIndex) : [];
  return turns
    .flatMap((turn) => (turn?.items ?? []).map((item) => formatReplayTranscriptEntry(item)).filter(Boolean))
    .join('\n\n');
}

function formatReplayTranscriptEntry(item) {
  if (item?.type === 'userMessage') {
    const text = extractUserMessageText(item);
    return text ? `User:\n${text}` : null;
  }

  if (item?.type === 'agentMessage') {
    const text = firstNonEmptyText(item.text);
    return text ? `Assistant:\n${text}` : null;
  }

  return null;
}

function extractUserMessageText(item) {
  return (item?.content ?? [])
    .map((entry) => (entry?.type === 'text' ? firstNonEmptyText(entry.text) : ''))
    .filter(Boolean)
    .join('\n');
}

function firstNonEmptyText(...values) {
  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (normalized) {
      return normalized;
    }
  }

  return '';
}
