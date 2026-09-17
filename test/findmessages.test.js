import assert from 'node:assert/strict';
import { it } from 'node:test';
import command, { findUserMessages } from '../src/commands/definitions/findmessages.js';

it('keeps lookup behind default owner authorization', () => {
  assert.equal(command.access, undefined);
});

it('paginates and matches author IDs without message content or membership', async () => {
  let calls = 0;
  const result = await findUserMessages(async (before, limit) => {
    calls++;
    assert.equal(limit, 100);
    if (calls === 1) {
      assert.equal(before, undefined);
      return Array.from({ length: 100 }, (_, i) => ({ id: String(200 - i), author: { id: i === 0 ? 'target' : 'other' } }));
    }
    assert.equal(before, '101');
    return [{ id: '100', author: { id: 'target' } }];
  }, 'target', 1000);
  assert.deepEqual(result.ids, ['200', '100']);
  assert.equal(result.scanned, 101);
  assert.equal(result.exhausted, true);
});

it('honors scan limits and does not claim exhaustive results', async () => {
  const result = await findUserMessages(async (_before, limit) => {
    assert.equal(limit, 2);
    return [{ id: '3', author: { id: 'other' } }, { id: '2', author: { id: 'target' } }];
  }, 'target', 2);
  assert.equal(result.scanned, 2);
  assert.equal(result.exhausted, false);
  assert.deepEqual(result.ids, ['2']);
});

it('handles empty history and propagates access failures', async () => {
  assert.equal((await findUserMessages(async () => [], 'target', 100)).scanned, 0);
  await assert.rejects(findUserMessages(async () => { throw new Error('Missing Access'); }, 'target', 100), /Missing Access/u);
});