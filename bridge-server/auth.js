'use strict';

const crypto = require('crypto');
const logger = require('./logger');

// Per-IP brute-force state
// { failures: number, lockedUntil: number }
const ipState = new Map();

const MAX_FAILURES = 5;
const LOCKOUT_MS = 60 * 1000; // 60s
const ASSERTION_TTL_MS = 30 * 1000; // 30s
const AUTH_TIMEOUT_MS = 5 * 1000; // 5s

// Nonce replay cache: nonce → expiry timestamp
// Using a Map for LRU-like behavior with TTL cleanup
const seenNonces = new Map();

function cleanExpiredNonces() {
  const now = Date.now();
  for (const [nonce, expiry] of seenNonces) {
    if (now > expiry) seenNonces.delete(nonce);
  }
}

// Clean up old nonces periodically
setInterval(cleanExpiredNonces, ASSERTION_TTL_MS).unref();

/**
 * Compute HMAC-SHA256 of the given data using the bridge auth token.
 */
function computeHmac(token, data) {
  return crypto.createHmac('sha256', token).update(data).digest('hex');
}

/**
 * Validate an incoming authenticate message.
 * Returns { ok: true } or { ok: false, code: 4003 | 4008, reason: string }
 */
function validateAuthenticate(payload, bridgeAuthToken, clientSecret) {
  const { wsAuth, nonce, ts, clientSecret: incomingSecret } = payload;

  if (!wsAuth || !nonce || !ts || !incomingSecret) {
    return { ok: false, code: 4003, reason: 'missing_fields' };
  }
  if (typeof wsAuth !== 'string' || typeof nonce !== 'string' || typeof incomingSecret !== 'string') {
    return { ok: false, code: 4003, reason: 'missing_fields' };
  }

  // Check timestamp within 30s
  const age = Date.now() - Number(ts);
  if (age > ASSERTION_TTL_MS || age < -5000) {
    return { ok: false, code: 4003, reason: 'assertion_expired' };
  }

  // Check nonce replay
  cleanExpiredNonces();
  if (seenNonces.has(nonce)) {
    return { ok: false, code: 4003, reason: 'replay_detected' };
  }

  // Verify HMAC
  const expected = computeHmac(bridgeAuthToken, `${nonce}:${ts}`);
  const wsAuthBuf = Buffer.from(wsAuth, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (wsAuthBuf.length !== expectedBuf.length) {
    return { ok: false, code: 4003, reason: 'hmac_mismatch' };
  }
  if (!crypto.timingSafeEqual(wsAuthBuf, expectedBuf)) {
    return { ok: false, code: 4003, reason: 'hmac_mismatch' };
  }

  // Verify client secret (constant-time)
  if (!clientSecret || incomingSecret.length !== clientSecret.length) {
    return { ok: false, code: 4003, reason: 'invalid_client_secret' };
  }
  if (!crypto.timingSafeEqual(Buffer.from(incomingSecret), Buffer.from(clientSecret))) {
    return { ok: false, code: 4003, reason: 'invalid_client_secret' };
  }

  // Record nonce
  seenNonces.set(nonce, Date.now() + ASSERTION_TTL_MS);

  return { ok: true };
}

/**
 * Check and update IP brute-force state.
 * Returns { allowed: true } or { allowed: false, remaining: ms }
 */
function checkIpLockout(ip) {
  const state = ipState.get(ip);
  if (!state) return { allowed: true };

  const now = Date.now();
  if (state.lockedUntil && now < state.lockedUntil) {
    return { allowed: false, remaining: state.lockedUntil - now };
  }

  // Lockout expired — reset
  if (state.lockedUntil && now >= state.lockedUntil) {
    ipState.delete(ip);
  }

  return { allowed: true };
}

/**
 * Record an auth failure for an IP.
 * If this is not a 4003-from-stale-assertion, increment failure counter.
 * Returns whether the IP is now locked out.
 */
function recordAuthFailure(ip, { isStaleAssertion = false } = {}) {
  if (isStaleAssertion) return false; // 4003 from reload doesn't count

  let state = ipState.get(ip) || { failures: 0, lockedUntil: null };
  state.failures += 1;

  if (state.failures >= MAX_FAILURES) {
    state.lockedUntil = Date.now() + LOCKOUT_MS;
    logger.warn({ ip, failures: state.failures }, 'IP locked out');
  }

  ipState.set(ip, state);
  return state.lockedUntil !== null;
}

/**
 * Clear IP lockout state (e.g., after successful auth).
 */
function clearIpState(ip) {
  ipState.delete(ip);
}

// Per-IP unauthenticated connection counts
const unauthCounts = new Map();
const MAX_UNAUTH_PER_IP = 10;

function trackUnauthConnect(ip) {
  const count = (unauthCounts.get(ip) || 0) + 1;
  unauthCounts.set(ip, count);
  return count <= MAX_UNAUTH_PER_IP;
}

function trackUnauthDisconnect(ip) {
  const count = unauthCounts.get(ip) || 0;
  if (count <= 1) unauthCounts.delete(ip);
  else unauthCounts.set(ip, count - 1);
}

module.exports = {
  computeHmac,
  validateAuthenticate,
  checkIpLockout,
  recordAuthFailure,
  clearIpState,
  trackUnauthConnect,
  trackUnauthDisconnect,
  AUTH_TIMEOUT_MS,
  ASSERTION_TTL_MS,
};
