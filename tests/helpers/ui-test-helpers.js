import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import MarkdownIt from 'markdown-it';

export function setupUiTestEnvironment() {
  globalThis.markdownit = (...args) => new MarkdownIt(...args);
}

export function readPublicFile(name) {
  const fileUrl = new URL(`../../public/${name}`, import.meta.url);
  const source = readFileSync(fileUrl, 'utf8');

  if (!name.endsWith('.css')) {
    return source;
  }

  return inlineCssImports(source, fileUrl);
}

export function createFakeEventSource() {
  return {
    onmessage: null,
    closed: false,
    emit(payload) {
      this.onmessage?.({ data: JSON.stringify(payload) });
    },
    close() {
      this.closed = true;
    },
  };
}

export function assertTaskSummaryItem(html, group, text) {
  assert.match(
    String(html ?? ''),
    new RegExp(
      `data-task-summary-item-group="${escapeRegExp(group)}"[\\s\\S]*?${escapeRegExp(text)}`,
    ),
  );
}

export function assertComposerSetting(html, key, label) {
  const normalizedHtml = String(html ?? '');
  assert.match(
    normalizedHtml,
    new RegExp(
      `data-composer-setting-label="${escapeRegExp(key)}"[\\s\\S]*?>${escapeRegExp(label)}<`,
    ),
  );
}

export function escapeRegExp(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function inlineCssImports(source, fileUrl) {
  return source.replace(/@import\s+['"](.+?)['"];/g, (_statement, relativePath) => {
    const importedUrl = new URL(relativePath, fileUrl);
    const importedSource = readFileSync(importedUrl, 'utf8');
    return inlineCssImports(importedSource, importedUrl);
  });
}

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export function jsonErrorResponse(body, status = 500) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export function createFakeDocument(options = {}) {
  const mobile = options.mobile === true;
  const appLayout = createFakeElement({ dataset: {} });
  const authGate = createFakeElement({ hidden: true });
  const authThemeToggle = createFakeElement({ dataset: {} });
  const loginForm = createFakeElement();
  const loginPassword = createFakeElement({ value: '' });
  const loginButton = createFakeElement({ textContent: '登录' });
  const loginError = createFakeElement({ textContent: '', hidden: true });
  const logoutButton = createFakeElement({ hidden: true });
  const sessionList = createFakeElement();
  const conversationBody = createFakeElement();
  const conversationNav = createFakeElement();
  const activityPanel = createFakeElement();
  const projectPanelToggle = createFakeElement({ dataset: {} });
  const activityPanelToggle = createFakeElement({ dataset: {} });
  const projectResizer = createFakeElement();
  const activityResizer = createFakeElement();
  const conversationStatus = createFakeElement({ dataset: {} });
  const conversationTitle = createFakeElement({ textContent: '会话视图' });
  const sessionDockPlanSummary = createFakeElement();
  const composer = createFakeElement({ dataset: {} });
  const composerAttachments = createFakeElement();
  const composerAttachmentError = createFakeElement();
  const composerInlineFeedback = createFakeElement();
  const composerInput = createFakeElement({ value: '' });
  const approvalModeControls = createFakeElement();
  const composerCollapseToggle = createFakeElement({ dataset: {}, textContent: '' });
  const composerUploadFileButton = createFakeElement({ dataset: {} });
  const composerUploadFileAction = createFakeElement({ dataset: {} });
  const composerUploadImageButton = createFakeElement({ dataset: {} });
  const composerAttachmentMenu = createFakeElement();
  const composerFileInput = createFakeElement({ files: [], click() {} });
  const composerImageInput = createFakeElement({ files: [], click() {} });
  const conversationNavToggle = createFakeElement({ checked: true });
  const sendButton = createFakeElement({ textContent: '', dataset: {} });
  const interruptButton = createFakeElement({ dataset: {} });
  const conversationScroll = createFakeElement({ scrollTop: 0 });
  const mobileDrawer = createFakeElement({
    open: false,
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
    },
  });
  const historyDialog = createFakeElement({
    open: false,
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
    },
  });
  const filePreviewDialog = createFakeElement({
    open: false,
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
    },
  });
  const rewriteDialog = createFakeElement({
    open: false,
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
    },
  });
  const rewriteDialogForm = createFakeElement();
  const rewriteDialogInput = createFakeElement({ value: '' });
  const rewriteDialogTitle = createFakeElement({ textContent: '当前会话' });
  const rewriteDialogPrimaryButton = createFakeElement({ dataset: {}, textContent: '新开分支重跑' });
  const rewriteDialogSecondaryButton = createFakeElement({ dataset: {}, textContent: '在当前会话重跑', hidden: true });
  let lastDownload = null;
  const body = {
    dataset: {},
    appendChild() {},
    removeChild() {},
  };

  const elements = new Map([
    ['#app-layout', appLayout],
    ['#auth-gate', authGate],
    ['#auth-theme-toggle', authThemeToggle],
    ['#login-form', loginForm],
    ['#login-password', loginPassword],
    ['#login-button', loginButton],
    ['#login-error', loginError],
    ['#logout-button', logoutButton],
    ['#session-list', sessionList],
    ['#conversation-body', conversationBody],
    ['#conversation-nav', conversationNav],
    ['#activity-panel', activityPanel],
    ['#project-panel-toggle', projectPanelToggle],
    ['#activity-panel-toggle', activityPanelToggle],
    ['#project-panel-resizer', projectResizer],
    ['#activity-panel-resizer', activityResizer],
    ['#conversation-status', conversationStatus],
    ['#conversation-title', conversationTitle],
    ['#session-dock-plan-summary', sessionDockPlanSummary],
    ['#composer', composer],
    ['#composer-attachments', composerAttachments],
    ['#composer-attachment-error', composerAttachmentError],
    ['#composer-inline-feedback', composerInlineFeedback],
    ['#composer-input', composerInput],
    ['#approval-mode-controls', approvalModeControls],
    ['#composer-collapse-toggle', composerCollapseToggle],
    ['#composer-upload-file', composerUploadFileButton],
    ['#composer-upload-file-action', composerUploadFileAction],
    ['#composer-upload-image', composerUploadImageButton],
    ['#composer-attachment-menu', composerAttachmentMenu],
    ['#composer-file-input', composerFileInput],
    ['#composer-image-input', composerImageInput],
    ['#conversation-nav-toggle', conversationNavToggle],
    ['#send-button', sendButton],
    ['#interrupt-button', interruptButton],
    ['#conversation-scroll', conversationScroll],
    ['#mobile-drawer', mobileDrawer],
    ['#history-dialog', historyDialog],
    ['#file-preview-dialog', filePreviewDialog],
    ['#rewrite-dialog', rewriteDialog],
    ['#rewrite-dialog-form', rewriteDialogForm],
    ['#rewrite-dialog-input', rewriteDialogInput],
    ['#rewrite-dialog-session-title', rewriteDialogTitle],
    ['#rewrite-dialog-submit-primary', rewriteDialogPrimaryButton],
    ['#rewrite-dialog-submit-secondary', rewriteDialogSecondaryButton],
  ]);

  wireConversationMetrics(conversationBody, conversationScroll);
  wireComposerMarkup({
    composer,
    sessionDockPlanSummary,
    composerAttachments,
    composerAttachmentError,
    composerInlineFeedback,
    approvalModeControls,
    composerCollapseToggle,
    composerUploadFileButton,
    composerUploadFileAction,
    composerUploadImageButton,
    composerAttachmentMenu,
    conversationNavToggle,
    sendButton,
    interruptButton,
  });

  return {
    appLayout,
    authGate,
    authThemeToggle,
    loginForm,
    loginPassword,
    loginButton,
    loginError,
    logoutButton,
    sessionList,
    conversationBody,
    conversationNav,
    activityPanel,
    projectPanelToggle,
    activityPanelToggle,
    projectResizer,
    activityResizer,
    conversationStatus,
    conversationTitle,
    sessionDockPlanSummary,
    composer,
    composerAttachments,
    composerAttachmentError,
    composerInlineFeedback,
    composerInput,
    approvalModeControls,
    composerCollapseToggle,
    composerUploadFileButton,
    composerUploadFileAction,
    composerUploadImageButton,
    composerAttachmentMenu,
    composerFileInput,
    composerImageInput,
    conversationNavToggle,
    sendButton,
    interruptButton,
    conversationScroll,
    mobileDrawer,
    historyDialog,
    filePreviewDialog,
    rewriteDialog,
    rewriteDialogForm,
    rewriteDialogInput,
    rewriteDialogTitle,
    rewriteDialogPrimaryButton,
    rewriteDialogSecondaryButton,
    body,
    documentElement: { dataset: {} },
    defaultView: createFakeWindow({ mobile }),
    createElement(tagName) {
      if (String(tagName).toLowerCase() === 'a') {
        return {
          href: '',
          download: '',
          target: '',
          rel: '',
          style: {},
          click() {
            lastDownload = {
              href: this.href,
              download: this.download,
              target: this.target,
              rel: this.rel,
            };
          },
        };
      }

      return createFakeElement();
    },
    querySelector(selector) {
      return elements.get(selector) ?? null;
    },
    get lastDownload() {
      return lastDownload;
    },
  };
}

export function createFakeElement(overrides = {}) {
  const listeners = new Map();
  const attributes = new Map();
  return {
    innerHTML: '',
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    open: false,
    hidden: false,
    value: '',
    textContent: '',
    disabled: false,
    checked: false,
    style: createFakeStyle(),
    addEventListener(type, handler) {
      if (!type || typeof handler !== 'function') {
        return;
      }

      const entries = listeners.get(type) ?? [];
      entries.push(handler);
      listeners.set(type, entries);
    },
    removeEventListener(type, handler) {
      if (!type || typeof handler !== 'function' || !listeners.has(type)) {
        return;
      }

      listeners.set(
        type,
        listeners.get(type).filter((entry) => entry !== handler),
      );
    },
    dispatchEvent(event) {
      const type = typeof event === 'string' ? event : event?.type;
      if (!type) {
        return false;
      }

      for (const handler of listeners.get(type) ?? []) {
        handler.call(this, event);
      }

      return true;
    },
    click() {
      this.dispatchEvent({ type: 'click' });
    },
    scrollTo(options) {
      if (typeof options === 'number') {
        this.scrollTop = options;
        return;
      }

      if (options && typeof options.top === 'number') {
        this.scrollTop = options.top;
      }
    },
    focus() {},
    select() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    ...overrides,
  };
}

export function createFakeStyle() {
  const values = new Map();
  return {
    setProperty(name, value) {
      values.set(name, value);
    },
    getPropertyValue(name) {
      return values.get(name) ?? '';
    },
  };
}

export function createFakeWindow({ mobile }) {
  const clipboardWrites = [];
  return {
    innerWidth: mobile ? 390 : 1280,
    navigator: {
      clipboard: {
        async writeText(text) {
          clipboardWrites.push(String(text));
        },
      },
    },
    __clipboardWrites: clipboardWrites,
    requestAnimationFrame(callback) {
      callback();
      return 1;
    },
    cancelAnimationFrame() {},
    matchMedia(query) {
      return {
        media: query,
        matches: mobile && query.includes('max-width: 760px'),
        addEventListener() {},
        removeEventListener() {},
      };
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

export function createFakeStorage(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
  };
}

export function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

export function createFakeFile({ name, type, text = '' }) {
  const encoded = new TextEncoder().encode(text);
  return {
    name,
    type,
    size: encoded.byteLength,
    async arrayBuffer() {
      return encoded.buffer.slice(0);
    },
    async text() {
      return text;
    },
  };
}

export function createClipboardImageItem(file) {
  return {
    type: file.type,
    getAsFile() {
      return file;
    },
  };
}

export function trackInnerHtmlWrites(element) {
  let value = element.innerHTML ?? '';
  let count = 0;
  Object.defineProperty(element, 'innerHTML', {
    configurable: true,
    enumerable: true,
    get() {
      return value;
    },
    set(nextValue) {
      value = String(nextValue);
      count += 1;
    },
  });

  return {
    get count() {
      return count;
    },
  };
}

function wireConversationMetrics(conversationBody, conversationScroll) {
  let value = conversationBody.innerHTML ?? '';
  Object.defineProperty(conversationBody, 'innerHTML', {
    configurable: true,
    enumerable: true,
    get() {
      return value;
    },
    set(nextValue) {
      value = String(nextValue);
      if (!conversationScroll.__autoMeasureHeight) {
        return;
      }

      const turnCount = (value.match(/data-turn-card="/g) ?? []).length;
      const headerHeight = value.includes('thread-header') ? 280 : 0;
      conversationScroll.scrollHeight = turnCount * 120 + headerHeight;
    },
  });
}

function wireComposerMarkup({
  composer,
  sessionDockPlanSummary,
  composerAttachments,
  composerAttachmentError,
  composerInlineFeedback,
  approvalModeControls,
  composerCollapseToggle,
  composerUploadFileButton,
  composerUploadFileAction,
  composerUploadImageButton,
  composerAttachmentMenu,
  conversationNavToggle,
  sendButton,
  interruptButton,
}) {
  let value = composer.innerHTML ?? '';
  Object.defineProperty(composer, 'innerHTML', {
    configurable: true,
    enumerable: true,
    get() {
      const attachmentMenuMarkup =
        composerAttachmentMenu.hidden
          ? ''
          : [
              '<div id="composer-attachment-menu">',
              composerUploadFileAction.hidden
                ? ''
                : `<button id="composer-upload-file-action">${composerUploadFileAction.textContent}</button>`,
              composerUploadImageButton.hidden
                ? ''
                : `<button id="composer-upload-image">${composerUploadImageButton.textContent}</button>`,
              '</div>',
            ].join('');
      return [
        sessionDockPlanSummary.hidden ? '' : sessionDockPlanSummary.innerHTML,
        composerAttachments.hidden ? '' : composerAttachments.innerHTML,
        `<button id="composer-upload-file" data-composer-attach-trigger="true" data-action="${composerUploadFileButton.dataset.action ?? ''}">${composerUploadFileButton.textContent}</button>`,
        attachmentMenuMarkup,
        composerAttachmentError.hidden
          ? ''
          : `<p id="composer-attachment-error">${composerAttachmentError.textContent}</p>`,
        composerInlineFeedback.hidden
          ? ''
          : `<p id="composer-inline-feedback">${composerInlineFeedback.textContent}</p>`,
        approvalModeControls.hidden ? '' : approvalModeControls.innerHTML,
        `<input id="conversation-nav-toggle"${conversationNavToggle.checked ? ' checked' : ''} />`,
        `<button id="send-button" data-action="${sendButton.dataset.action ?? ''}">${sendButton.textContent}</button>`,
        interruptButton.hidden
          ? ''
          : `<button id="interrupt-button" data-action="${interruptButton.dataset.action ?? ''}">${interruptButton.textContent}</button>`,
        `<button id="composer-collapse-toggle" data-collapsed="${composerCollapseToggle.dataset.collapsed ?? 'false'}">${composerCollapseToggle.textContent}</button>`,
      ].join('');
    },
    set(nextValue) {
      value = String(nextValue);
    },
  });
}
