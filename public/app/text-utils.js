export function firstNonEmptyText(...values) {
  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (normalized) {
      return normalized;
    }
  }

  return '';
}

export function omitObjectKeys(value, keysToSkip) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const skippedKeys = new Set(keysToSkip);
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !skippedKeys.has(key)),
  );
}

export function preferThreadText(primary, fallback) {
  if (typeof primary === 'string' && primary.trim()) {
    return primary;
  }

  return fallback ?? primary ?? null;
}
