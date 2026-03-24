import { Buffer } from 'node:buffer';

export const CLAUDE_ATTACHMENT_CAPABILITIES = Object.freeze({
  maxAttachments: 10,
  maxBytesPerAttachment: 20 * 1024 * 1024,
  acceptedMimePatterns: Object.freeze(['image/*', 'text/*', 'application/pdf']),
  supportsNonImageFiles: true,
});

export function validateClaudeAttachments(attachments = []) {
  for (const attachment of attachments) {
    const mimeType = normalizeMimeType(attachment?.mimeType);
    if (mimeType.startsWith('image/')) {
      continue;
    }

    if (mimeType === 'application/pdf') {
      continue;
    }

    if (mimeType.startsWith('text/')) {
      continue;
    }

    throw createAttachmentError(
      `Claude only supports image, text, and PDF attachments. Unsupported MIME type: ${attachment?.mimeType ?? 'unknown'}`,
    );
  }
}

export function createClaudePromptStream({ text, attachments = [], sessionId = null }) {
  const content = [
    {
      type: 'text',
      text: String(text ?? ''),
    },
    ...mapClaudeAttachmentsToPromptBlocks(attachments),
  ];

  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'user',
        message: {
          role: 'user',
          content,
        },
        parent_tool_use_id: null,
        session_id: sessionId ?? '',
      };
    },
  };
}

export function createAttachmentSummaryFromClaudeContentBlock(block) {
  if (!block || typeof block !== 'object') {
    return null;
  }

  if (block.type === 'image') {
    const mimeType = normalizeMimeType(block?.source?.media_type);
    const sourceData = normalizeNonEmptyString(block?.source?.data);
    return {
      type: 'image',
      url:
        block?.source?.type === 'base64' && sourceData
          ? `data:${mimeType || 'image/*'};base64,${sourceData}`
          : null,
      mimeType: mimeType || 'image/*',
      name: null,
    };
  }

  if (block.type !== 'document') {
    return null;
  }

  const mimeType = normalizeMimeType(block?.source?.media_type);
  const attachmentType = classifyDocumentAttachmentType(mimeType);
  const dataBase64 =
    block?.source?.type === 'base64' ? normalizeNonEmptyString(block?.source?.data) : null;
  const textContent =
    block?.source?.type === 'text' ? normalizeContentString(block?.source?.data) : null;

  return omitNilValues({
    type: 'attachmentSummary',
    attachmentType,
    mimeType: mimeType || 'application/octet-stream',
    name: normalizeName(block?.title),
    dataBase64,
    textContent,
  });
}

function mapClaudeAttachmentsToPromptBlocks(attachments = []) {
  return attachments.map((attachment) => {
    const mimeType = normalizeMimeType(attachment?.mimeType);

    if (mimeType.startsWith('image/')) {
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: mimeType,
          data: attachment.dataBase64,
        },
      };
    }

    if (mimeType === 'application/pdf') {
      return {
        type: 'document',
        title: normalizeName(attachment?.name),
        source: {
          type: 'base64',
          media_type: mimeType,
          data: attachment.dataBase64,
        },
      };
    }

    return {
      type: 'document',
      title: normalizeName(attachment?.name),
      source: {
        type: 'text',
        media_type: 'text/plain',
        data: decodeTextAttachmentData(attachment?.dataBase64),
      },
    };
  });
}

function decodeTextAttachmentData(dataBase64) {
  return Buffer.from(String(dataBase64 ?? ''), 'base64').toString('utf8');
}

function normalizeMimeType(mimeType) {
  return String(mimeType ?? '').trim().toLowerCase();
}

function normalizeName(name) {
  const normalized = String(name ?? '').trim();
  return normalized || null;
}

function normalizeNonEmptyString(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function normalizeContentString(value) {
  const normalized = String(value ?? '');
  return normalized ? normalized : null;
}

function classifyDocumentAttachmentType(mimeType) {
  if (mimeType === 'application/pdf') {
    return 'pdf';
  }

  if (mimeType.startsWith('text/')) {
    return 'text';
  }

  return 'document';
}

function createAttachmentError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function omitNilValues(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value != null));
}
