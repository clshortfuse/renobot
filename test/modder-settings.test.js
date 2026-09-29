import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decryptSetting, encryptSetting, parseModderSettings, readModderSettingsConfig } from '../src/modder-settings.js';

const key = Buffer.alloc(32, 7);
const config = { key, minimumAmount: '5.00', currency: 'USD' };
const valid = { csrf: 'session-csrf', minimumAmount: '5.25', currency: 'USD',
  verificationToken: 'private', forwardUrlAction: 'keep', forwardUrl: '' };

describe('modder settings configuration', () => {
  it('requires a separate 32-byte key and owner-controlled eligibility floor', () => {
    assert.equal(readModderSettingsConfig({}), undefined);
    assert.throws(() => readModderSettingsConfig({ KOFI_ENCRYPTION_KEY: 'bad' }), /require/u);
    assert.throws(() => readModderSettingsConfig({ KOFI_ENCRYPTION_KEY: 'bad', SUPPORTER_MINIMUM_AMOUNT: '5.00', SUPPORTER_CURRENCY: 'USD' }), /32 bytes/u);
    assert.throws(() => readModderSettingsConfig({ KOFI_ENCRYPTION_KEY: key.toString('base64'), SUPPORTER_MINIMUM_AMOUNT: '0', SUPPORTER_CURRENCY: 'USD' }), /between/u);
    assert.deepEqual(readModderSettingsConfig({ KOFI_ENCRYPTION_KEY: key.toString('base64'), SUPPORTER_MINIMUM_AMOUNT: '5.00', SUPPORTER_CURRENCY: 'USD' }), config);
  });

  it('encrypts using a unique nonce and authenticated AES-GCM ciphertext', () => {
    const first = encryptSetting('secret', key, 'integration-1', 'verification-token');
    const second = encryptSetting('secret', key, 'integration-1', 'verification-token');
    assert.notEqual(first, second);
    assert.doesNotMatch(first, /secret/u);
    assert.match(first, /^v1:/u);
    assert.equal(decryptSetting(first, key, 'integration-1', 'verification-token'), 'secret');
    assert.throws(() => decryptSetting(first, key, 'integration-2', 'verification-token'));
    assert.throws(() => decryptSetting(first, key, 'integration-1', 'forward-url'));
    assert.throws(() => decryptSetting(first, Buffer.alloc(32, 8), 'integration-1', 'verification-token'));
    assert.throws(() => decryptSetting(first.replace(/.$/u, first.endsWith('A') ? 'B' : 'A'), key, 'integration-1', 'verification-token'));
    assert.throws(() => decryptSetting(`v2:${first.slice(3)}`, key, 'integration-1', 'verification-token'));
    assert.throws(() => decryptSetting('v1:invalid', key, 'integration-1', 'verification-token'));
    assert.throws(() => encryptSetting('secret', key, '', 'verification-token'));
  });

  it('accepts only bounded single-currency settings above the floor', () => {
    assert.deepEqual(parseModderSettings(new URLSearchParams(valid), config), {
      minimumAmount: '5.25', currency: 'USD', verificationToken: 'private', forwardUrlAction: 'keep', forwardUrl: '',
    });
    for (const changes of [{ minimumAmount: '4.99' }, { minimumAmount: '5.001' }, { currency: 'EUR' },
      { forwardUrlAction: 'replace', forwardUrl: 'http://example.com/hook' },
      { forwardUrlAction: 'replace', forwardUrl: 'https://127.0.0.1/hook' },
      { forwardUrlAction: 'replace', forwardUrl: 'https://user:pass@example.com/hook' },
      { forwardUrlAction: 'keep', forwardUrl: 'https://example.com' }, { forwardUrlAction: 'enable' }]) {
      assert.equal(parseModderSettings(new URLSearchParams({ ...valid, ...changes }), config), undefined);
    }
    assert.equal(parseModderSettings(new URLSearchParams({ ...valid, enabled: 'true' }), config), undefined);
    const repeated = new URLSearchParams(valid);
    repeated.append('currency', 'USD');
    assert.equal(parseModderSettings(repeated, config), undefined);
  });
});