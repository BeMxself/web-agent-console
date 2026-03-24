import { escapeHtml } from './dom-utils.js';
import {
  canEditSessionSettings,
  getSelectedSessionSettings,
  isSessionBusy,
  normalizeApprovalMode,
  normalizeSessionOptions,
  resolveCurrentAgentType,
  resolveCurrentSandboxMode,
  resolveSandboxModeLabel,
  resolveSessionOptionLabel,
} from './session-utils.js';
import {
  getComposerSettingsScopeId,
  isComposerSettingsCollapsed,
} from './render-activity.js';
import { firstNonEmptyText } from './text-utils.js';

export function renderApprovalModeControls(
  state,
  approvalUiState = null,
  sessionSettingsUiState = null,
  { mobileViewport = false } = {},
) {
  const normalizedMode = normalizeApprovalMode(state?.approvalMode);
  const sessionOptions = normalizeSessionOptions(state?.sessionOptions);
  const selectedSettings = getSelectedSessionSettings(state);
  const selectedSessionId = String(state?.selectedSessionId ?? '').trim();
  const sessionBusy = isSessionBusy(state, selectedSessionId);
  const approvalPending = approvalUiState?.approvalModePending === true;
  const sessionSettingsPending =
    sessionSettingsUiState?.pending === true &&
    sessionSettingsUiState?.pendingThreadId === selectedSessionId;
  const sessionSettingsDisabled =
    sessionSettingsPending || !canEditSessionSettings(state, selectedSessionId);
  const approvalDisabled = approvalPending || sessionBusy;
  const agentType = resolveCurrentAgentType(sessionOptions, selectedSettings);
  const agentTypeValueLabel = resolveSessionOptionLabel(sessionOptions.agentTypeOptions, agentType);
  const sandboxMode = resolveCurrentSandboxMode(sessionOptions, selectedSettings);
  const sandboxValueLabel = resolveSandboxModeLabel(sessionOptions, sandboxMode);
  const inlineFeedback = [
    sessionSettingsUiState?.error
      ? `<div class="approval-feedback approval-feedback--inline" role="status">${escapeHtml(sessionSettingsUiState.error)}</div>`
      : '',
    approvalUiState?.error
      ? `<div class="approval-feedback approval-feedback--inline" role="status">${escapeHtml(approvalUiState.error)}</div>`
      : '',
  ]
    .filter(Boolean)
    .join('');

  const settingDescriptors = [
    ...(sessionOptions.agentTypeOptions.length
      ? [
          {
            kind: 'select',
            settingKey: 'agent',
            label: 'Agent 类型',
            ariaLabel: 'Agent 类型',
            dataAttribute: 'data-session-agent-select',
            options: sessionOptions.agentTypeOptions,
            value: agentType,
            disabled: sessionSettingsDisabled,
            pending: sessionSettingsPending,
            valueLabel: agentTypeValueLabel,
          },
        ]
      : []),
    {
      kind: 'select',
      settingKey: 'model',
      label: '模型',
      ariaLabel: '模型',
      dataAttribute: 'data-session-model-select',
      options: sessionOptions.modelOptions,
      value: selectedSettings.model,
      disabled: sessionSettingsDisabled,
      pending: sessionSettingsPending,
      valueLabel: resolveSessionOptionLabel(sessionOptions.modelOptions, selectedSettings.model),
    },
    {
      kind: 'select',
      settingKey: 'reasoning',
      label: '推理强度',
      ariaLabel: '推理强度',
      dataAttribute: 'data-session-reasoning-select',
      options: sessionOptions.reasoningEffortOptions,
      value: selectedSettings.reasoningEffort,
      disabled: sessionSettingsDisabled,
      pending: sessionSettingsPending,
      valueLabel: resolveSessionOptionLabel(
        sessionOptions.reasoningEffortOptions,
        selectedSettings.reasoningEffort,
      ),
    },
    sessionOptions.sandboxModeOptions.length
      ? {
          kind: 'select',
          settingKey: 'sandbox',
          label: '沙箱类型',
          ariaLabel: '沙箱类型',
          dataAttribute: 'data-session-sandbox-select',
          options: sessionOptions.sandboxModeOptions,
          value: sandboxMode,
          disabled: sessionSettingsDisabled,
          pending: sessionSettingsPending,
          valueLabel: sandboxValueLabel,
        }
      : {
          kind: 'readonly',
          settingKey: 'sandbox',
          label: '沙箱类型',
          value: sandboxValueLabel,
        },
    {
      kind: 'select',
      settingKey: 'approval',
      label: '审批模式',
      ariaLabel: '审批模式',
      dataAttribute: 'data-approval-mode-select',
      options: [
        { value: 'manual', label: '手动审批' },
        { value: 'auto-approve', label: '自动通过' },
      ],
      value: normalizedMode,
      disabled: approvalDisabled,
      pending: approvalPending,
      valueLabel: resolveSessionOptionLabel(
        [
          { value: 'manual', label: '手动审批' },
          { value: 'auto-approve', label: '自动通过' },
        ],
        normalizedMode,
      ),
    },
  ];
  const controlsMarkup = settingDescriptors
    .map((descriptor) => renderComposerSettingControl(descriptor))
    .join('');
  const scopeId = getComposerSettingsScopeId(state);
  const collapsed = isComposerSettingsCollapsed(state, scopeId, mobileViewport);

  return [
    `<div class="composer-settings-mobile-shell" data-composer-settings-collapsed="${String(collapsed)}">`,
    renderComposerSettingsSummary(settingDescriptors, scopeId, collapsed),
    `<div class="composer-settings-mobile-panel"${collapsed ? ' hidden' : ''}>`,
    '<div class="composer-settings-row" role="group" aria-label="会话与审批设置">',
    controlsMarkup,
    '</div>',
    '</div>',
    inlineFeedback,
    '</div>',
  ].join('');
}

export function renderComposerSettingControl(descriptor) {
  return descriptor.kind === 'readonly'
    ? renderSettingsReadonlyControl(descriptor)
    : renderSettingsSelectControl(descriptor);
}

export function renderComposerSettingsSummary(settingDescriptors, scopeId, collapsed) {
  const actionButton = collapsed
    ? `<button class="composer-settings-mobile-toggle" type="button" data-composer-settings-toggle="true" data-composer-settings-scope="${escapeHtml(scopeId)}" aria-expanded="false" aria-label="展开设置底栏">▾</button>`
    : `<button class="composer-settings-mobile-confirm" type="button" data-composer-settings-toggle="true" data-composer-settings-confirm="true" data-composer-settings-scope="${escapeHtml(scopeId)}" aria-label="确认并收起设置底栏">确认</button>`;

  return [
    '<div class="composer-settings-mobile-summary-row">',
    '<div class="composer-settings-mobile-summary" data-composer-settings-summary="true" role="note" aria-label="当前会话设置摘要">',
    settingDescriptors.map((descriptor) => renderComposerSettingsSummaryItem(descriptor)).join(''),
    '</div>',
    actionButton,
    '</div>',
  ].join('');
}

export function renderComposerSettingsSummaryItem(descriptor) {
  const value = formatComposerSettingsSummaryValue(descriptor);
  const label = `${descriptor.label}：${value}`;
  return [
    `<span class="composer-settings-mobile-summary-item" data-composer-settings-summary-item="${escapeHtml(descriptor.settingKey)}" aria-label="${escapeHtml(label)}">`,
    `<span class="composer-settings-mobile-summary-icon" data-composer-settings-summary-icon="${escapeHtml(descriptor.settingKey)}" aria-hidden="true">${renderComposerSettingsSummaryIcon(descriptor.settingKey)}</span>`,
    `<span class="composer-settings-mobile-summary-value">${escapeHtml(value)}</span>`,
    '</span>',
  ].join('');
}

export function formatComposerSettingsSummaryValue(descriptor) {
  const value = descriptor.kind === 'readonly' ? descriptor.value : descriptor.valueLabel;
  const fallback = descriptor.kind === 'readonly' ? '未提供' : '默认';
  return firstNonEmptyText(value) ?? fallback;
}

export function renderComposerSettingsSummaryIcon(settingKey) {
  switch (settingKey) {
    case 'model':
      return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="3" width="11" height="8" rx="2"></rect><path d="M5.5 13h5"></path></svg>';
    case 'reasoning':
      return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.5v2"></path><path d="M8 11.5v2"></path><path d="M4.1 4.1l1.4 1.4"></path><path d="M10.5 10.5l1.4 1.4"></path><path d="M2.5 8h2"></path><path d="M11.5 8h2"></path><path d="M4.1 11.9l1.4-1.4"></path><path d="M10.5 5.5l1.4-1.4"></path></svg>';
    case 'agent':
      return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="4.5" r="1.7"></circle><path d="M8 6.4v2.1"></path><path d="M4.5 13.2V11a1.8 1.8 0 0 1 1.8-1.8h3.4A1.8 1.8 0 0 1 11.5 11v2.2"></path><path d="M2.8 8.4h1.7"></path><path d="M11.5 8.4h1.7"></path></svg>';
    case 'sandbox':
      return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.2l4 1.6v3.3c0 2.6-1.6 4.9-4 6-2.4-1.1-4-3.4-4-6V3.8l4-1.6z"></path><path d="M6.6 7.7V6.8a1.4 1.4 0 1 1 2.8 0v0.9"></path><rect x="5.3" y="7.7" width="5.4" height="3.3" rx="1"></rect></svg>';
    case 'approval':
      return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.2"></circle><path d="M5.8 8.1l1.4 1.5 3-3.1"></path></svg>';
    default:
      return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.2"></circle></svg>';
  }
}

export function renderSettingsSelectControl({
  settingKey,
  label,
  ariaLabel,
  dataAttribute,
  options,
  value,
  disabled = false,
  pending = false,
}) {
  const normalizedValue = String(value ?? '');
  return [
    `<div class="composer-settings-item composer-settings-item--editable" data-composer-setting="${escapeHtml(settingKey)}">`,
    `<span class="composer-settings-item-label" data-composer-setting-label="${escapeHtml(settingKey)}">${escapeHtml(label)}</span>`,
    `<label class="composer-settings-select-wrap${pending ? ' composer-settings-select-wrap--pending' : ''}">`,
    `<span class="sr-only">${escapeHtml(ariaLabel)}</span>`,
    `<select class="composer-settings-select approval-mode-select" ${dataAttribute}="true" aria-label="${escapeHtml(ariaLabel)}"${disabled ? ' disabled' : ''}>`,
    (options ?? [])
      .map((option) =>
        renderSettingsSelectOption(option?.value ?? '', option?.label ?? '', normalizedValue),
      )
      .join(''),
    '</select>',
    '<span class="composer-settings-select-icon approval-mode-select-icon" aria-hidden="true">▾</span>',
    '</label>',
    '</div>',
  ].join('');
}

export function renderSettingsReadonlyControl({ settingKey, label, value }) {
  return [
    `<div class="composer-settings-item composer-settings-item--readonly" data-composer-setting="${escapeHtml(settingKey)}">`,
    `<span class="composer-settings-item-label" data-composer-setting-label="${escapeHtml(settingKey)}">${escapeHtml(label)}</span>`,
    `<span class="composer-settings-item-value" data-composer-setting-value="${escapeHtml(settingKey)}">${escapeHtml(value)}</span>`,
    '</div>',
  ].join('');
}

export function renderSettingsSelectOption(value, label, activeValue) {
  const normalizedValue = String(value ?? '');
  return `<option value="${escapeHtml(normalizedValue)}"${normalizedValue === activeValue ? ' selected' : ''}>${escapeHtml(label)}</option>`;
}
