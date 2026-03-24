import {
  formatAttachmentSize,
  validateDraftAttachments,
} from '../composer-attachments.js';
import {
  getDisplayName,
  readAttachmentTextContent,
} from './file-preview-utils.js';
import { findThreadMeta } from './project-utils.js';
import { normalizeRealtimeSessionState } from './thread-utils.js';
import {
  escapeHtml,
  isAuthenticatedAppState,
  isConversationNearBottom,
  scrollConversationToBottom,
} from './dom-utils.js';
import {
  buildRewritePromptEnvelope,
  firstNonEmptyText,
  getDisplayTextFromPrompt,
} from './text-utils.js';

export function canSendTurn(state, draftText = state.composerDraft) {
  if (!isAuthenticatedAppState(state)) {
    return false;
  }

  const hasDraftTarget = Boolean(state.selectedSessionId || state.pendingSessionProjectId);
  if (!hasDraftTarget || !String(draftText ?? '').trim()) {
    return false;
  }

  if (getComposerAttachmentError(state)) {
    return false;
  }

  const sessionId = state.selectedSessionId;
  if (!sessionId) {
    return true;
  }

  const sessionMeta =
    state.sessionDetailsById?.[sessionId] ?? findThreadMeta(state.projects ?? [], sessionId);
  if (
    sessionMeta?.waitingOnApproval ||
    Number(sessionMeta?.pendingApprovalCount ?? 0) > 0 ||
    sessionMeta?.waitingOnQuestion ||
    Number(sessionMeta?.pendingQuestionCount ?? 0) > 0
  ) {
    return false;
  }

  const status = state.turnStatusBySession[sessionId] ?? 'idle';
  return status !== 'started' && status !== 'interrupting';
}

export function canInterruptTurn(state) {
  if (!isAuthenticatedAppState(state)) {
    return false;
  }

  const sessionId = state.selectedSessionId;
  if (!sessionId) {
    return false;
  }

  const turnId = state.activeTurnIdBySession[sessionId];
  const status = state.turnStatusBySession[sessionId] ?? 'idle';
  return Boolean(turnId) && status === 'started';
}

export function extractUserText(item) {
  if (!Array.isArray(item.content)) {
    return '';
  }

  const rawText = item.content
    .map((entry) => {
      return entry.type === 'text' ? entry.text ?? '' : '';
    })
    .filter(Boolean)
    .join('\n');

  return getDisplayTextFromPrompt(rawText);
}

export function collectUserMessageAttachments(item) {
  if (!Array.isArray(item?.content)) {
    return [];
  }

  const attachments = [];

  for (const entry of item.content) {
    if (entry?.type === 'image') {
      attachments.push({
        itemId: item.id ?? null,
        index: attachments.length,
        kind: 'image',
        name: entry.name ?? '图片附件',
        mimeType: entry.mimeType ?? 'image/*',
        url: entry.url ?? null,
        previewText: null,
        dataBase64: null,
        textContent: null,
      });
      continue;
    }

    if (entry?.type === 'attachmentSummary') {
      attachments.push({
        itemId: item.id ?? null,
        index: attachments.length,
        kind: entry.attachmentType ?? 'file',
        name: entry.name ?? getDisplayName(null, inferAttachmentLabel(entry)),
        mimeType: entry.mimeType ?? 'application/octet-stream',
        url: entry.url ?? null,
        previewText: entry.previewText ?? null,
        dataBase64: entry.dataBase64 ?? null,
        textContent: readAttachmentTextContent(entry),
      });
    }
  }

  return attachments;
}

export function findConversationAttachment(thread, itemId, attachmentIndex) {
  const normalizedIndex = Number(attachmentIndex);
  if (!thread || !itemId || !Number.isInteger(normalizedIndex) || normalizedIndex < 0) {
    return null;
  }

  for (const turn of thread.turns ?? []) {
    for (const item of turn.items ?? []) {
      if (item?.id !== itemId) {
        continue;
      }

      return collectUserMessageAttachments(item)[normalizedIndex] ?? null;
    }
  }

  return null;
}

export function findLatestUserQuestion(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = turns[turnIndex];
    const item = (turn?.items ?? []).find((entry) => entry?.type === 'userMessage') ?? null;
    if (!item) {
      continue;
    }

    return {
      turnIndex,
      turn,
      item,
      text: extractUserText(item),
      attachments: collectUserMessageAttachments(item),
    };
  }

  return null;
}

export function findUserQuestionById(thread, userMessageId) {
  const normalizedTarget = String(userMessageId ?? '').trim();
  if (!normalizedTarget) {
    return null;
  }

  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    const turn = turns[turnIndex];
    const item = (turn?.items ?? []).find((entry) => entry?.id === normalizedTarget) ?? null;
    if (!item || item.type !== 'userMessage') {
      continue;
    }

    return {
      turnIndex,
      turn,
      item,
      text: extractUserText(item),
      attachments: collectUserMessageAttachments(item),
    };
  }

  return null;
}

export function getRewriteLastQuestionAction(state) {
  const sessionId = String(state?.selectedSessionId ?? '').trim();
  const detail = state?.sessionDetailsById?.[sessionId] ?? null;
  const latestQuestion = findLatestUserQuestion(detail);
  if (!latestQuestion?.text?.trim()) {
    return { visible: false, disabled: true, title: '当前会话没有可重写的上一条问题' };
  }

  return getRewriteQuestionAction(state, latestQuestion);
}

export function getRewriteQuestionAction(state, question) {
  if (!isAuthenticatedAppState(state)) {
    return { visible: false, disabled: true, title: '登录后才可重写问题' };
  }

  const sessionId = String(state?.selectedSessionId ?? '').trim();
  if (!sessionId) {
    return { visible: false, disabled: true, title: '选择会话后才可重写问题' };
  }

  const detail = state?.sessionDetailsById?.[sessionId] ?? null;
  if (!detail) {
    return { visible: false, disabled: true, title: '加载会话详情后才可重写问题' };
  }

  if (!question?.text?.trim()) {
    return { visible: false, disabled: true, title: '当前会话没有可重写的问题' };
  }

  const sessionMeta = detail ?? findThreadMeta(state?.projects ?? [], sessionId);
  const status = state?.turnStatusBySession?.[sessionId] ?? 'idle';
  if (status === 'started' || status === 'interrupting') {
    return { visible: true, disabled: true, title: '当前回合执行中，暂时不能重写问题' };
  }

  if (sessionMeta?.waitingOnApproval || Number(sessionMeta?.pendingApprovalCount ?? 0) > 0) {
    return { visible: true, disabled: true, title: '等待审批完成后再重写问题' };
  }

  if (sessionMeta?.waitingOnQuestion || Number(sessionMeta?.pendingQuestionCount ?? 0) > 0) {
    return { visible: true, disabled: true, title: '等待当前提问完成后再重写问题' };
  }

  if ((question.attachments ?? []).length > 0) {
    return { visible: true, disabled: true, title: '这个问题包含附件，暂不支持重写' };
  }

  return {
    visible: true,
    disabled: false,
    title: '重写这个问题，并在新会话中从该问题之前重新运行',
  };
}

export function buildRewriteLastQuestionPrompt(thread, rewrittenText, metadata = {}) {
  const latestQuestion = findLatestUserQuestion(thread);
  const normalizedText = String(rewrittenText ?? '').trim();
  if (!latestQuestion || !normalizedText) {
    return null;
  }

  const transcript = buildRewriteReplayTranscript(thread, latestQuestion.turnIndex);
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

export function buildRewriteReplayTranscript(thread, beforeTurnIndex) {
  const turns = Array.isArray(thread?.turns) ? thread.turns.slice(0, beforeTurnIndex) : [];
  const entries = turns.flatMap((turn) =>
    (turn?.items ?? [])
      .map((item) => formatReplayTranscriptEntry(item))
      .filter(Boolean),
  );
  return entries.join('\n\n');
}

export function formatReplayTranscriptEntry(item) {
  if (item?.type === 'userMessage') {
    const body = buildReplayUserMessageBody(item);
    return body ? `User:\n${body}` : null;
  }

  if (item?.type === 'agentMessage') {
    const text = firstNonEmptyText(item.text);
    return text ? `Assistant:\n${text}` : null;
  }

  return null;
}

export function buildReplayUserMessageBody(item) {
  const text = extractUserText(item);
  const attachments = collectUserMessageAttachments(item);
  const attachmentLines = attachments.map((attachment) => {
    const title = attachment.name ?? inferAttachmentLabel(attachment);
    const preview = firstNonEmptyText(attachment.previewText);
    return preview
      ? `[Attachment: ${title}] ${preview}`
      : `[Attachment: ${title}]`;
  });

  return [text, ...attachmentLines].filter(Boolean).join('\n');
}

export function formatStatus(status) {
  if (!status) {
    return 'unknown';
  }

  return typeof status === 'string' ? status : status.type ?? 'unknown';
}

export function formatApprovalKind(kind) {
  switch (kind) {
    case 'commandExecution':
      return '命令执行';
    case 'fileChange':
      return '文件变更';
    case 'permissions':
      return '权限';
    default:
      return kind ?? '审批';
  }
}

export function formatApprovalStatus(status) {
  switch (status) {
    case 'pending':
      return '待处理';
    case 'approved':
      return '已批准';
    case 'denied':
      return '已拒绝';
    case 'auto-approved':
      return '自动通过';
    default:
      return status ?? '未知';
  }
}

export function formatApprovalDetailLabel(key) {
  const labels = {
    command: '命令',
    cwd: '目录',
    reason: '原因',
    permissions: '权限',
    path: '路径',
    grantRoot: '根目录',
  };
  return labels[key] ?? key;
}

export function normalizeApprovalMode(mode) {
  return mode === 'manual' ? 'manual' : 'auto-approve';
}

export function createInitialSessionSettings() {
  return {
    model: null,
    reasoningEffort: null,
  };
}

export function createInitialSessionOptions() {
  return normalizeSessionOptions();
}

export function normalizeSessionSettings(settings) {
  const normalized = {
    model: normalizeSessionModel(settings?.model),
    reasoningEffort: normalizeSessionReasoningEffort(settings?.reasoningEffort),
  };

  const agentType = normalizeSessionAgentType(settings?.agentType);
  if (agentType) {
    normalized.agentType = agentType;
  }

  const sandboxMode = normalizeSessionSandboxMode(settings?.sandboxMode);
  if (sandboxMode) {
    normalized.sandboxMode = sandboxMode;
  }

  return normalized;
}

export function normalizeSessionModel(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

export function normalizeSessionReasoningEffort(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

export function normalizeSessionSandboxMode(value) {
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

export function normalizeSessionAgentType(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

export function normalizeSessionOptions(options = null) {
  const defaults = normalizeSessionSettings(options?.defaults);
  return {
    providerId: normalizeSessionProviderId(options?.providerId),
    attachmentCapabilities: normalizeSessionAttachmentCapabilities(options?.attachmentCapabilities),
    modelOptions: normalizeSessionOptionList(options?.modelOptions),
    reasoningEffortOptions: normalizeSessionOptionList(options?.reasoningEffortOptions),
    agentTypeOptions: normalizeSessionAgentTypeOptions(options?.agentTypeOptions, defaults.agentType),
    sandboxModeOptions: normalizeSessionOptionList(options?.sandboxModeOptions, { includeDefault: false }),
    defaults,
    runtimeContext: normalizeSessionRuntimeContext(options?.runtimeContext),
  };
}

export function normalizeSessionProviderId(providerId) {
  const normalized = String(providerId ?? '').trim();
  return normalized || null;
}

export function normalizeSessionAttachmentCapabilities(capabilities) {
  if (!capabilities || typeof capabilities !== 'object') {
    return null;
  }

  const maxAttachments = Number(capabilities.maxAttachments ?? 0);
  const maxBytesPerAttachment = Number(capabilities.maxBytesPerAttachment ?? 0);
  const acceptedMimePatterns = Array.isArray(capabilities.acceptedMimePatterns)
    ? capabilities.acceptedMimePatterns.map((pattern) => String(pattern ?? '').trim()).filter(Boolean)
    : [];

  if (
    !Number.isFinite(maxAttachments) ||
    maxAttachments < 0 ||
    !Number.isFinite(maxBytesPerAttachment) ||
    maxBytesPerAttachment < 0
  ) {
    return null;
  }

  return {
    maxAttachments,
    maxBytesPerAttachment,
    acceptedMimePatterns,
    supportsNonImageFiles: capabilities.supportsNonImageFiles === true,
  };
}

export function normalizeSessionRuntimeContext(runtimeContext) {
  if (!runtimeContext || typeof runtimeContext !== 'object') {
    return { sandboxMode: null };
  }

  return {
    sandboxMode: normalizeSessionSandboxMode(runtimeContext.sandboxMode),
  };
}

export function normalizeComposerAttachments(attachments) {
  return (attachments ?? [])
    .filter((attachment) => attachment && typeof attachment === 'object')
    .map((attachment) => ({
      id: String(attachment.id ?? ''),
      name: String(attachment.name ?? '未命名附件'),
      mimeType: String(attachment.mimeType ?? 'application/octet-stream'),
      size: Number(attachment.size ?? 0),
      dataBase64: String(attachment.dataBase64 ?? ''),
      preview: normalizeComposerAttachmentPreview(attachment.preview),
    }))
    .filter((attachment) => attachment.id && attachment.name && attachment.mimeType && attachment.dataBase64);
}

export function normalizeComposerAttachmentPreview(preview) {
  if (!preview || typeof preview !== 'object') {
    return null;
  }

  const kind = String(preview.kind ?? '').trim();
  if (!kind) {
    return null;
  }

  return {
    kind,
    url: preview.url ? String(preview.url) : null,
    text: preview.text ? String(preview.text) : null,
  };
}

export function normalizeComposerAttachmentError(error) {
  const normalized = String(error ?? '').trim();
  return normalized || null;
}

export function getComposerAttachmentError(state) {
  return (
    normalizeComposerAttachmentError(state?.composerAttachmentError) ??
    normalizeComposerAttachmentError(
      validateDraftAttachments(
        normalizeComposerAttachments(state?.composerAttachments),
        normalizeSessionOptions(state?.sessionOptions),
      ).error,
    )
  );
}

export function buildOptimisticUserContent(text, attachments = []) {
  const content = [{ type: 'text', text, text_elements: [] }];

  for (const attachment of normalizeComposerAttachments(attachments)) {
    if (attachment.mimeType.startsWith('image/')) {
      content.push({
        type: 'image',
        url:
          attachment.preview?.url ??
          `data:${attachment.mimeType};base64,${attachment.dataBase64}`,
        name: attachment.name,
        mimeType: attachment.mimeType,
      });
      continue;
    }

    content.push({
      type: 'attachmentSummary',
      attachmentType: attachment.mimeType === 'application/pdf' ? 'pdf' : 'text',
      mimeType: attachment.mimeType,
      name: attachment.name,
      previewText: attachment.preview?.text ?? null,
      dataBase64: attachment.mimeType === 'application/pdf' ? attachment.dataBase64 : null,
      textContent: attachment.mimeType.startsWith('text/')
        ? readAttachmentTextContent(attachment)
        : null,
    });
  }

  return content;
}

export function renderComposerAttachmentCard(attachment) {
  return [
    '<div class="composer-attachment-card" role="listitem">',
    attachment.preview?.kind === 'image' && attachment.preview?.url
      ? `<img class="composer-attachment-thumb" alt="${escapeHtml(attachment.name)}" src="${escapeHtml(attachment.preview.url)}" />`
      : `<div class="composer-attachment-placeholder">${escapeHtml(inferAttachmentLabel(attachment))}</div>`,
    '<div class="composer-attachment-copy">',
    `<div class="composer-attachment-title">${escapeHtml(attachment.name)}</div>`,
    `<div class="composer-attachment-meta">${escapeHtml(attachment.mimeType)} · ${escapeHtml(formatAttachmentSize(attachment.size))}</div>`,
    attachment.preview?.text
      ? `<div class="composer-attachment-preview">${escapeHtml(attachment.preview.text)}</div>`
      : '',
    '</div>',
    `<button class="composer-attachment-remove" type="button" data-composer-attachment-remove="${escapeHtml(attachment.id)}" aria-label="移除 ${escapeHtml(attachment.name)}">×</button>`,
    '</div>',
  ].join('');
}

export function inferAttachmentLabel(attachment) {
  const kind = String(attachment?.kind ?? attachment?.attachmentType ?? '').trim();
  if (kind === 'image') {
    return '图片附件';
  }

  if (kind === 'pdf') {
    return 'PDF 附件';
  }

  if (kind === 'text') {
    return '文本附件';
  }

  return '文件附件';
}

export function normalizeSessionOptionList(options, { includeDefault = true } = {}) {
  const normalizedOptions = [];
  const seenValues = new Set();

  for (const option of options ?? []) {
    const value = String(option?.value ?? '').trim();
    if (seenValues.has(value)) {
      continue;
    }

    const label = String(option?.label ?? '').trim() || value || '默认';
    normalizedOptions.push({ value, label });
    seenValues.add(value);
  }

  if (!includeDefault) {
    return normalizedOptions;
  }

  if (!seenValues.has('')) {
    normalizedOptions.unshift({ value: '', label: '默认' });
    return normalizedOptions;
  }

  const defaultOption = normalizedOptions.find((option) => option.value === '') ?? {
    value: '',
    label: '默认',
  };

  return [
    defaultOption,
    ...normalizedOptions.filter((option) => option.value !== ''),
  ];
}

export function normalizeSessionAgentTypeOptions(options, defaultAgentType = null) {
  return normalizeSessionOptionList(options, {
    includeDefault: !normalizeSessionAgentType(defaultAgentType),
  });
}

export function resolveSessionOptionLabel(options, value) {
  const normalizedValue = String(value ?? '');
  const match = (options ?? []).find((option) => String(option?.value ?? '') === normalizedValue);
  if (match?.label) {
    return match.label;
  }

  return normalizedValue || '默认';
}

export function resolveCurrentSandboxMode(sessionOptions, selectedSettings) {
  return (
    normalizeSessionSandboxMode(selectedSettings?.sandboxMode) ??
    normalizeSessionSandboxMode(sessionOptions?.defaults?.sandboxMode) ??
    normalizeSessionSandboxMode(sessionOptions?.runtimeContext?.sandboxMode) ??
    normalizeSessionSandboxMode(sessionOptions?.sandboxModeOptions?.[0]?.value)
  );
}

export function resolveCurrentAgentType(sessionOptions, selectedSettings) {
  return (
    normalizeSessionAgentType(selectedSettings?.agentType) ??
    normalizeSessionAgentType(sessionOptions?.defaults?.agentType)
  );
}

export function resolveSandboxModeLabel(sessionOptions, value) {
  const normalizedValue = normalizeSessionSandboxMode(value);
  if (!normalizedValue) {
    return '未提供';
  }

  const optionLabel = resolveSessionOptionLabel(sessionOptions?.sandboxModeOptions, normalizedValue);
  if (optionLabel !== normalizedValue) {
    return optionLabel;
  }

  switch (normalizedValue) {
    case 'read-only':
      return '只读';
    case 'workspace-write':
      return '工作区可写';
    case 'danger-full-access':
      return '完全访问';
    default:
      return normalizedValue;
  }
}

export function getSelectedSessionSettings(state) {
  const sessionId = String(state?.selectedSessionId ?? '').trim();
  return normalizeSessionSettings(
    sessionId ? state?.sessionSettingsById?.[sessionId] : createInitialSessionSettings(),
  );
}

export function canEditSessionSettings(state, sessionId = state?.selectedSessionId) {
  const targetSessionId = String(sessionId ?? '').trim();
  if (!isAuthenticatedAppState(state) || !targetSessionId) {
    return false;
  }

  return !isSessionBusy(state, targetSessionId);
}

export function isSessionBusy(state, sessionId) {
  const targetSessionId = String(sessionId ?? '').trim();
  if (!targetSessionId) {
    return false;
  }

  const status = state?.turnStatusBySession?.[targetSessionId] ?? 'idle';
  const realtime = normalizeRealtimeSessionState(state?.realtimeBySession?.[targetSessionId]);
  return status === 'started' || status === 'interrupting' || realtime.status === 'started';
}

export function formatTimestamp(value) {
  if (!value) {
    return 'Unknown time';
  }

  const timestamp = value > 1_000_000_000_000 ? value : value * 1000;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

export function shouldRefreshSessionAfterEvent(action) {
  return (
    action?.type === 'turn_completed' ||
    action?.type === 'session_runtime_reconciled' ||
    action?.type === 'approval_requested' ||
    action?.type === 'approval_resolved' ||
    action?.type === 'pending_question_requested' ||
    action?.type === 'pending_question_resolved'
  );
}

export function shouldAutoScrollConversation(previousState, nextState, action, conversationWindow, documentRef) {
  const autoScrollActionTypes = new Set([
    'user_turn_submitted',
    'turn_started',
    'thread_item_started',
    'thread_item_delta',
    'thread_item_completed',
    'turn_completed',
    'thread_realtime_started',
    'thread_realtime_item_added',
    'thread_realtime_audio_delta',
    'thread_realtime_error',
    'thread_realtime_closed',
  ]);
  if (!autoScrollActionTypes.has(action?.type)) {
    return false;
  }

  const threadId = action?.payload?.threadId ?? action?.payload?.thread?.id ?? null;
  if (!threadId || nextState?.selectedSessionId !== threadId) {
    return false;
  }

  if (conversationWindow && conversationWindow.hiddenAfterCount > 0) {
    return false;
  }

  if (action.type === 'user_turn_submitted' || action.type === 'turn_started') {
    return true;
  }

  return (
    previousState?.selectedSessionId === threadId &&
    isConversationNearBottom(documentRef)
  );
}

export function maybeAutoScrollConversation(documentRef, previousState, nextState, action, conversationWindow = null) {
  if (!shouldAutoScrollConversation(previousState, nextState, action, conversationWindow, documentRef)) {
    return null;
  }

  return scrollConversationToBottom(documentRef);
}
