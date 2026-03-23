import { escapeHtml } from './dom-utils.js';
import {
  formatApprovalDetailLabel,
  formatApprovalKind,
  formatApprovalStatus,
} from './session-utils.js';
import {
  collectSubagentEntries,
  renderKeyValueList,
  renderThreadItemCard,
} from './render-turn-items.js';
import { hasRealtimeSessionData, normalizeRealtimeSessionState } from './thread-utils.js';

export function renderThreadSubagents(session) {
  const subagents = collectSubagentEntries(session);
  if (!subagents.length) {
    return '';
  }

  return [
    '<section class="thread-subagents">',
    '<div class="thread-subagents-header">',
    '<div class="thread-subagents-title">Subagents</div>',
    `<span class="meta-chip">${subagents.length}</span>`,
    '</div>',
    '<div class="thread-subagents-list">',
    subagents.map((entry) => renderThreadSubagent(entry)).join(''),
    '</div>',
    '</section>',
  ].join('');
}

export function renderThreadApprovals(session, approvalUiState = null) {
  const approvals = (session?.pendingApprovals ?? []).filter((approval) => approval?.status === 'pending');
  if (!approvals.length) {
    return '';
  }

  return [
    '<section class="thread-approvals">',
    '<div class="thread-approvals-header">',
    '<div class="thread-approvals-title">待处理审批</div>',
    `<span class="meta-chip">${approvals.length}</span>`,
    '</div>',
    approvalUiState?.error
      ? `<div class="approval-feedback" role="status">${escapeHtml(approvalUiState.error)}</div>`
      : '',
    '<div class="thread-approvals-list">',
    approvals.map((approval) => renderApprovalCard(approval, approvalUiState)).join(''),
    '</div>',
    '</section>',
  ].join('');
}

export function renderThreadPendingQuestions(session, pendingActionUiState = null) {
  const questions = (session?.pendingQuestions ?? []).filter((question) => question?.status === 'pending');
  if (!questions.length) {
    return '';
  }

  return [
    '<section class="thread-pending-questions">',
    '<div class="thread-pending-questions-header">',
    '<div class="thread-pending-questions-title">待处理问题</div>',
    `<span class="meta-chip">${questions.length}</span>`,
    '</div>',
    pendingActionUiState?.error
      ? `<div class="approval-feedback" role="status">${escapeHtml(pendingActionUiState.error)}</div>`
      : '',
    '<div class="thread-pending-questions-list">',
    questions.map((question) => renderPendingQuestionCard(question, pendingActionUiState)).join(''),
    '</div>',
    '</section>',
  ].join('');
}

export function renderPendingQuestionCard(question, pendingActionUiState = null) {
  const pending = pendingActionUiState?.pendingActionIds?.has?.(question.id) ?? false;
  const questionLines = (question?.questions ?? [])
    .map((entry) => normalizePendingQuestionLine(entry))
    .filter(Boolean)
    .map((line) => `<div class="approval-card-line">${escapeHtml(line)}</div>`)
    .join('');

  return [
    '<article class="approval-card approval-card--question">',
    '<div class="approval-card-header">',
    '<span class="approval-card-kind">Question</span>',
    `<span class="approval-card-status">${escapeHtml(formatPendingQuestionStatus(question.status))}</span>`,
    '</div>',
    `<div class="approval-card-summary">${escapeHtml(question.summary ?? question.prompt ?? '需要用户回答')}</div>`,
    question.prompt ? `<div class="approval-card-line">${escapeHtml(question.prompt)}</div>` : '',
    questionLines ? `<div class="approval-card-detail">${questionLines}</div>` : '',
    '<div class="pending-question-actions">',
    `<input class="pending-question-input" type="text" data-pending-action-input="${escapeHtml(question.id)}" placeholder="输入回复内容" value="${escapeHtml(question.response?.response ?? '')}" />`,
    `<button class="approval-card-button approval-card-button--approve" type="button" data-pending-action-submit="${escapeHtml(question.id)}"${pending ? ' disabled' : ''}>${pending ? '提交中…' : '提交回复'}</button>`,
    '</div>',
    '</article>',
  ].join('');
}

export function renderApprovalCard(approval, approvalUiState = null) {
  const detailLines = Object.entries(approval?.detail ?? {})
    .filter(([, value]) => value != null && String(value).trim() !== '')
    .map(([key, value]) => {
      const renderedValue = Array.isArray(value) ? value.join(' ') : String(value);
      return `<div class="approval-card-line"><strong>${escapeHtml(formatApprovalDetailLabel(key))}:</strong> ${escapeHtml(renderedValue)}</div>`;
    })
    .join('');
  const pending = approvalUiState?.pendingApprovalIds?.has?.(approval.id) ?? false;

  return [
    `<article class="approval-card approval-card--${escapeHtml(approval.kind ?? 'generic')}">`,
    '<div class="approval-card-header">',
    `<span class="approval-card-kind">${escapeHtml(formatApprovalKind(approval.kind))}</span>`,
    `<span class="approval-card-status">${escapeHtml(formatApprovalStatus(approval.status))}</span>`,
    '</div>',
    `<div class="approval-card-summary">${escapeHtml(approval.summary ?? '待确认操作')}</div>`,
    detailLines ? `<div class="approval-card-detail">${detailLines}</div>` : '',
    '<div class="approval-card-actions">',
    `<button class="approval-card-button approval-card-button--approve" type="button" data-approval-approve="${escapeHtml(approval.id)}"${pending ? ' disabled' : ''}>${pending ? '处理中…' : '批准'}</button>`,
    `<button class="approval-card-button approval-card-button--deny" type="button" data-approval-deny="${escapeHtml(approval.id)}"${pending ? ' disabled' : ''}>${pending ? '处理中…' : '拒绝'}</button>`,
    '</div>',
    '</article>',
  ].join('');
}

export function normalizePendingQuestionLine(entry) {
  if (!entry) {
    return null;
  }

  if (typeof entry === 'string') {
    return entry;
  }

  if (typeof entry?.question === 'string' && entry.question.trim()) {
    return entry.question;
  }

  if (typeof entry?.prompt === 'string' && entry.prompt.trim()) {
    return entry.prompt;
  }

  return null;
}

export function formatPendingQuestionStatus(status) {
  return status === 'answered' ? '已回答' : '待回答';
}

export function renderThreadSubagent(entry) {
  return [
    '<div class="thread-subagent-item">',
    '<div class="thread-subagent-copy">',
    `<span class="thread-subagent-name">${escapeHtml(entry.id)}</span>`,
    `<span class="thread-subagent-status thread-subagent-status--${escapeHtml(entry.statusTone)}">${escapeHtml(entry.statusLabel)}</span>`,
    '</div>',
    `<button class="thread-subagent-jump" type="button" data-subagent-turn-index="${entry.turnIndex}" title="${escapeHtml(entry.jumpTitle)}">跳转</button>`,
    '</div>',
  ].join('');
}

export function renderThreadRealtime(realtimeState) {
  const realtime = normalizeRealtimeSessionState(realtimeState);
  if (!hasRealtimeSessionData(realtime)) {
    return '';
  }

  const summaryBody = [
    renderKeyValueList([
      ['Session', realtime.sessionId],
      ['Items', realtime.items.length],
      ['Status', realtime.status],
    ]),
    realtime.lastError
      ? `<div class="thread-item-meta-line"><strong>Error:</strong> ${escapeHtml(realtime.lastError)}</div>`
      : '',
    realtime.closeReason
      ? `<div class="thread-item-meta-line"><strong>Closed:</strong> ${escapeHtml(realtime.closeReason)}</div>`
      : '',
  ]
    .filter(Boolean)
    .join('');

  const cards = [
    renderThreadItemCard({
      label: '实时',
      title: '实时流',
      tone: 'realtime',
      status: realtime.status,
      body: summaryBody,
    }),
  ];

  if (realtime.audioChunkCount > 0) {
    cards.push(
      renderThreadItemCard({
        label: 'Audio',
        title: '音频 Audio',
        tone: 'realtimeAudio',
        status: `${realtime.audioChunkCount} chunks`,
        body: renderKeyValueList([
          ['Chunk count', realtime.audioChunkCount],
          ['Base64 bytes', realtime.audioByteCount],
          [
            'Sample rate',
            realtime.lastAudio?.sampleRate ? `${realtime.lastAudio.sampleRate} Hz` : null,
          ],
          ['Channels', realtime.lastAudio?.numChannels],
          ['Samples / channel', realtime.lastAudio?.samplesPerChannel],
        ]),
      }),
    );
  }

  if (realtime.items.length) {
    cards.push(
      renderThreadItemCard({
        label: '事件',
        title: 'Realtime items',
        tone: 'realtime',
        status: `${realtime.items.length}`,
        body: renderRealtimeItems(realtime.items),
      }),
    );
  }

  return [
    '<section class="thread-realtime">',
    '<div class="thread-realtime-header">',
    '<div class="thread-realtime-title">实时流</div>',
    `<span class="meta-chip">${escapeHtml(realtime.status)}</span>`,
    '</div>',
    '<div class="thread-realtime-list">',
    cards.join(''),
    '</div>',
    '</section>',
  ].join('');
}

export function renderRealtimeItems(items) {
  return items
    .map((item) => {
      return [
        '<div class="thread-item-section">',
        `<div class="thread-item-section-title">#${item.index} ${escapeHtml(item.summary)}</div>`,
        `<pre class="thread-item-pre">${escapeHtml(JSON.stringify(item.value, null, 2))}</pre>`,
        '</div>',
      ].join('');
    })
    .join('');
}
