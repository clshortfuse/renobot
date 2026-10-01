import assert from 'node:assert/strict';
import { it } from 'node:test';
import { normalizeEmail } from '../src/account-email.js';

it('rejects address-header syntax instead of verifying a different SMTP recipient', () => {
  for (const value of ['label<person@example.com>', 'alice,bob@example.com',
    'person(comment)@example.com', '"person"@example.com', '.person@example.com',
    'person..name@example.com', 'person@example.com>', 'person@-example.com']) {
    assert.equal(normalizeEmail(value), null, value);
  }
  assert.equal(normalizeEmail("person+tag.o'neil@example.com"), "person+tag.o'neil@example.com");
});

it('normalizes matching addresses without conflating aliases', () => {
  assert.equal(normalizeEmail(' Person+KoFi@Example.COM '), 'person+kofi@example.com');
  assert.notEqual(normalizeEmail('person+one@example.com'), normalizeEmail('person@example.com'));
  assert.notEqual(normalizeEmail('first.last@example.com'), normalizeEmail('firstlast@example.com'));
  for (const value of ['', 'invalid', 'a@@example.com', 'a b@example.com', `${'a'.repeat(250)}@example.com`]) {
    assert.equal(normalizeEmail(value), null);
  }
});