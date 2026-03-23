import { readFile, stat } from 'node:fs/promises';

export async function readThreadFromRolloutFile(threadMeta) {
  const snapshot = await readRolloutThreadSnapshot(threadMeta);
  return snapshot.thread;
}

export async function readRolloutThreadSnapshot(threadMeta) {
  const fileStats = await stat(threadMeta.path);
  const raw = await readFile(threadMeta.path, 'utf8');
  const entries = parseRolloutEntries(raw);
  const thread = buildThreadFromRolloutEntries(threadMeta, entries);

  return {
    signature: {
      path: threadMeta.path ?? null,
      size: Number(fileStats.size ?? 0),
      mtimeMs: Number(fileStats.mtimeMs ?? 0),
    },
    thread,
    runtime: buildExternalRuntimeFromRolloutEntries(entries),
  };
}

function buildThreadFromRolloutEntries(threadMeta, entries) {
  const sessionMeta = entries.find((entry) => entry.type === 'session_meta')?.payload ?? {};
  const turnsById = new Map();
  const turnOrder = [];
  let currentTurnId = null;
  let itemIndex = 0;

  for (const entry of entries) {
    if (entry.type === 'turn_context') {
      currentTurnId = entry.payload.turn_id;
      ensureTurn(turnsById, turnOrder, currentTurnId);
      continue;
    }

    if (entry.type === 'response_item' && entry.payload.type === 'message' && entry.payload.role === 'user') {
      const content = extractUserMessageContent(entry.payload.content ?? []);
      if (content.length === 0) {
        continue;
      }

      const turn = ensureTurn(turnsById, turnOrder, currentTurnId ?? 'turn-1');
      turn.items.push({
        type: 'userMessage',
        id: `item-${++itemIndex}`,
        content,
      });
      continue;
    }

    if (entry.type === 'event_msg' && entry.payload.type === 'agent_message') {
      const turn = ensureTurn(turnsById, turnOrder, currentTurnId ?? 'turn-1');
      turn.items.push({
        type: 'agentMessage',
        id: `item-${++itemIndex}`,
        text: entry.payload.message ?? '',
        phase: entry.payload.phase ?? 'commentary',
      });
      continue;
    }

    if (entry.type === 'event_msg' && entry.payload.type === 'task_started') {
      const turn = ensureTurn(turnsById, turnOrder, entry.payload.turn_id ?? currentTurnId ?? 'turn-1');
      turn.status = 'started';
      continue;
    }

    if (entry.type === 'event_msg' && entry.payload.type === 'task_complete') {
      const turn = ensureTurn(turnsById, turnOrder, entry.payload.turn_id ?? currentTurnId ?? 'turn-1');
      turn.status = 'completed';
    }
  }

  const turns = turnOrder.map((turnId) => turnsById.get(turnId));

  return {
    id: threadMeta.id ?? sessionMeta.id,
    preview: threadMeta.preview ?? '',
    ephemeral: threadMeta.ephemeral ?? false,
    modelProvider: threadMeta.modelProvider ?? sessionMeta.model_provider ?? null,
    createdAt: threadMeta.createdAt ?? toUnixSeconds(sessionMeta.timestamp),
    updatedAt: threadMeta.updatedAt ?? threadMeta.createdAt ?? toUnixSeconds(sessionMeta.timestamp),
    status: threadMeta.status ?? { type: 'loaded' },
    path: threadMeta.path ?? null,
    cwd: threadMeta.cwd ?? sessionMeta.cwd ?? null,
    cliVersion: threadMeta.cliVersion ?? sessionMeta.cli_version ?? null,
    source: threadMeta.source ?? sessionMeta.source ?? null,
    agentNickname: threadMeta.agentNickname ?? null,
    agentRole: threadMeta.agentRole ?? null,
    gitInfo: threadMeta.gitInfo ?? mapGitInfo(sessionMeta.git),
    name: threadMeta.name ?? threadMeta.preview ?? threadMeta.id,
    turns,
  };
}

function parseRolloutEntries(raw) {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function buildExternalRuntimeFromRolloutEntries(entries) {
  let currentTurnId = null;
  let lastTaskEvent = null;

  for (const entry of entries) {
    if (entry.type === 'turn_context') {
      currentTurnId = entry.payload?.turn_id ?? currentTurnId;
      continue;
    }

    if (entry.type !== 'event_msg') {
      continue;
    }

    if (entry.payload?.type !== 'task_started' && entry.payload?.type !== 'task_complete') {
      continue;
    }

    lastTaskEvent = {
      type: entry.payload.type,
      turnId: entry.payload.turn_id ?? currentTurnId ?? 'turn-1',
    };
  }

  if (!lastTaskEvent?.type) {
    return null;
  }

  return {
    source: 'externalRollout',
    turnStatus: lastTaskEvent.type === 'task_started' ? 'started' : 'completed',
    activeTurnId: lastTaskEvent.type === 'task_started' ? lastTaskEvent.turnId : null,
    diff: null,
    realtime: {
      status: 'idle',
      sessionId: null,
      items: [],
      audioChunkCount: 0,
      audioByteCount: 0,
      lastAudio: null,
      lastError: null,
      closeReason: null,
    },
  };
}

function ensureTurn(turnsById, turnOrder, turnId) {
  if (!turnsById.has(turnId)) {
    turnsById.set(turnId, {
      id: turnId,
      items: [],
      status: 'completed',
      error: null,
    });
    turnOrder.push(turnId);
  }

  return turnsById.get(turnId);
}

function extractUserMessageContent(content) {
  const normalizedContent = [];

  for (const item of content) {
    const normalizedText = normalizeUserMessageText(item);
    if (normalizedText) {
      normalizedContent.push({
        type: 'text',
        text: normalizedText,
        text_elements: [],
      });
      continue;
    }

    const imageUrl = normalizeUserMessageImageUrl(item);
    if (!imageUrl) {
      continue;
    }

    normalizedContent.push({
      type: 'image',
      url: imageUrl,
    });
  }

  return normalizedContent;
}

function normalizeUserMessageText(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  if (item.type !== 'input_text' && item.type !== 'text') {
    return null;
  }

  const text = item.text?.trim();
  if (!text) {
    return null;
  }

  if (text.startsWith('# AGENTS.md instructions')) {
    return null;
  }

  if (text.startsWith('<environment_context>')) {
    return null;
  }

  return text;
}

function normalizeUserMessageImageUrl(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  if (item.type !== 'input_image' && item.type !== 'image') {
    return null;
  }

  const url = typeof item.image_url === 'string' ? item.image_url.trim() : '';
  if (url) {
    return url;
  }

  const fallbackUrl = typeof item.url === 'string' ? item.url.trim() : '';
  return fallbackUrl || null;
}

function toUnixSeconds(isoString) {
  if (!isoString) {
    return null;
  }

  return Math.floor(new Date(isoString).getTime() / 1000);
}

function mapGitInfo(git) {
  if (!git) {
    return null;
  }

  return {
    branch: git.branch ?? null,
    sha: git.commit_hash ?? null,
    originUrl: git.repository_url ?? null,
  };
}
