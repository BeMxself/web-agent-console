let nextAttachmentId = 1;

export async function createDraftAttachment(file) {
  const name = normalizeAttachmentName(file?.name);
  const mimeType = normalizeAttachmentMimeType(file);
  const size = normalizeAttachmentSize(file?.size);
  const dataBase64 = await readFileAsBase64(file);
  const preview = await buildAttachmentPreview(file, { mimeType, dataBase64 });

  return {
    id: `draft-attachment-${nextAttachmentId++}`,
    name,
    mimeType,
    size,
    dataBase64,
    preview,
  };
}

export async function readFileAsBase64(file) {
  if (typeof file?.dataBase64 === 'string' && file.dataBase64.length > 0) {
    return file.dataBase64;
  }

  if (typeof file?.arrayBuffer === 'function') {
    const buffer = await file.arrayBuffer();
    return arrayBufferToBase64(buffer);
  }

  if (typeof file?.text === 'function') {
    return textToBase64(await file.text());
  }

  throw new Error(`无法读取附件 ${normalizeAttachmentName(file?.name)}`);
}

export async function buildAttachmentPreview(file, { mimeType = normalizeAttachmentMimeType(file), dataBase64 = null } = {}) {
  try {
    if (mimeType.startsWith('image/')) {
      const imageData = dataBase64 ?? (await readFileAsBase64(file));
      return {
        kind: 'image',
        url: `data:${mimeType};base64,${imageData}`,
      };
    }

    if (mimeType === 'application/pdf') {
      return {
        kind: 'pdf',
        text: 'PDF 文档',
      };
    }

    if (mimeType.startsWith('text/')) {
      const previewText = await readTextPreview(file, dataBase64);
      return previewText
        ? {
            kind: 'text',
            text: previewText,
          }
        : null;
    }
  } catch {
    return null;
  }

  return null;
}

export async function ingestClipboardItems(items) {
  const files = [];

  for (const item of items ?? []) {
    if (normalizeMimeType(item?.type).startsWith('image/')) {
      const file = item?.getAsFile?.();
      if (file) {
        files.push(file);
      }
    }
  }

  const attachments = [];
  for (const file of files) {
    attachments.push(await createDraftAttachment(file));
  }

  return attachments;
}

export function validateDraftAttachments(attachments, sessionOptions) {
  const draftAttachments = Array.isArray(attachments) ? attachments : [];
  if (draftAttachments.length === 0) {
    return { error: null };
  }

  const capabilities = normalizeAttachmentCapabilities(sessionOptions?.attachmentCapabilities);
  const providerId = normalizeProviderId(sessionOptions?.providerId);
  if (!capabilities || !providerId) {
    return {
      error: '正在加载当前提供方的附件能力，请稍后再试。',
    };
  }

  if (
    capabilities.maxAttachments <= 0 ||
    capabilities.maxBytesPerAttachment <= 0 ||
    capabilities.acceptedMimePatterns.length === 0
  ) {
    return {
      error: `${formatProviderLabel(providerId)} 当前不支持附件。`,
    };
  }

  if (draftAttachments.length > capabilities.maxAttachments) {
    return {
      error: `最多只能添加 ${capabilities.maxAttachments} 个附件。`,
    };
  }

  for (const attachment of draftAttachments) {
    if (attachment.size > capabilities.maxBytesPerAttachment) {
      return {
        error: `附件“${attachment.name}”超过大小限制。`,
      };
    }

    if (!isAcceptedMimeType(attachment.mimeType, capabilities.acceptedMimePatterns)) {
      return {
        error: `${formatProviderLabel(providerId)} 不支持附件“${attachment.name}”（${attachment.mimeType}）。`,
      };
    }
  }

  return { error: null };
}

export function formatAttachmentSize(size) {
  const value = Number(size ?? 0);
  if (!Number.isFinite(value) || value < 1024) {
    return `${Math.max(0, Math.round(value))} B`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }

  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function normalizeAttachmentName(name) {
  const normalized = String(name ?? '').trim();
  return normalized || '未命名附件';
}

function normalizeAttachmentMimeType(file) {
  const explicit = normalizeMimeType(file?.type);
  if (explicit) {
    return explicit;
  }

  const lowerName = normalizeAttachmentName(file?.name).toLowerCase();
  if (lowerName.endsWith('.png')) {
    return 'image/png';
  }
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (lowerName.endsWith('.gif')) {
    return 'image/gif';
  }
  if (lowerName.endsWith('.webp')) {
    return 'image/webp';
  }
  if (lowerName.endsWith('.pdf')) {
    return 'application/pdf';
  }
  if (lowerName.endsWith('.md')) {
    return 'text/markdown';
  }
  if (lowerName.endsWith('.txt')) {
    return 'text/plain';
  }

  return 'application/octet-stream';
}

function normalizeAttachmentSize(size) {
  const value = Number(size ?? 0);
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function normalizeMimeType(mimeType) {
  return String(mimeType ?? '').trim().toLowerCase();
}

function normalizeProviderId(providerId) {
  const normalized = String(providerId ?? '').trim();
  return normalized || null;
}

function normalizeAttachmentCapabilities(capabilities) {
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
  };
}

function isAcceptedMimeType(mimeType, patterns) {
  const normalizedMimeType = normalizeMimeType(mimeType);
  return patterns.some((pattern) => {
    const normalizedPattern = normalizeMimeType(pattern);
    if (normalizedPattern.endsWith('/*')) {
      return normalizedMimeType.startsWith(normalizedPattern.slice(0, -1));
    }

    return normalizedMimeType === normalizedPattern;
  });
}

function formatProviderLabel(providerId) {
  if (providerId === 'codex') {
    return 'Codex';
  }

  if (providerId === 'claude-sdk') {
    return 'Claude';
  }

  if (providerId === 'agentapi') {
    return 'Agent API';
  }

  return '当前提供方';
}

async function readTextPreview(file, dataBase64 = null) {
  if (typeof file?.text === 'function') {
    return clipPreviewText(await file.text());
  }

  const encoded = dataBase64 ?? (await readFileAsBase64(file));
  return clipPreviewText(base64ToText(encoded));
}

function clipPreviewText(text) {
  const normalized = String(text ?? '').trim();
  if (!normalized) {
    return null;
  }

  return normalized.length > 180 ? `${normalized.slice(0, 180)}…` : normalized;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return globalThis.btoa(binary);
}

function textToBase64(text) {
  return arrayBufferToBase64(new TextEncoder().encode(String(text ?? '')));
}

function base64ToText(dataBase64) {
  const binary = globalThis.atob(String(dataBase64 ?? ''));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
