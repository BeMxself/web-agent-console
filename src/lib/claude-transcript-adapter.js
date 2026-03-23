import { createAttachmentSummaryFromClaudeContentBlock } from './claude-attachments.js';

export function createClaudeThreadPlaceholder(threadRecord) {
  const name = normalizeString(threadRecord?.summary);

  return {
    id: threadRecord?.threadId ?? null,
    preview: name ?? '',
    ephemeral: false,
    modelProvider: 'claude-sdk',
    createdAt: normalizeTimestampSeconds(threadRecord?.createdAt),
    updatedAt: normalizeTimestampSeconds(threadRecord?.updatedAt ?? threadRecord?.createdAt),
    status: { type: 'loaded' },
    path: null,
    cwd: threadRecord?.projectId ?? null,
    cliVersion: null,
    source: 'claude-sdk',
    agentNickname: 'Claude',
    agentRole: null,
    gitInfo: null,
    name,
    turns: [],
  };
}

export function buildClaudeThreadFromTranscript({ threadRecord, sessionInfo, messages }) {
  const baseThread = createClaudeThreadPlaceholder(threadRecord);
  const turns = buildClaudeTurns(messages, threadRecord?.projectId);
  const summary = normalizeString(sessionInfo?.customTitle) ?? normalizeString(sessionInfo?.summary) ?? baseThread.name;
  const preview = inferPreview(messages) ?? summary ?? '';

  return {
    ...baseThread,
    name: summary,
    preview,
    createdAt: normalizeTimestampSeconds(sessionInfo?.createdAt ?? baseThread.createdAt),
    updatedAt: normalizeTimestampSeconds(sessionInfo?.lastModified ?? baseThread.updatedAt),
    turns,
  };
}

export function buildClaudeTurns(messages, projectId = null) {
  const turns = [];
  let currentTurn = null;
  let toolItemsById = new Map();

  for (const message of messages ?? []) {
    const blocks = getContentBlocks(message);

    if (message?.type === 'user') {
      if (isToolResultOnlyMessage(blocks)) {
        if (!currentTurn) {
          currentTurn = createTurn(message?.uuid);
          turns.push(currentTurn);
        }

        applyToolResults(blocks, toolItemsById);
        continue;
      }

      currentTurn = createTurn(message?.uuid);
      toolItemsById = new Map();
      turns.push(currentTurn);
      currentTurn.items.push(...mapUserBlocks(blocks, message));
      continue;
    }

    if (message?.type === 'assistant') {
      if (!currentTurn) {
        currentTurn = createTurn(message?.uuid);
        turns.push(currentTurn);
      }

      const mappedItems = mapAssistantBlocks(blocks, message, projectId);
      for (const item of mappedItems) {
        currentTurn.items.push(item);
        if (item.toolUseId) {
          toolItemsById.set(item.toolUseId, item);
        }
      }
    }
  }

  return turns.filter((turn) => turn.items.length > 0);
}

function createTurn(seed) {
  return {
    id: `turn-${seed ?? turnsCounter()}`,
    status: 'completed',
    items: [],
  };
}

function mapUserBlocks(blocks, message) {
  const content = [];

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block?.type === 'text') {
      const text = normalizeString(block?.text);
      if (!text) {
        continue;
      }

      content.push({
        type: 'text',
        text,
        text_elements: [],
      });
      continue;
    }

    const attachmentSummary = createAttachmentSummaryFromClaudeContentBlock(block);
    if (!attachmentSummary) {
      continue;
    }
    content.push(attachmentSummary);
  }

  if (content.length === 0) {
    return [];
  }

  return [
    {
      type: 'userMessage',
      id: `${message?.uuid ?? 'user'}:0`,
      content,
    },
  ];
}

function mapAssistantBlocks(blocks, message, projectId) {
  const items = [];

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];

    if (block?.type === 'text') {
      const text = normalizeString(block?.text);
      if (!text) {
        continue;
      }

      items.push({
        type: 'agentMessage',
        id: `${message?.uuid ?? 'assistant'}:${index}`,
        text,
        phase: hasToolUseAfterIndex(blocks, index) ? 'commentary' : 'final_answer',
      });
      continue;
    }

    if (block?.type === 'tool_use') {
      items.push(mapToolUseBlock(block, message, projectId, index));
    }
  }

  return items;
}

function hasToolUseAfterIndex(blocks, index) {
  return blocks.slice(index + 1).some((block) => block?.type === 'tool_use');
}

function mapToolUseBlock(block, message, projectId, index) {
  const toolUseId = normalizeString(block?.id) ?? `${message?.uuid ?? 'tool'}:${index}`;
  const toolName = normalizeString(block?.name) ?? 'unknown';
  const input = isPlainObject(block?.input) ? block.input : {};

  if (isCommandTool(toolName, input)) {
    return {
      type: 'commandExecution',
      id: `tool:${toolUseId}`,
      toolUseId,
      command: normalizeString(input.command) ?? toolName,
      cwd: normalizeString(input.cwd) ?? projectId,
      processId: null,
      status: 'inProgress',
      commandActions: [],
      aggregatedOutput: '',
      exitCode: null,
      durationMs: null,
    };
  }

  return {
    type: 'mcpToolCall',
    id: `tool:${toolUseId}`,
    toolUseId,
    server: 'claude-sdk',
    tool: toolName,
    status: 'inProgress',
    arguments: input,
    result: null,
    error: null,
    durationMs: null,
    progressMessages: [],
  };
}

function applyToolResults(blocks, toolItemsById) {
  for (const block of blocks) {
    if (block?.type !== 'tool_result') {
      continue;
    }

    const toolUseId = normalizeString(block?.tool_use_id);
    if (!toolUseId || !toolItemsById.has(toolUseId)) {
      continue;
    }

    const item = toolItemsById.get(toolUseId);
    const payload = stringifyToolResult(block?.content);

    if (item.type === 'commandExecution') {
      item.status = block?.is_error ? 'failed' : 'completed';
      item.aggregatedOutput = payload;
      continue;
    }

    if (item.type === 'mcpToolCall') {
      item.status = block?.is_error ? 'failed' : 'completed';
      if (block?.is_error) {
        item.error = payload;
      } else {
        item.result = payload;
      }
    }
  }
}

function getContentBlocks(message) {
  if (Array.isArray(message?.message?.content)) {
    return message.message.content;
  }

  if (typeof message?.message === 'string') {
    return [{ type: 'text', text: message.message }];
  }

  return [];
}

function isToolResultOnlyMessage(blocks) {
  return Array.isArray(blocks) && blocks.length > 0 && blocks.every((block) => block?.type === 'tool_result');
}

function isCommandTool(toolName, input) {
  const normalizedName = toolName.toLowerCase();
  return normalizedName === 'bash' || normalizedName === 'command' || typeof input?.command === 'string';
}

function stringifyToolResult(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === 'string') {
          return entry;
        }

        if (entry?.type === 'text' && typeof entry.text === 'string') {
          return entry.text;
        }

        return JSON.stringify(entry);
      })
      .join('\n');
  }

  if (value == null) {
    return '';
  }

  return JSON.stringify(value);
}

function inferPreview(messages) {
  for (const message of messages ?? []) {
    if (message?.type !== 'user') {
      continue;
    }

    for (const block of getContentBlocks(message)) {
      if (block?.type === 'text') {
        const text = normalizeString(block?.text);
        if (text) {
          return text;
        }
      }
    }
  }

  return null;
}

function normalizeString(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function normalizeTimestampSeconds(value) {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }

  if (numeric > 9_999_999_999) {
    return Math.floor(numeric / 1000);
  }

  return Math.floor(numeric);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function turnsCounter() {
  return Math.random().toString(16).slice(2);
}
