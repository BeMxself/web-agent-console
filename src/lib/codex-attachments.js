export const CODEX_ATTACHMENT_CAPABILITIES = Object.freeze({
  maxAttachments: 10,
  maxBytesPerAttachment: 20 * 1024 * 1024,
  acceptedMimePatterns: Object.freeze(['image/*']),
  supportsNonImageFiles: false,
});

export function validateCodexAttachments(attachments = []) {
  for (const attachment of attachments) {
    if (isImageMimeType(attachment?.mimeType)) {
      continue;
    }

    throw createAttachmentError(
      `Codex only supports image attachments. Unsupported MIME type: ${attachment?.mimeType ?? 'unknown'}`,
    );
  }
}

export function mapCodexAttachmentsToInput(attachments = []) {
  return attachments.map((attachment) => ({
    type: 'image',
    url: `data:${attachment.mimeType};base64,${attachment.dataBase64}`,
  }));
}

function isImageMimeType(mimeType) {
  if (typeof mimeType !== 'string') {
    return false;
  }

  return mimeType.trim().toLowerCase().startsWith('image/');
}

function createAttachmentError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}
