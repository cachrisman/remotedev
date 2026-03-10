'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

// Set required env before requiring auth module
process.env.BRIDGE_AUTH_TOKEN = 'test-token';
process.env.REMOTEDEV_CLIENT_SECRET = 'test-client-secret';

const auth = require('../auth');

const TOKEN = 'test-token';
const SECRET = 'test-client-secret';

function makeValidPayload(overrides = {}) {
  const nonce = crypto.randomUUID();
  const ts = Date.now();
  const wsAuth = crypto.createHmac('sha256', TOKEN).update(`${nonce}:${ts}`).digest('hex');
  return { wsAuth, nonce, ts, clientSecret: SECRET, ...overrides };
}

describe('auth.validateAuthenticate', () => {
  it('accepts valid payload', () => {
    const payload = makeValidPayload();
    const result = auth.validateAuthenticate(payload, TOKEN, SECRET);
    assert.equal(result.ok, true);
  });

  it('rejects missing fields', () => {
    const result = auth.validateAuthenticate({}, TOKEN, SECRET);
    assert.equal(result.ok, false);
    assert.equal(result.code, 4003);
  });

  it('rejects expired timestamp (>30s)', () => {
    const nonce = crypto.randomUUID();
    const ts = Date.now() - 31000;
    const wsAuth = crypto.createHmac('sha256', TOKEN).update(`${nonce}:${ts}`).digest('hex');
    const result = auth.validateAuthenticate({ wsAuth, nonce, ts, clientSecret: SECRET }, TOKEN, SECRET);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'assertion_expired');
  });

  it('rejects tampered wsAuth', () => {
    const payload = makeValidPayload({ wsAuth: 'deadbeef' + 'a'.repeat(56) });
    const result = auth.validateAuthenticate(payload, TOKEN, SECRET);
    assert.equal(result.ok, false);
  });

  it('rejects wrong client secret', () => {
    const payload = makeValidPayload({ clientSecret: 'wrong-secret' });
    const result = auth.validateAuthenticate(payload, TOKEN, SECRET);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_client_secret');
  });

  it('rejects nonce replay', () => {
    const payload = makeValidPayload();
    const result1 = auth.validateAuthenticate(payload, TOKEN, SECRET);
    assert.equal(result1.ok, true);

    // Second use of same nonce must fail
    const payload2 = makeValidPayload();
    // Use same nonce but fresh HMAC
    const ts = Date.now();
    const wsAuth = crypto.createHmac('sha256', TOKEN).update(`${payload.nonce}:${ts}`).digest('hex');
    const result2 = auth.validateAuthenticate(
      { wsAuth, nonce: payload.nonce, ts, clientSecret: SECRET }, TOKEN, SECRET
    );
    assert.equal(result2.ok, false);
    assert.equal(result2.reason, 'replay_detected');
  });
});

describe('auth.checkIpLockout', () => {
  it('allows connection initially', () => {
    const result = auth.checkIpLockout('192.0.2.1');
    assert.equal(result.allowed, true);
  });

  it('locks out IP after 5 failures', () => {
    const ip = '192.0.2.100';
    for (let i = 0; i < 5; i++) {
      auth.recordAuthFailure(ip);
    }
    const result = auth.checkIpLockout(ip);
    assert.equal(result.allowed, false);
  });

  it('does not lock out on stale-assertion failures', () => {
    const ip = '192.0.2.200';
    // Record 5 stale-assertion failures — should NOT lock out
    for (let i = 0; i < 5; i++) {
      auth.recordAuthFailure(ip, { isStaleAssertion: true });
    }
    const result = auth.checkIpLockout(ip);
    assert.equal(result.allowed, true);
  });
});

describe('auth.trackUnauthConnect', () => {
  it('allows up to MAX_UNAUTH_PER_IP connections', () => {
    const ip = '192.0.2.50';
    let allowed = true;
    for (let i = 0; i < 10; i++) {
      allowed = auth.trackUnauthConnect(ip);
    }
    assert.equal(allowed, true); // 10th should still be allowed

    // 11th should be denied
    const eleventh = auth.trackUnauthConnect(ip);
    assert.equal(eleventh, false);
  });
});
