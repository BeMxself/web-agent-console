import { createHmac, timingSafeEqual } from 'node:crypto';

const DEFAULT_COOKIE_NAME = 'web-agent-auth';

export function createAuth(config = {}) {
  const password = normalizeOptionalString(config.authPassword);
  const secret = normalizeOptionalString(config.authCookieSecret);
  const enabled = Boolean(config.authEnabled && password && secret);
  const cookieName = config.authCookieName ?? DEFAULT_COOKIE_NAME;

  return {
    enabled,
    cookieName,
    isAuthenticated(req) {
      if (!enabled) {
        return true;
      }

      const cookies = parseCookieHeader(req.headers.cookie);
      const token = cookies[cookieName];
      return Boolean(token && verifySessionToken(token, secret));
    },
    createLoginCookie(candidatePassword) {
      if (!enabled) {
        return null;
      }

      if (normalizeOptionalString(candidatePassword) !== password) {
        return null;
      }

      const payload = Buffer.from(
        JSON.stringify({
          v: 1,
          iat: Date.now(),
        }),
        'utf8',
      ).toString('base64url');
      const signature = signValue(payload, secret);
      return serializeCookie(cookieName, `${payload}.${signature}`);
    },
    createLogoutCookie() {
      return serializeCookie(cookieName, '', {
        expires: new Date(0),
        maxAge: 0,
      });
    },
  };
}

function verifySessionToken(token, secret) {
  const [payload, signature] = String(token ?? '').split('.');
  if (!payload || !signature) {
    return false;
  }

  const expected = signValue(payload, secret);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  try {
    return timingSafeEqual(actualBuffer, expectedBuffer);
  } catch {
    return false;
  }
}

function signValue(value, secret) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function parseCookieHeader(cookieHeader) {
  const cookies = {};
  for (const entry of String(cookieHeader ?? '').split(';')) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const name = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (!name) {
      continue;
    }

    cookies[name] = decodeURIComponent(value);
  }

  return cookies;
}

function serializeCookie(name, value, options = {}) {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];

  if (typeof options.maxAge === 'number') {
    attributes.push(`Max-Age=${options.maxAge}`);
  }

  if (options.expires instanceof Date) {
    attributes.push(`Expires=${options.expires.toUTCString()}`);
  }

  return attributes.join('; ');
}

function normalizeOptionalString(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}
