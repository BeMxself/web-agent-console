import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function loadJsonSnapshotFile({ filePath, emptySnapshot, normalizeSnapshot }) {
  const raw = await readFile(filePath, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  });

  if (!raw) {
    return normalizeSnapshot(emptySnapshot);
  }

  try {
    return normalizeSnapshot(JSON.parse(raw));
  } catch {
    await backupCorruptedFile(filePath);
    const normalized = normalizeSnapshot(emptySnapshot);
    await writeJsonSnapshotFile(filePath, normalized);
    return normalized;
  }
}

export async function writeJsonSnapshotFile(filePath, snapshot) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function backupCorruptedFile(filePath) {
  const backupPath = `${filePath}.corrupt-${Date.now()}`;
  await rename(filePath, backupPath).catch((error) => {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  });
  return backupPath;
}
