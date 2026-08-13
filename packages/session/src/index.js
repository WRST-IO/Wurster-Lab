const MIN_TTL_MS = 60 * 1000;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;

function secureId() {
  if (!globalThis.crypto?.getRandomValues) throw new Error('Secure randomness is required for Wurster sessions');
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let text = '';
  for (const value of bytes) text += String.fromCharCode(value);
  if (typeof btoa === 'function') return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export function parseSessionDuration(value, { defaultMs = DEFAULT_TTL_MS, maxMs = MAX_TTL_MS } = {}) {
  if (value == null || value === '') return Math.min(defaultMs, maxMs);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) throw new Error('Invalid Wurster session duration');
    return Math.max(MIN_TTL_MS, Math.min(Math.round(value), maxMs));
  }
  const text = String(value).trim().toLowerCase();
  if (!text || text === 'default') return Math.min(defaultMs, maxMs);
  if (text === 'until-close' || text === 'session') return Math.min(defaultMs, maxMs);
  const match = text.match(/^(\d+(?:\.\d+)?)(s|m|h|d)$/);
  if (!match) throw new Error(`Invalid Wurster session duration: ${value}`);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
  const parsed = Number(match[1]) * unit;
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('Invalid Wurster session duration');
  return Math.max(MIN_TTL_MS, Math.min(Math.round(parsed), maxMs));
}

export class UnlockSessionBroker {
  constructor({ now = () => Date.now(), defaultTtlMs = DEFAULT_TTL_MS, maxTtlMs = MAX_TTL_MS } = {}) {
    this.now = now;
    this.defaultTtlMs = defaultTtlMs;
    this.maxTtlMs = maxTtlMs;
    this.byKey = new Map();
  }

  key(binding, purpose) {
    const b = String(binding || '').trim();
    const p = String(purpose || '').trim();
    if (!b || !p) throw new Error('Wurster session requires binding and purpose');
    return `${b}\u0000${p}`;
  }

  grant({ binding, purpose, scopes = [], requestedTtl = null, secretHandle = null, metadata = null } = {}) {
    const key = this.key(binding, purpose);
    const now = this.now();
    const ttlMs = parseSessionDuration(requestedTtl, { defaultMs: this.defaultTtlMs, maxMs: this.maxTtlMs });
    const grant = {
      id: secureId(),
      binding: String(binding),
      purpose: String(purpose),
      scopes: [...new Set((Array.isArray(scopes) ? scopes : [scopes]).map(String).filter(Boolean))],
      createdAt: now,
      expiresAt: now + ttlMs,
      secretHandle,
      metadata: metadata == null ? null : structuredClone(metadata)
    };
    this.byKey.set(key, grant);
    return grant;
  }

  get(binding, purpose) {
    const key = this.key(binding, purpose);
    const grant = this.byKey.get(key);
    if (!grant) return null;
    if (grant.expiresAt <= this.now()) {
      this.byKey.delete(key);
      return null;
    }
    return grant;
  }

  require(binding, purpose, scope = null) {
    const grant = this.get(binding, purpose);
    if (!grant) {
      const error = new Error('Wurster authorization session is not active');
      error.code = 'WURST_AUTH_REQUIRED';
      throw error;
    }
    if (scope && !grant.scopes.includes(String(scope))) {
      const error = new Error(`Wurster authorization session does not allow ${scope}`);
      error.code = 'WURST_AUTH_SCOPE';
      throw error;
    }
    return grant;
  }

  status(binding, purpose) {
    const grant = this.get(binding, purpose);
    if (!grant) return { state: 'locked', purpose: String(purpose), session: null };
    return {
      state: 'unlocked',
      purpose: grant.purpose,
      session: {
        runtimeBound: true,
        scopes: [...grant.scopes],
        createdAt: grant.createdAt,
        expiresAt: grant.expiresAt
      }
    };
  }

  revoke(binding, purpose) {
    return this.byKey.delete(this.key(binding, purpose));
  }

  revokeBinding(binding) {
    const prefix = `${String(binding)}\u0000`;
    let count = 0;
    for (const key of [...this.byKey.keys()]) {
      if (!key.startsWith(prefix)) continue;
      this.byKey.delete(key);
      count += 1;
    }
    return count;
  }

  sweep() {
    const now = this.now();
    let count = 0;
    for (const [key, grant] of this.byKey) {
      if (grant.expiresAt > now) continue;
      this.byKey.delete(key);
      count += 1;
    }
    return count;
  }
}

export const WURSTER_SESSION_DEFAULT_MS = DEFAULT_TTL_MS;
export const WURSTER_SESSION_MAX_MS = MAX_TTL_MS;
