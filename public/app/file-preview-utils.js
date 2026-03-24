const TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/javascript',
  'application/x-javascript',
  'application/typescript',
  'application/x-typescript',
  'application/xml',
  'application/x-sh',
  'application/x-shellscript',
  'application/yaml',
  'application/toml',
  'application/x-httpd-php',
]);

const TEXT_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.conf',
  '.cpp',
  '.cs',
  '.css',
  '.csv',
  '.cjs',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.ini',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.log',
  '.lua',
  '.md',
  '.mjs',
  '.php',
  '.py',
  '.rb',
  '.rs',
  '.sh',
  '.sql',
  '.svg',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
  '.zsh',
]);

const TEXT_BASENAMES = new Set([
  'AGENTS.md',
  'Dockerfile',
  'Gemfile',
  'LICENSE',
  'Makefile',
  'README',
  'README.md',
]);

const IMAGE_EXTENSIONS = new Set([
  '.apng',
  '.avif',
  '.bmp',
  '.gif',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.webp',
]);

const APP_PATH_PREFIXES = ['/api/', '/app.css', '/app.js', '/docs/', '/vendor/'];

export function parseLocalFileReference(href) {
  const normalizedHref = String(href ?? '').trim();
  if (!normalizedHref) {
    return null;
  }

  if (normalizedHref.startsWith('file://')) {
    return parseFileUriReference(normalizedHref);
  }

  if (!normalizedHref.startsWith('/') || normalizedHref.startsWith('//')) {
    return null;
  }

  if (APP_PATH_PREFIXES.some((prefix) => normalizedHref.startsWith(prefix))) {
    return null;
  }

  return parseAbsolutePathReference(normalizedHref);
}

export function buildLocalFilePreviewUrl(path) {
  return `/api/local-files/preview?path=${encodeURIComponent(String(path ?? ''))}`;
}

export function buildLocalFileListUrl(path) {
  return `/api/local-files/list?path=${encodeURIComponent(String(path ?? ''))}`;
}

export function buildLocalFileContentUrl(path, { download = false } = {}) {
  const query = `path=${encodeURIComponent(String(path ?? ''))}`;
  return `/api/local-files/content?${query}${download ? '&download=1' : ''}`;
}

export function isImageMimeType(mimeType) {
  return String(mimeType ?? '').trim().toLowerCase().startsWith('image/');
}

export function isTextLikeMimeType(mimeType) {
  const normalizedMimeType = String(mimeType ?? '').trim().toLowerCase();
  return normalizedMimeType.startsWith('text/') || TEXT_MIME_TYPES.has(normalizedMimeType);
}

export function isTextLikeFile({ mimeType = null, name = null, path = null } = {}) {
  if (isTextLikeMimeType(mimeType)) {
    return true;
  }

  const filename = getDisplayName(path, name).toLowerCase();
  if (TEXT_BASENAMES.has(getDisplayName(path, name))) {
    return true;
  }

  return TEXT_EXTENSIONS.has(getFileExtension(filename));
}

export function isImageFile({ mimeType = null, name = null, path = null } = {}) {
  if (isImageMimeType(mimeType)) {
    return true;
  }

  return IMAGE_EXTENSIONS.has(getFileExtension(getDisplayName(path, name).toLowerCase()));
}

export function buildAttachmentDownloadUrl(attachment) {
  if (typeof attachment?.url === 'string' && attachment.url.trim()) {
    return attachment.url;
  }

  if (typeof attachment?.dataBase64 === 'string' && attachment.dataBase64.trim()) {
    const mimeType = String(attachment?.mimeType ?? 'application/octet-stream');
    return `data:${mimeType};base64,${attachment.dataBase64}`;
  }

  if (typeof attachment?.textContent === 'string') {
    const mimeType = String(attachment?.mimeType ?? 'text/plain');
    return `data:${mimeType};base64,${encodeBase64Utf8(attachment.textContent)}`;
  }

  return null;
}

export function readAttachmentTextContent(attachment) {
  if (typeof attachment?.textContent === 'string') {
    return attachment.textContent;
  }

  if (!isTextLikeFile(attachment)) {
    return null;
  }

  if (typeof attachment?.dataBase64 === 'string' && attachment.dataBase64.trim()) {
    return decodeBase64Utf8(attachment.dataBase64);
  }

  return null;
}

export function getDisplayName(path, fallbackName = null) {
  const normalizedPath = String(path ?? '').trim();
  if (normalizedPath) {
    const segments = normalizedPath.split('/');
    return segments[segments.length - 1] || fallbackName || '未命名文件';
  }

  const normalizedName = String(fallbackName ?? '').trim();
  return normalizedName || '未命名文件';
}

export function normalizeFileLocation(line = null, column = null) {
  const normalizedLine = normalizePositiveInteger(line);
  const normalizedColumn = normalizePositiveInteger(column);

  return {
    line: normalizedLine,
    column: normalizedColumn,
    label:
      normalizedLine && normalizedColumn
        ? `L${normalizedLine}:C${normalizedColumn}`
        : normalizedLine
          ? `L${normalizedLine}`
          : '',
  };
}

export function splitPreviewTextLines(text) {
  const normalizedText = String(text ?? '');
  const lines = normalizedText.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.length ? lines : [''];
}

export function normalizePositiveInteger(value) {
  const normalizedValue = Number(value);
  if (!Number.isFinite(normalizedValue) || normalizedValue < 1) {
    return null;
  }

  return Math.round(normalizedValue);
}

function parseFileUriReference(href) {
  let parsedUrl = null;
  try {
    parsedUrl = new URL(href);
  } catch {
    return null;
  }

  const parsedReference = parseAbsolutePathReference(
    `${decodeURIComponent(parsedUrl.pathname)}${parsedUrl.hash ?? ''}`,
  );
  if (!parsedReference) {
    return null;
  }

  return {
    ...parsedReference,
    href,
  };
}

function parseAbsolutePathReference(href) {
  const [pathWithLocation, rawHash = ''] = href.split('#', 2);
  const decodedPathWithLocation = decodeURIComponent(pathWithLocation);
  const locationFromHash = parseHashLocation(rawHash);
  const locationFromSuffix = locationFromHash ? null : parseSuffixLocation(decodedPathWithLocation);
  const normalizedPath = decodeURIComponent(locationFromSuffix?.path ?? decodedPathWithLocation);

  return {
    href,
    path: normalizedPath,
    line: locationFromHash?.line ?? locationFromSuffix?.line ?? null,
    column: locationFromHash?.column ?? locationFromSuffix?.column ?? null,
  };
}

function parseHashLocation(rawHash) {
  const normalizedHash = String(rawHash ?? '').trim();
  if (!normalizedHash) {
    return null;
  }

  const lineColumnMatch = normalizedHash.match(/^L(?<line>\d+)(?:C(?<column>\d+))?$/i);
  if (!lineColumnMatch?.groups) {
    return null;
  }

  return {
    line: normalizePositiveInteger(lineColumnMatch.groups.line),
    column: normalizePositiveInteger(lineColumnMatch.groups.column),
  };
}

function parseSuffixLocation(path) {
  const suffixMatch = String(path ?? '').match(/^(?<path>.+?):(?<line>\d+)(?::(?<column>\d+))?$/);
  if (!suffixMatch?.groups) {
    return null;
  }

  return {
    path: suffixMatch.groups.path,
    line: normalizePositiveInteger(suffixMatch.groups.line),
    column: normalizePositiveInteger(suffixMatch.groups.column),
  };
}

function getFileExtension(path) {
  const dotIndex = String(path ?? '').lastIndexOf('.');
  if (dotIndex < 0) {
    return '';
  }

  return path.slice(dotIndex).toLowerCase();
}

function decodeBase64Utf8(dataBase64) {
  const normalized = String(dataBase64 ?? '');
  if (!normalized) {
    return '';
  }

  if (typeof atob === 'function' && typeof TextDecoder === 'function') {
    const binary = atob(normalized);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  return Buffer.from(normalized, 'base64').toString('utf8');
}

function encodeBase64Utf8(text) {
  const normalized = String(text ?? '');
  if (typeof TextEncoder === 'function' && typeof btoa === 'function') {
    let binary = '';
    for (const byte of new TextEncoder().encode(normalized)) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  }

  return Buffer.from(normalized, 'utf8').toString('base64');
}
