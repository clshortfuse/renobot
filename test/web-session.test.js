import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createOAuthState, createSession, csrfToken, oauthReturnTo, readCookie, readSession, safeAppPath, secureCookie, verifyCsrfToken, verifyOAuthState } from '../src/web-session.js';

const secret = '01234567890123456789012345678901';

describe('dashboard sessions', () => {
  it('accepts current OAuth state and rejects expiration or tampering', () => {
    const state = createOAuthState(secret, 1_000);
    assert.equal(verifyOAuthState(state, secret, 1_000), true);
    assert.equal(oauthReturnTo(state, secret), '/app');
    assert.equal(verifyOAuthState(state, secret, 601_001), false);
    assert.equal(verifyOAuthState(`${state}x`, secret, 1_000), false);
  });

  it('keeps OAuth return destinations within simple app paths', () => {
    const state = createOAuthState(secret, 1_000, '/app/modder/kofi');
    assert.equal(verifyOAuthState(state, secret, 1_000), true);
    assert.equal(oauthReturnTo(state, secret), '/app/modder/kofi');
    for (const path of ['//evil.test', '/app/../auth/logout', '/app/%2f%2fevil', '/app?next=//evil', '/auth/logout']) {
      assert.equal(safeAppPath(path), false, path);
      assert.equal(verifyOAuthState(createOAuthState(secret, 1_000, path), secret, 1_000), false);
    }
  });

  it('round trips bounded sessions and rejects invalid tokens', () => {
    const session = createSession({ id: 'owner', username: '<owner>' }, secret, 1_000);
    assert.deepEqual(readSession(session, secret, 1_000), { id: 'owner', username: '<owner>' });
    assert.equal(readSession(session, secret, 8 * 60 * 60_000 + 1_001), undefined);
    assert.equal(readSession(`${session}x`, secret, 1_000), undefined);
  });

  it('parses exact cookie names and emits hardened cookies', () => {
    assert.equal(readCookie('other=1; renobot_session=value; last=2', 'renobot_session'), 'value');
    assert.equal(readCookie('renobot_session_extra=value', 'renobot_session'), undefined);
    assert.equal(secureCookie('session', 'value', 60),
      'session=value; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax');
  });

  it('binds a CSRF token to the signed session', () => {
    const session = createSession({ id: 'owner', username: 'owner' }, secret);
    const other = createSession({ id: 'other', username: 'other' }, secret);
    const csrf = csrfToken(session, secret);
    assert.equal(verifyCsrfToken(csrf, session, secret), true);
    assert.equal(verifyCsrfToken(csrf, other, secret), false);
    assert.equal(verifyCsrfToken('', session, secret), false);
  });
});