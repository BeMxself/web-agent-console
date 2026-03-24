import { escapeHtml } from './dom-utils.js';
import { getDisplayName, normalizeFileLocation, splitPreviewTextLines } from './file-preview-utils.js';

export function renderFilePreviewDialog(preview) {
  if (!preview?.open) {
    return '';
  }

  const title = getDisplayName(preview.path, preview.name);
  const location = normalizeFileLocation(preview.line, preview.column);
  const metadata = [
    preview.path ? `<span class="file-preview-meta-item">${escapeHtml(preview.path)}</span>` : '',
    preview.mimeType ? `<span class="file-preview-meta-item">${escapeHtml(preview.mimeType)}</span>` : '',
    location.label ? `<span class="file-preview-meta-item">${escapeHtml(location.label)}</span>` : '',
  ]
    .filter(Boolean)
    .join('');

  const body =
    preview.kind === 'image'
      ? renderImagePreviewBody(preview)
      : preview.kind === 'error'
        ? renderErrorPreviewBody(preview)
        : renderTextPreviewBody(preview, location.line);

  return [
    '<div class="file-preview-shell">',
    '<div class="file-preview-header">',
    '<div class="file-preview-header-copy">',
    `<div class="file-preview-title">${escapeHtml(title)}</div>`,
    metadata ? `<div class="file-preview-meta">${metadata}</div>` : '',
    '</div>',
    '<button class="history-dialog-close" type="button" data-file-preview-close="true" aria-label="关闭">×</button>',
    '</div>',
    body,
    '</div>',
  ].join('');
}

function renderTextPreviewBody(preview, highlightLine) {
  return [
    '<div class="file-preview-code" role="presentation">',
    splitPreviewTextLines(preview.content)
      .map((line, index) => renderPreviewLine(line, index + 1, highlightLine))
      .join(''),
    '</div>',
  ].join('');
}

function renderPreviewLine(line, lineNumber, highlightLine) {
  const highlighted = lineNumber === highlightLine;
  return [
    `<div class="file-preview-line${highlighted ? ' file-preview-line--highlight' : ''}"${highlighted ? ' data-file-preview-highlight="true"' : ''}>`,
    `<span class="file-preview-line-number" data-file-preview-line-number="${lineNumber}">${lineNumber}</span>`,
    `<span class="file-preview-line-content">${line ? escapeHtml(line) : '&nbsp;'}</span>`,
    '</div>',
  ].join('');
}

function renderImagePreviewBody(preview) {
  return [
    '<div class="file-preview-image-shell">',
    `<img class="file-preview-image" alt="${escapeHtml(getDisplayName(preview.path, preview.name))}" src="${escapeHtml(preview.imageUrl)}" />`,
    '</div>',
  ].join('');
}

function renderErrorPreviewBody(preview) {
  return [
    '<div class="file-preview-error">',
    `<div class="file-preview-error-title">${escapeHtml(preview.title ?? '文件预览失败')}</div>`,
    `<div class="file-preview-error-message">${escapeHtml(preview.message ?? '无法打开这个文件。')}</div>`,
    '</div>',
  ].join('');
}
