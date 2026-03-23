function normalizeTurnParams(params) {
  return {
    ...params,
    turnId: params.turnId ?? params.turn?.id ?? null,
  };
}

export function mapCodexNotification(message) {
  switch (message.method) {
    case 'thread/status/changed':
      return {
        type: 'thread_status_changed',
        threadId: message.params.threadId,
        payload: message.params,
      };
    case 'turn/started':
      return {
        type: 'turn_started',
        threadId: message.params.threadId,
        payload: normalizeTurnParams(message.params),
      };
    case 'turn/diff/updated':
      return {
        type: 'turn_diff_updated',
        threadId: message.params.threadId,
        payload: message.params,
      };
    case 'turn/plan/updated':
      return {
        type: 'turn_plan_updated',
        threadId: message.params.threadId ?? message.params.turn?.threadId ?? null,
        payload: message.params,
      };
    case 'turn/completed':
      return {
        type: 'turn_completed',
        threadId: message.params.threadId,
        payload: normalizeTurnParams(message.params),
      };
    case 'thread/name/updated':
      return {
        type: 'thread_name_updated',
        threadId: message.params.threadId,
        payload: message.params,
      };
    case 'item/started':
      return {
        type: 'thread_item_started',
        threadId: message.params.threadId,
        payload: message.params,
      };
    case 'item/completed':
      return {
        type: 'thread_item_completed',
        threadId: message.params.threadId,
        payload: message.params,
      };
    case 'item/agentMessage/delta':
      return {
        type: 'thread_item_delta',
        threadId: message.params.threadId,
        payload: {
          ...message.params,
          itemType: 'agentMessage',
        },
      };
    case 'item/plan/delta':
      return {
        type: 'thread_item_delta',
        threadId: message.params.threadId,
        payload: {
          ...message.params,
          itemType: 'plan',
        },
      };
    case 'item/reasoning/summaryPartAdded':
      return {
        type: 'thread_item_delta',
        threadId: message.params.threadId,
        payload: {
          ...message.params,
          itemType: 'reasoning',
          deltaKind: 'reasoning_summary_part_added',
        },
      };
    case 'item/reasoning/summaryTextDelta':
      return {
        type: 'thread_item_delta',
        threadId: message.params.threadId,
        payload: {
          ...message.params,
          itemType: 'reasoning',
          deltaKind: 'reasoning_summary_text',
        },
      };
    case 'item/reasoning/textDelta':
      return {
        type: 'thread_item_delta',
        threadId: message.params.threadId,
        payload: {
          ...message.params,
          itemType: 'reasoning',
          deltaKind: 'reasoning_text',
        },
      };
    case 'item/commandExecution/outputDelta':
      return {
        type: 'thread_item_delta',
        threadId: message.params.threadId,
        payload: {
          ...message.params,
          itemType: 'commandExecution',
          deltaKind: 'command_output',
        },
      };
    case 'item/mcpToolCall/progress':
      return {
        type: 'thread_item_delta',
        threadId: message.params.threadId,
        payload: {
          ...message.params,
          itemType: 'mcpToolCall',
          deltaKind: 'mcp_progress',
        },
      };
    case 'thread/realtime/started':
      return {
        type: 'thread_realtime_started',
        threadId: message.params.threadId,
        payload: message.params,
      };
    case 'thread/realtime/itemAdded':
      return {
        type: 'thread_realtime_item_added',
        threadId: message.params.threadId,
        payload: message.params,
      };
    case 'thread/realtime/outputAudio/delta':
      return {
        type: 'thread_realtime_audio_delta',
        threadId: message.params.threadId,
        payload: message.params,
      };
    case 'thread/realtime/error':
      return {
        type: 'thread_realtime_error',
        threadId: message.params.threadId,
        payload: message.params,
      };
    case 'thread/realtime/closed':
      return {
        type: 'thread_realtime_closed',
        threadId: message.params.threadId,
        payload: message.params,
      };
    default:
      return null;
  }
}
