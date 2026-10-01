import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readMailConfig } from '../src/verification-mail.js';

it('leaves email sending disabled without SMTP credentials and requires secure submission', () => {
  assert.equal(readMailConfig({}), undefined);
  assert.throws(() => readMailConfig({ SMTP_HOST: 'mail.example.com' }), /requires/u);
  const environment = { SMTP_HOST: 'mail.example.com', SMTP_USER: 'noreply@example.com',
    SMTP_PASSWORD: ' password ', SMTP_FROM: 'NoReply@Example.com' };
  assert.equal(readMailConfig(environment)?.port, 587);
  assert.equal(readMailConfig(environment)?.password, ' password ');
  assert.equal(readMailConfig(environment)?.from, 'noreply@example.com');
  assert.throws(() => readMailConfig({ ...environment, SMTP_PORT: '25' }), /465 or 587/u);
  assert.throws(() => readMailConfig({ ...environment, SMTP_FROM: 'bad\r\naddress' }), /email address/u);
});