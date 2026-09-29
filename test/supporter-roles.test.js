import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { reconcileSupporterRole } from '../src/supporter-roles.js';

const roleId = '12345678901234567';
const supporter = '23456789012345678';

/** @param {{ active: boolean, present: boolean, hasRole: boolean, managed: boolean, managedRoleId?: string, editable?: boolean }} state */
function setup(state) {
  const calls = { add: 0, remove: 0, settled: 0 };
  const bot = /** @type {import('discord.js').Client} */ (/** @type {unknown} */ ({
    guilds: { fetch: async () => ({ roles: { fetch: async () => ({ editable: state.editable ?? true }) },
      members: { fetch: async () => state.present ? { roles: {
        cache: { has: () => state.hasRole },
        add: async () => { calls.add++; state.hasRole = true; },
        remove: async () => { calls.remove++; state.hasRole = false; },
      } } : undefined },
    }) },
  }));
  const database = /** @type {import('../src/database.js').PortalDatabase} */ (/** @type {unknown} */ ({
    dueSupporterSync: async () => ({ discordUserId: supporter, attemptCount: 0, nextAttemptAt: new Date(0) }),
    activeSupporterLeases: async () => state.active ? [{ expiresAt: new Date(Date.now() + 86400000) }] : [],
    hasManagedSupporterRole: async (/** @type {string} */ _userId, /** @type {string} */ id) => state.managed && (state.managedRoleId ?? roleId) === id,
    markManagedSupporterRole: async (/** @type {string} */ _userId, /** @type {string} */ id) => {
      state.managed = true; state.managedRoleId = id;
    },
    clearManagedSupporterRole: async () => { state.managed = false; },
    settleSupporterSync: async () => { calls.settled++; },
  }));
  return { bot, database, calls };
}

describe('shared sponsor role reconciliation', () => {
  it('grants an active supporter once and persists Renobot provenance', async () => {
    const state = { active: true, present: true, hasRole: false, managed: false };
    const { bot, database, calls } = setup(state);
    assert.equal(await reconcileSupporterRole(database, bot, 'guild', roleId), true);
    assert.deepEqual(calls, { add: 1, remove: 0, settled: 1 });
    assert.equal(state.managed, true);
  });
  it('never adopts or removes a pre-existing manually granted role', async () => {
    const state = { active: true, present: true, hasRole: true, managed: false };
    const { bot, database, calls } = setup(state);
    await reconcileSupporterRole(database, bot, 'guild', roleId);
    state.active = false;
    await reconcileSupporterRole(database, bot, 'guild', roleId);
    assert.deepEqual(calls, { add: 0, remove: 0, settled: 2 });
    assert.equal(state.hasRole, true);
  });
  it('does not remove a manually granted replacement role after configuration changes', async () => {
    const state = { active: false, present: true, hasRole: true, managed: true, managedRoleId: 'old-role' };
    const { bot, database, calls } = setup(state);
    await reconcileSupporterRole(database, bot, 'guild', roleId);
    assert.equal(calls.remove, 0);
    assert.equal(state.managed, true);
  });
  it('removes only a Renobot-granted role after all subscriptions expire', async () => {
    const state = { active: true, present: true, hasRole: true, managed: true };
    const { bot, database, calls } = setup(state);
    await reconcileSupporterRole(database, bot, 'guild', roleId);
    assert.equal(calls.remove, 0);
    state.active = false;
    await reconcileSupporterRole(database, bot, 'guild', roleId);
    assert.equal(calls.remove, 1);
    assert.equal(state.managed, false);
  });
  it('retries role hierarchy failures without claiming a grant', async () => {
    const state = { active: true, present: true, hasRole: false, managed: false, editable: false };
    const { bot, database, calls } = setup(state);
    await reconcileSupporterRole(database, bot, 'guild', roleId);
    assert.equal(calls.add, 0);
    assert.equal(state.managed, false);
    assert.equal(calls.settled, 1);
  });
});
