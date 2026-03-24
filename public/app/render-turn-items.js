import {
  escapeHtml,
  formatCollabAgentStatus,
  getCollabAgentTone,
  normalizeCollabToolCallStatus,
  renderMarkdownMessage,
} from './dom-utils.js';
import {
  collectUserMessageAttachments,
  extractUserText,
  inferAttachmentLabel,
} from './session-utils.js';
import {
  formatPlanStepStatus,
  getPlanStepTone,
  normalizeTurnPlan,
} from './plan-utils.js';
import { firstNonEmptyText, omitObjectKeys } from './text-utils.js';

export function renderTurn(turn, index) {
  const items = turn.items?.length
    ? turn.items.map((item) => renderTurnItem(item)).join('')
    : '<div class="message-bubble message-bubble--system">这个 turn 没有可显示的消息。</div>';

  return [
    `<section class="turn-card" data-turn-card="${index}">`,
    '<div class="turn-card-header">',
    `<span>Turn ${index + 1}</span>`,
    `<span>${escapeHtml(turn.status ?? 'unknown')}</span>`,
    '</div>',
    items,
    '</section>',
  ].join('');
}

export function renderConversationNavigation() {
  return [
    '<div class="thread-nav" aria-label="会话跳转">',
    '<button class="thread-nav-button" type="button" data-conversation-nav="top">到顶部</button>',
    '<button class="thread-nav-button" type="button" data-conversation-nav="previous">上一回合</button>',
    '<button class="thread-nav-button" type="button" data-conversation-nav="next">下一回合</button>',
    '<button class="thread-nav-button thread-nav-button--primary" type="button" data-conversation-nav="bottom">到底部</button>',
    '</div>',
  ].join('');
}

export function renderTurnItem(item) {
  const renderer = TURN_ITEM_RENDERERS[item.type] ?? renderFallbackTurnItem;
  return renderer(item);
}

export function renderMessageBubble(label, text, role, options = {}) {
  const classes = ['message-bubble', `message-bubble--${role}`];
  if (options.streaming) {
    classes.push('message-bubble--streaming');
  }
  const messageText = String(text ?? '').trim() || 'Empty message';
  const renderedMessage = renderMarkdownMessage(messageText);

  return [
    `<div class="${classes.join(' ')}">`,
    `<div class="message-role">${escapeHtml(label)}</div>`,
    `<div class="${renderedMessage.className}">${renderedMessage.html}</div>`,
    options.attachmentsHtml ?? '',
    '</div>',
  ].join('');
}

export function renderUserMessageBubble(item) {
  const messageText = extractUserText(item) || '已发送附件';
  return renderMessageBubble('用户', messageText, 'user', {
    attachmentsHtml: renderUserMessageAttachments(item),
  });
}

export function renderUserMessageAttachments(item) {
  const attachments = collectUserMessageAttachments(item);
  if (attachments.length === 0) {
    return '';
  }

  return [
    '<div class="message-attachments" role="list">',
    attachments.map((attachment) => renderUserMessageAttachmentCard(attachment)).join(''),
    '</div>',
  ].join('');
}

export function renderUserMessageAttachmentCard(attachment) {
  const title = attachment.name ?? inferAttachmentLabel(attachment);
  const detail = attachment.mimeType ?? 'application/octet-stream';

  return [
    `<button class="message-attachment-card message-attachment-card--interactive" type="button" role="listitem" data-message-attachment-item="${escapeHtml(attachment.itemId ?? '')}" data-message-attachment-index="${escapeHtml(attachment.index ?? 0)}">`,
    attachment.kind === 'image' && attachment.url
      ? `<img class="message-attachment-thumb" alt="${escapeHtml(title)}" src="${escapeHtml(attachment.url)}" />`
      : `<div class="message-attachment-placeholder">${escapeHtml(inferAttachmentLabel(attachment))}</div>`,
    '<div class="message-attachment-meta">',
    `<div class="message-attachment-title">${escapeHtml(title)}</div>`,
    `<div class="message-attachment-detail">${escapeHtml(detail)}</div>`,
    attachment.previewText
      ? `<div class="message-attachment-preview">${escapeHtml(attachment.previewText)}</div>`
      : '',
    '</div>',
    '</button>',
  ].join('');
}

export function renderPlanTurnItem(item) {
  const normalizedPlan = normalizeTurnPlan(item);
  const structuredBody = normalizedPlan?.steps.length
    ? [
        normalizedPlan.explanation
          ? `<div class="thread-item-section"><div class="thread-item-section-title">说明</div><p class="thread-item-paragraph">${escapeHtml(normalizedPlan.explanation)}</p></div>`
          : '',
        '<div class="thread-item-section">',
        '<div class="thread-item-section-title">任务列表</div>',
        '<div class="task-plan-list" role="list">',
        normalizedPlan.steps.map((step, index) => renderTaskPlanStep(step, index)).join(''),
        '</div>',
        '</div>',
      ]
        .filter(Boolean)
        .join('')
    : '';

  return renderThreadItemCard({
    label: '计划',
    title: '执行计划',
    tone: 'plan',
    status: null,
    body:
      structuredBody || renderParagraphList(splitMultilineText(normalizedPlan?.text ?? item.text)),
  });
}

export function renderReasoningTurnItem(item) {
  const summary = renderParagraphList(item.summary ?? []);
  const content = renderParagraphList(item.content ?? []);

  return renderThreadItemCard({
    label: '推理',
    title: '推理摘要',
    tone: 'reasoning',
    status: null,
    body: [
      summary ? `<div class="thread-item-section"><div class="thread-item-section-title">Summary</div>${summary}</div>` : '',
      content ? `<div class="thread-item-section"><div class="thread-item-section-title">Details</div>${content}</div>` : '',
    ]
      .filter(Boolean)
      .join(''),
  });
}

export function renderCommandExecutionTurnItem(item) {
  return renderThreadItemCard({
    label: '命令执行',
    title: item.command || 'Command',
    tone: 'command',
    status: formatItemStatus(item.status),
    statusTone: item.status,
    collapsible: true,
    expanded: false,
    body: [
      item.cwd ? `<div class="thread-item-meta-line">cwd: ${escapeHtml(item.cwd)}</div>` : '',
      item.aggregatedOutput
        ? `<pre class="thread-item-pre">${escapeHtml(item.aggregatedOutput)}</pre>`
        : '<div class="thread-item-empty">还没有输出</div>',
    ]
      .filter(Boolean)
      .join(''),
  });
}

export function renderMcpToolCallTurnItem(item) {
  return renderThreadItemCard({
    label: 'MCP 工具',
    title: `${item.server || 'unknown'} / ${item.tool || 'unknown'}`,
    tone: 'mcp',
    status: formatItemStatus(item.status),
    statusTone: item.status,
    collapsible: true,
    expanded: false,
    body: [
      renderKeyValueList([
        ['Server', item.server],
        ['Tool', item.tool],
      ]),
      hasJsonValue(item.arguments)
        ? `<pre class="thread-item-pre">${escapeHtml(JSON.stringify(item.arguments, null, 2))}</pre>`
        : '',
      renderProgressList(item.progressMessages ?? []),
      item.error ? `<pre class="thread-item-pre thread-item-pre--error">${escapeHtml(JSON.stringify(item.error, null, 2))}</pre>` : '',
      item.result ? `<pre class="thread-item-pre">${escapeHtml(JSON.stringify(item.result, null, 2))}</pre>` : '',
    ]
      .filter(Boolean)
      .join(''),
  });
}

export function renderCollabAgentTurnItem(item) {
  return renderThreadItemCard({
    label: 'Subagent',
    title: item.tool || 'spawnAgent',
    tone: 'subagent',
    status: formatItemStatus(item.status),
    statusTone: item.status,
    body: `<pre class="thread-item-pre">${escapeHtml(formatCollabToolCall(item))}</pre>`,
  });
}

export function renderFileChangeTurnItem(item) {
  const title =
    item.path ??
    item.relativePath ??
    item.filePath ??
    item.targetPath ??
    item.uri ??
    item.name ??
    '文件变更';
  const changeType = firstNonEmptyText(item.changeType, item.operation, item.kind, item.event);
  const preview = firstNonEmptyText(item.diff, item.patch, item.content, item.preview);
  const extra = omitObjectKeys(item, [
    'type',
    'id',
    'path',
    'relativePath',
    'filePath',
    'targetPath',
    'uri',
    'name',
    'changeType',
    'operation',
    'kind',
    'event',
    'diff',
    'patch',
    'content',
    'preview',
    'status',
  ]);

  const body = [
    changeType ? `<div class="thread-item-meta-line">类型: ${escapeHtml(changeType)}</div>` : '',
    preview ? `<pre class="thread-item-pre">${escapeHtml(preview)}</pre>` : '',
    hasJsonValue(extra)
      ? `<pre class="thread-item-pre">${escapeHtml(JSON.stringify(extra, null, 2))}</pre>`
      : '',
  ]
    .filter(Boolean)
    .join('');

  return renderThreadItemCard({
    label: '文件变更',
    title,
    tone: 'fileChange',
    status: formatItemStatus(item.status),
    statusTone: item.status,
    collapsible: true,
    expanded: false,
    body: body || '<div class="thread-item-empty">暂无更多详情</div>',
  });
}

export function renderFallbackTurnItem(item) {
  return renderThreadItemCard({
    label: '通用事件',
    title: item.type ?? 'unknown',
    tone: 'generic',
    status: null,
    body: `<pre class="thread-item-pre">${escapeHtml(JSON.stringify(item, null, 2))}</pre>`,
  });
}

export function renderThreadItemCard({
  label,
  title,
  tone,
  status,
  statusTone = null,
  body,
  collapsible = false,
  expanded = true,
}) {
  const classes = ['thread-item-card', `thread-item-card--${tone}`];
  const statusBadge = renderThreadItemStatusBadge(status, statusTone);
  const cardHeader = renderThreadItemCardCopy({
    label,
    title,
    trailingMeta: collapsible ? '' : statusBadge,
  });

  if (collapsible) {
    classes.push('thread-item-card--collapsible');
    return [
      `<details class="${classes.join(' ')}"${expanded ? ' open' : ''}>`,
      '<summary class="thread-item-card-summary">',
      `<div class="thread-item-card-summary-copy">${cardHeader}</div>`,
      '<div class="thread-item-card-summary-meta">',
      statusBadge,
      renderThreadItemDisclosure(),
      '</div>',
      '</summary>',
      body ? `<div class="thread-item-card-body">${body}</div>` : '',
      '</details>',
    ].join('');
  }

  return [
    `<section class="${classes.join(' ')}">`,
    cardHeader,
    body ? `<div class="thread-item-card-body">${body}</div>` : '',
    '</section>',
  ].join('');
}

export function renderThreadItemCardCopy({ label, title, trailingMeta = '' }) {
  return [
    '<div class="thread-item-card-header">',
    `<div class="thread-item-card-label">${escapeHtml(label)}</div>`,
    trailingMeta,
    '</div>',
    `<div class="thread-item-card-title">${escapeHtml(title || 'Untitled')}</div>`,
  ].join('');
}

export function renderThreadItemStatusBadge(status, statusTone) {
  if (!status) {
    return '';
  }

  const tone = normalizeThreadItemStatusTone(statusTone);
  return `<span class="thread-item-card-status thread-item-card-status--${tone}">${escapeHtml(status)}</span>`;
}

export function renderThreadItemDisclosure() {
  return [
    '<span class="thread-item-card-toggle" aria-hidden="true">',
    '<span class="thread-item-card-toggle-label thread-item-card-toggle-label--expand">展开</span>',
    '<span class="thread-item-card-toggle-label thread-item-card-toggle-label--collapse">收起</span>',
    '<span class="thread-item-card-toggle-icon"></span>',
    '</span>',
  ].join('');
}

export function renderParagraphList(items) {
  const values = (items ?? []).map((item) => String(item ?? '').trim()).filter(Boolean);
  if (!values.length) {
    return '';
  }

  return values.map((value) => `<p class="thread-item-paragraph">${escapeHtml(value)}</p>`).join('');
}

export function renderKeyValueList(entries) {
  const values = entries.filter(([, value]) => value != null && String(value).trim() !== '');
  if (!values.length) {
    return '';
  }

  return values
    .map(([key, value]) => {
      return `<div class="thread-item-meta-line"><strong>${escapeHtml(key)}:</strong> ${escapeHtml(value)}</div>`;
    })
    .join('');
}

export function renderProgressList(messages) {
  const values = (messages ?? []).map((message) => String(message ?? '').trim()).filter(Boolean);
  if (!values.length) {
    return '';
  }

  return [
    '<div class="thread-item-section">',
    '<div class="thread-item-section-title">Progress</div>',
    values.map((message) => `<p class="thread-item-paragraph">${escapeHtml(message)}</p>`).join(''),
    '</div>',
  ].join('');
}

export function splitMultilineText(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function formatItemStatus(status) {
  if (!status) {
    return null;
  }

  const labels = {
    inProgress: '进行中',
    completed: '已完成',
    failed: '失败',
    pending: '待处理',
    success: '成功',
  };

  return labels[status] ?? String(status);
}

export function normalizeThreadItemStatusTone(status) {
  const normalized = String(status ?? '').trim();
  if (!normalized) {
    return 'neutral';
  }

  const knownStatuses = new Set(['inProgress', 'completed', 'failed', 'pending', 'success']);
  return knownStatuses.has(normalized) ? normalized : 'neutral';
}

export function hasJsonValue(value) {
  if (value == null) {
    return false;
  }

  if (typeof value === 'object') {
    return Object.keys(value).length > 0;
  }

  return String(value).trim().length > 0;
}

const TURN_ITEM_RENDERERS = {
  userMessage: renderUserMessageBubble,
  agentMessage(item) {
    const label = item.phase === 'final_answer' ? '助手' : '助手过程';
    return renderMessageBubble(label, item.text ?? '', 'assistant', {
      streaming: Boolean(item.streaming),
    });
  },
  plan: renderPlanTurnItem,
  reasoning: renderReasoningTurnItem,
  commandExecution: renderCommandExecutionTurnItem,
  fileChange: renderFileChangeTurnItem,
  mcpToolCall: renderMcpToolCallTurnItem,
  collabAgentToolCall: renderCollabAgentTurnItem,
};

export function collectSubagentEntries(session) {
  const subagentsById = new Map();

  for (const [turnIndex, turn] of (session.turns ?? []).entries()) {
    for (const item of turn.items ?? []) {
      if (item.type !== 'collabAgentToolCall') {
        continue;
      }

      const candidateIds = [
        ...(item.receiverThreadIds ?? []),
        ...Object.keys(item.agentsStates ?? {}),
      ].filter(Boolean);

      for (const agentId of [...new Set(candidateIds)]) {
        const agentState = item.agentsStates?.[agentId];
        const statusKey = agentState?.status ?? normalizeCollabToolCallStatus(item.status);
        subagentsById.set(agentId, {
          id: agentId,
          statusKey,
          statusLabel: formatCollabAgentStatus(statusKey),
          statusTone: getCollabAgentTone(statusKey),
          turnIndex,
          jumpTitle: `跳到第 ${turnIndex + 1} 回合查看 ${agentId}`,
        });
      }
    }
  }

  return [...subagentsById.values()].sort((left, right) => left.turnIndex - right.turnIndex);
}

export function formatCollabToolCall(item) {
  const agentIds = [...new Set([...(item.receiverThreadIds ?? []), ...Object.keys(item.agentsStates ?? {})])];
  const lines = [
    `工具: ${item.tool ?? 'unknown'}`,
    `目标: ${agentIds.join(', ') || 'unknown'}`,
  ];

  if (agentIds.length) {
    for (const agentId of agentIds) {
      const agentState = item.agentsStates?.[agentId];
      const statusKey = agentState?.status ?? normalizeCollabToolCallStatus(item.status);
      const message = agentState?.message;
      lines.push(`${agentId}: ${formatCollabAgentStatus(statusKey)}${message ? ` - ${message}` : ''}`);
    }
  } else {
    lines.push(`状态: ${formatCollabAgentStatus(normalizeCollabToolCallStatus(item.status))}`);
  }

  return lines.join('\n');
}

export function renderTaskPlanStep(step, index) {
  const statusTone = getPlanStepTone(step.status);
  return [
    '<div class="task-plan-step" role="listitem">',
    '<div class="task-plan-step-copy">',
    `<div class="task-plan-step-index">${index + 1}</div>`,
    `<div class="task-plan-step-text">${escapeHtml(step.step)}</div>`,
    '</div>',
    `<span class="task-plan-step-status task-plan-step-status--${statusTone}">${escapeHtml(formatPlanStepStatus(step.status))}</span>`,
    '</div>',
  ].join('');
}
