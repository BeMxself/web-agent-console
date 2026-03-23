export class ClaudeSdkEventMapper {
  constructor({ threadId, turnId, projectId = null }) {
    this.threadId = threadId;
    this.turnId = turnId;
    this.projectId = projectId;
    this.nextGeneratedItemId = 1;
    this.streamingAgentMessage = null;
    this.toolItemsByUseId = new Map();
    this.tasksById = new Map();
    this.nextTaskOrder = 1;
  }

  map(message) {
    if (!message || typeof message !== 'object') {
      return [];
    }

    const todoEvents = this.mapTodoMessage(message);
    if (todoEvents.length > 0) {
      return todoEvents;
    }

    if (message.type === 'stream_event') {
      return this.mapStreamEvent(message);
    }

    if (message.type === 'assistant') {
      return this.mapAssistantMessage(message);
    }

    if (message.type === 'user') {
      return this.mapUserMessage(message);
    }

    if (message.type === 'tool_progress') {
      return this.mapToolProgress(message);
    }

    if (message.type === 'system') {
      return this.mapSystemMessage(message);
    }

    if (message.type === 'result' && !message.is_error) {
      return [
        {
          type: 'turn_completed',
          threadId: this.threadId,
          payload: {
            threadId: this.threadId,
            turnId: this.turnId,
          },
        },
      ];
    }

    return [];
  }

  mapStreamEvent(message) {
    const streamEvent = message?.event;
    if (streamEvent?.type !== 'content_block_delta' || streamEvent?.delta?.type !== 'text_delta') {
      return [];
    }

    const delta = normalizeString(streamEvent.delta.text);
    if (!delta) {
      return [];
    }

    const item = this.ensureStreamingAgentMessage();
    const events = [];

    if (!item.started) {
      item.started = true;
      events.push({
        type: 'thread_item_started',
        threadId: this.threadId,
        payload: {
          threadId: this.threadId,
          turnId: this.turnId,
          item: {
            type: 'agentMessage',
            id: item.itemId,
            text: '',
            phase: 'commentary',
          },
        },
      });
    }

    item.text += delta;
    events.push({
      type: 'thread_item_delta',
      threadId: this.threadId,
      payload: {
        threadId: this.threadId,
        turnId: this.turnId,
        itemId: item.itemId,
        itemType: 'agentMessage',
        delta,
      },
    });

    return events;
  }

  mapAssistantMessage(message) {
    const blocks = getContentBlocks(message);
    const events = [];

    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];

      if (block?.type === 'text') {
        const text = normalizeString(block?.text);
        if (!text) {
          continue;
        }

        const streamingItem = this.streamingAgentMessage;
        const itemId = streamingItem?.itemId ?? this.createItemId('claude-agent');
        this.streamingAgentMessage = null;
        events.push({
          type: 'thread_item_completed',
          threadId: this.threadId,
          payload: {
            threadId: this.threadId,
            turnId: this.turnId,
            item: {
              type: 'agentMessage',
              id: itemId,
              text,
              phase: hasToolUseAfterIndex(blocks, index) ? 'commentary' : 'final_answer',
            },
          },
        });
        continue;
      }

      if (block?.type === 'tool_use') {
        const todoEvent = mapTodoToolUseBlock(block, this.threadId, this.turnId);
        if (todoEvent) {
          events.push(todoEvent);
        }

        const item = mapToolUseBlock(block, message, this.projectId, index);
        this.toolItemsByUseId.set(item.toolUseId, item);
        events.push({
          type: 'thread_item_started',
          threadId: this.threadId,
          payload: {
            threadId: this.threadId,
            turnId: this.turnId,
            item,
          },
        });
      }
    }

    return events;
  }

  mapTodoMessage(message) {
    const todos = extractTodosFromMessage(message);
    if (!todos) {
      return [];
    }

    return [createTurnPlanUpdatedEvent(this.threadId, this.turnId, todos)];
  }

  mapUserMessage(message) {
    const events = [];

    for (const block of getContentBlocks(message)) {
      if (block?.type !== 'tool_result') {
        continue;
      }

      const toolUseId = normalizeString(block?.tool_use_id);
      const item = toolUseId ? this.toolItemsByUseId.get(toolUseId) : null;
      if (!item) {
        continue;
      }

      const completedItem = applyToolResult(item, block);
      this.toolItemsByUseId.set(toolUseId, completedItem);
      events.push({
        type: 'thread_item_completed',
        threadId: this.threadId,
        payload: {
          threadId: this.threadId,
          turnId: this.turnId,
          item: completedItem,
        },
      });
    }

    return events;
  }

  mapToolProgress(message) {
    const toolUseId = normalizeString(message?.tool_use_id);
    const item = toolUseId ? this.toolItemsByUseId.get(toolUseId) : null;
    if (!item) {
      return [];
    }

    if (item.type === 'commandExecution') {
      return [
        {
          type: 'thread_item_delta',
          threadId: this.threadId,
          payload: {
            threadId: this.threadId,
            turnId: this.turnId,
            itemId: item.id,
            itemType: 'commandExecution',
            deltaKind: 'command_output',
            delta: `[${message.tool_name}] running for ${Math.max(1, Math.round(message.elapsed_time_seconds ?? 0))}s\n`,
          },
        },
      ];
    }

    return [
      {
        type: 'thread_item_delta',
        threadId: this.threadId,
        payload: {
          threadId: this.threadId,
          turnId: this.turnId,
          itemId: item.id,
          itemType: 'mcpToolCall',
          deltaKind: 'mcp_progress',
          message: `${item.tool} running`,
        },
      },
    ];
  }

  mapSystemMessage(message) {
    if (message.subtype === 'task_started') {
      return this.updateTask(message.task_id, {
        step: normalizeString(message.description) ?? normalizeString(message.prompt) ?? 'Task',
        status: 'inProgress',
      });
    }

    if (message.subtype === 'task_progress') {
      return this.updateTask(message.task_id, {
        step: normalizeString(message.summary) ?? normalizeString(message.description) ?? 'Task',
        status: 'inProgress',
      });
    }

    if (message.subtype === 'task_notification') {
      const summary = normalizeString(message.summary) ?? 'Task';
      return this.updateTask(message.task_id, {
        step:
          message.status === 'failed'
            ? `${summary} (failed)`
            : message.status === 'stopped'
              ? `${summary} (stopped)`
              : summary,
        status: 'completed',
      });
    }

    return [];
  }

  updateTask(taskId, { step, status }) {
    const normalizedTaskId = normalizeString(taskId) ?? this.createItemId('task');
    const existing = this.tasksById.get(normalizedTaskId);
    this.tasksById.set(normalizedTaskId, {
      order: existing?.order ?? this.nextTaskOrder++,
      step,
      status,
    });

    return [
      {
        type: 'turn_plan_updated',
        threadId: this.threadId,
        payload: {
          threadId: this.threadId,
          turnId: this.turnId,
          explanation: null,
          plan: [...this.tasksById.values()]
            .sort((left, right) => left.order - right.order)
            .map(({ step: taskStep, status: taskStatus }) => ({
              step: taskStep,
              status: taskStatus,
            })),
        },
      },
    ];
  }

  ensureStreamingAgentMessage() {
    if (this.streamingAgentMessage) {
      return this.streamingAgentMessage;
    }

    this.streamingAgentMessage = {
      itemId: this.createItemId('claude-agent'),
      text: '',
      started: false,
    };
    return this.streamingAgentMessage;
  }

  createItemId(prefix) {
    const itemId = `${prefix}-${this.turnId}-${this.nextGeneratedItemId}`;
    this.nextGeneratedItemId += 1;
    return itemId;
  }
}

function getContentBlocks(message) {
  const blocks = message?.message?.content;
  return Array.isArray(blocks) ? blocks : [];
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

function mapTodoToolUseBlock(block, threadId, turnId) {
  const toolName = normalizeString(block?.name)?.toLowerCase();
  const todos = Array.isArray(block?.input?.todos) ? block.input.todos : null;
  if (toolName !== 'todowrite' || !todos) {
    return null;
  }

  return createTurnPlanUpdatedEvent(threadId, turnId, todos);
}

function applyToolResult(item, block) {
  const resultContent = normalizeToolResultContent(block?.content);

  if (item.type === 'commandExecution') {
    return {
      ...item,
      status: block?.is_error ? 'failed' : 'completed',
      aggregatedOutput: resultContent,
      exitCode: block?.is_error ? 1 : 0,
    };
  }

  return {
    ...item,
    status: block?.is_error ? 'failed' : 'completed',
    result: block?.is_error ? null : resultContent,
    error: block?.is_error ? resultContent : null,
  };
}

function normalizeToolResultContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (typeof entry === 'string') {
          return entry;
        }

        if (typeof entry?.text === 'string') {
          return entry.text;
        }

        return '';
      })
      .join('')
      .trim();
  }

  return '';
}

function isCommandTool(toolName, input) {
  const normalizedToolName = normalizeString(toolName)?.toLowerCase();

  return normalizedToolName === 'bash' || normalizedToolName === 'command' || typeof input?.command === 'string';
}

function extractTodosFromMessage(message) {
  const messageType = normalizeString(message?.type)?.toLowerCase();
  const messageSubtype = normalizeString(message?.subtype)?.toLowerCase();
  const eventType = normalizeString(message?.event?.type)?.toLowerCase();

  const looksLikeTodoUpdate =
    messageType === 'todo.updated' ||
    (messageType === 'todo' && messageSubtype === 'updated') ||
    (messageType === 'system' && messageSubtype === 'todo_updated') ||
    eventType === 'todo.updated';

  if (!looksLikeTodoUpdate) {
    return null;
  }

  const candidates = [
    message?.todos,
    message?.payload?.todos,
    message?.event?.todos,
    message?.data?.todos,
  ];
  return candidates.find((todos) => Array.isArray(todos)) ?? null;
}

function createTurnPlanUpdatedEvent(threadId, turnId, todos) {
  return {
    type: 'turn_plan_updated',
    threadId,
    payload: {
      threadId,
      turnId,
      explanation: null,
      plan: normalizeTodoPlan(todos),
    },
  };
}

function normalizeTodoPlan(todos) {
  return todos
    .map((todo) => {
      const status = normalizeTodoStatus(todo?.status);
      const step =
        status === 'inProgress'
          ? normalizeString(todo?.activeForm) ?? normalizeString(todo?.content)
          : normalizeString(todo?.content) ?? normalizeString(todo?.activeForm);
      if (!step) {
        return null;
      }

      return {
        step,
        status,
      };
    })
    .filter(Boolean);
}

function normalizeTodoStatus(status) {
  switch (normalizeString(status)?.toLowerCase()) {
    case 'completed':
      return 'completed';
    case 'in_progress':
    case 'inprogress':
      return 'inProgress';
    default:
      return 'pending';
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}
