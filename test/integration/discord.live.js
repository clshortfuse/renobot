import assert from 'node:assert/strict';
import test from 'node:test';

// No gateway connection and no write-capable HTTP methods. Never log response bodies.
test('live Discord guild member listing supports complete role review', {
  skip: process.env.RENOBOT_LIVE_DISCORD !== '1', timeout: 180_000,
}, async (context) => {
  const token = process.env.DISCORD_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;
  assert.ok(token, 'DISCORD_TOKEN is required');
  assert.ok(guildId, 'DISCORD_GUILD_ID is required');
  let after = '0';
  let pages = 0;
  let members = 0;
  while (true) {
    const url = new URL(`https://discord.com/api/v10/guilds/${guildId}/members`);
    url.searchParams.set('limit', '1000');
    url.searchParams.set('after', after);
    /** @type {Response} */
    const response = await fetch(url, {
      method: 'GET', headers: { Authorization: `Bot ${token}` }, signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json();
    assert.ok(response.ok, `Discord member listing failed: HTTP ${response.status}, code ${body.code ?? 'unknown'}`);
    assert.ok(Array.isArray(body), 'Discord member listing must return an array');
    pages += 1;
    members += body.length;
    for (const member of body) {
      assert.equal(typeof member.user?.username, 'string', 'Member username must be available');
      assert.ok(Array.isArray(member.roles), 'Member roles must be available');
    }
    if (body.length < 1000) break;
    const next = body.reduce((highest, member) => BigInt(member.user.id) > BigInt(highest) ? member.user.id : highest, after);
    assert.ok(BigInt(next) > BigInt(after), 'Pagination must advance');
    after = next;
  }
  assert.ok(members > 0, 'Configured guild must contain members');
  context.diagnostic(`Read-only Discord listing verified: ${members} members across ${pages} pages`);
});