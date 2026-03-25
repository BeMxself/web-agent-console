import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';

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

const TEXT_BASENAMES = new Set(['AGENTS.md', 'Dockerfile', 'Gemfile', 'LICENSE', 'Makefile', 'README', 'README.md']);

export async function readLocalFilePreview(filePath) {
  const normalizedPath = assertAbsoluteLocalPath(filePath);
  const fileInfo = await getLocalFileInfo(normalizedPath);

  if (fileInfo.kind === 'text') {
    const content = await readFile(normalizedPath, 'utf8');
    return {
      kind: 'text',
      name: fileInfo.name,
      path: normalizedPath,
      mimeType: fileInfo.mimeType,
      content,
      lineCount: splitPreviewTextLines(content).length,
      downloadUrl: buildLocalFileContentUrl(normalizedPath, { download: true }),
    };
  }

  if (fileInfo.kind === 'image') {
    return {
      kind: 'image',
      name: fileInfo.name,
      path: normalizedPath,
      mimeType: fileInfo.mimeType,
      contentUrl: buildLocalFileContentUrl(normalizedPath),
      downloadUrl: buildLocalFileContentUrl(normalizedPath, { download: true }),
    };
  }

  return {
    kind: 'download',
    name: fileInfo.name,
    path: normalizedPath,
    mimeType: fileInfo.mimeType,
    downloadUrl: buildLocalFileContentUrl(normalizedPath, { download: true }),
  };
}

export async function readLocalFileContent(filePath) {
  const normalizedPath = assertAbsoluteLocalPath(filePath);
  const fileInfo = await getLocalFileInfo(normalizedPath);
  return {
    ...fileInfo,
    path: normalizedPath,
    content: await readFile(normalizedPath),
  };
}

export async function readLocalDirectory(dirPath) {
  const normalizedPath = assertAbsoluteLocalPath(resolveLocalDirectoryPath(dirPath));
  const directoryStats = await statExistingLocalPath(normalizedPath);
  if (!directoryStats.isDirectory()) {
    const error = new Error('Only directories can be listed');
    error.statusCode = 400;
    throw error;
  }

  const directoryEntries = await readdir(normalizedPath, { withFileTypes: true });
  const entries = (
    await Promise.all(
      directoryEntries.map(async (entry) => {
        const entryPath = join(normalizedPath, entry.name);
        if (entry.isDirectory()) {
          return {
            kind: 'directory',
            name: entry.name,
            path: entryPath,
          };
        }

        if (entry.isFile()) {
          return buildLocalDirectoryFileEntry(entry.name, entryPath);
        }

        const entryStats = await stat(entryPath).catch(() => null);
        if (entryStats?.isDirectory()) {
          return {
            kind: 'directory',
            name: entry.name,
            path: entryPath,
          };
        }

        if (entryStats?.isFile()) {
          return buildLocalDirectoryFileEntry(entry.name, entryPath);
        }

        return null;
      }),
    )
  )
    .filter(Boolean)
    .sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === 'directory' ? -1 : 1;
      }

      return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
    });

  const parentPath = dirname(normalizedPath);
  return {
    kind: 'directory',
    name: basename(normalizedPath) || normalizedPath,
    path: normalizedPath,
    parentPath: parentPath === normalizedPath ? null : parentPath,
    entries,
  };
}

function resolveLocalDirectoryPath(dirPath) {
  const normalizedPath = String(dirPath ?? '').trim();
  if (normalizedPath) {
    return normalizedPath;
  }

  const explicitHome = String(process.env.HOME ?? '').trim();
  if (explicitHome) {
    return explicitHome;
  }

  return String(homedir() ?? '').trim();
}

export function buildLocalFileContentUrl(filePath, { download = false } = {}) {
  const query = `path=${encodeURIComponent(String(filePath ?? ''))}`;
  return `/api/local-files/content?${query}${download ? '&download=1' : ''}`;
}

export function createContentDisposition(name) {
  return `attachment; filename="${sanitizeDownloadName(name)}"`;
}

function sanitizeDownloadName(name) {
  return String(name ?? 'download').replaceAll('"', '');
}

function assertAbsoluteLocalPath(path) {
  const normalizedPath = String(path ?? '').trim();
  if (!normalizedPath || !isAbsolute(normalizedPath)) {
    const error = new Error('Only absolute local file paths are supported');
    error.statusCode = 400;
    throw error;
  }

  return normalizedPath;
}

async function getLocalFileInfo(filePath) {
  const fileStats = await statExistingLocalPath(filePath);

  if (!fileStats.isFile()) {
    const error = new Error('Only regular files can be previewed');
    error.statusCode = 400;
    throw error;
  }

  const name = basename(filePath);
  const mimeType = inferMimeType(filePath);
  return {
    name,
    mimeType,
    kind: isImageMimeType(mimeType) ? 'image' : isTextLikeFile(filePath, mimeType) ? 'text' : 'download',
  };
}

async function statExistingLocalPath(path) {
  return stat(path).catch((error) => {
    if (error?.code === 'ENOENT') {
      const notFoundError = new Error('Local file not found');
      notFoundError.statusCode = 404;
      throw notFoundError;
    }

    throw error;
  });
}

function buildLocalDirectoryFileEntry(name, path) {
  const mimeType = inferMimeType(path);
  return {
    kind: 'file',
    name,
    path,
    mimeType,
    previewKind: isImageMimeType(mimeType) ? 'image' : isTextLikeFile(path, mimeType) ? 'text' : 'download',
  };
}

function inferMimeType(filePath) {
  const extension = extname(filePath).toLowerCase();
  switch (extension) {
    case '.apng':
      return 'image/apng';
    case '.avif':
      return 'image/avif';
    case '.bmp':
      return 'image/bmp';
    case '.css':
      return 'text/css';
    case '.gif':
      return 'image/gif';
    case '.html':
      return 'text/html';
    case '.jpeg':
    case '.jpg':
      return 'image/jpeg';
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'text/javascript';
    case '.json':
      return 'application/json';
    case '.md':
      return 'text/markdown';
    case '.pdf':
      return 'application/pdf';
    case '.png':
      return 'image/png';
    case '.svg':
      return 'image/svg+xml';
    case '.ts':
    case '.tsx':
      return 'text/typescript';
    case '.txt':
    case '.log':
      return 'text/plain';
    case '.xml':
      return 'application/xml';
    case '.yaml':
    case '.yml':
      return 'application/yaml';
    default:
      return 'application/octet-stream';
  }
}

function isImageMimeType(mimeType) {
  return String(mimeType ?? '').trim().toLowerCase().startsWith('image/');
}

function isTextLikeFile(filePath, mimeType) {
  const normalizedMimeType = String(mimeType ?? '').trim().toLowerCase();
  if (normalizedMimeType.startsWith('text/') || TEXT_MIME_TYPES.has(normalizedMimeType)) {
    return true;
  }

  const filename = basename(filePath);
  if (TEXT_BASENAMES.has(filename)) {
    return true;
  }

  return TEXT_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function splitPreviewTextLines(text) {
  const lines = String(text ?? '').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.length ? lines : [''];
}
