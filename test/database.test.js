import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { connectPortalDatabase, createPortalDatabase } from '../src/database.js';

describe('portal persistence', () => {
  it('runs migrations only on its own disposable SQLite database, never the configured runtime file', () => {
    const runner = new URL('../scripts/run-db-integration.js', import.meta.url);
    const directory = mkdtempSync(join(tmpdir(), 'renobot-runner-guard-'));
    try {
      const runtimeFile = join(directory, 'production.db');
      const environment = { ...process.env, DATABASE_URL: `file:${runtimeFile.replaceAll('\\', '/')}` };
      const result = spawnSync(process.execPath, [fileURLToPath(runner)], { env: environment, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(runtimeFile), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not require a database when persistence is not configured', async () => {
    assert.equal(await connectPortalDatabase(undefined), undefined);
    assert.equal(await connectPortalDatabase(' '), undefined);
  });

  it('upserts only the Discord identity without granting modder access', async () => {
    /** @type {unknown[]} */
    const calls = [];
    const client = /** @type {import('@prisma/client').PrismaClient} */ (/** @type {unknown} */ ({
      account: { upsert: async (/** @type {unknown} */ args) => { calls.push(args); } },
      $queryRaw: async () => [{ '?column?': 1 }],
      $disconnect: async () => { calls.push('disconnect'); },
    }));
    const repository = createPortalDatabase(client);
    await repository.saveLogin({ id: '12345678901234567', username: '<visitor>' });
    assert.equal(await repository.isReady(), true);
    await repository.disconnect();
    assert.deepEqual(calls[0], {
      where: { discordUserId: '12345678901234567' },
      create: { discordUserId: '12345678901234567', lastKnownUsername: '<visitor>', lastLoginAt: /** @type {any} */ (calls[0]).create.lastLoginAt },
      update: { lastKnownUsername: '<visitor>', lastLoginAt: /** @type {any} */ (calls[0]).create.lastLoginAt },
    });
    assert.ok(/** @type {any} */ (calls[0]).create.lastLoginAt instanceof Date);
    assert.equal(calls[1], 'disconnect');
  });

  it('reports failed connectivity as not ready', async () => {
    const client = /** @type {import('@prisma/client').PrismaClient} */ (/** @type {unknown} */ ({
      $queryRaw: async () => { throw new Error('database unavailable'); },
    }));
    assert.equal(await createPortalDatabase(client).isReady(), false);
  });

  it('includes constraints and no supporter personal data in the initial migration', () => {
    const sql = readFileSync(new URL('../prisma/migrations/20260928000000_sqlite_portal/migration.sql', import.meta.url), 'utf8');
    assert.match(sql, /CREATE UNIQUE INDEX "account_discord_user_id_key"/u);
    assert.match(sql, /CREATE UNIQUE INDEX "kofi_integration_account_id_key" ON "kofi_integration"\("account_id"\)/u);
    assert.match(sql, /FOREIGN KEY \("account_id"\) REFERENCES "account" \("id"\) ON DELETE RESTRICT/u);
    assert.doesNotMatch(sql, /CREATE TABLE "modder_profile"/u);
    assert.doesNotMatch(sql, /"(?:email|raw_payload|verification_token)"\s+TEXT/u);
  });

  it('uses only lowercase snake_case identifiers in the authored SQLite schema', () => {
    const sql = readFileSync(new URL('../prisma/migrations/20260928000000_sqlite_portal/migration.sql', import.meta.url), 'utf8');
    const names = [...sql.matchAll(/"([A-Za-z_][A-Za-z_0-9]*)"/gu)].map((match) => match[1] ?? '');
    assert.ok(names.length > 0);
    for (const name of names) assert.match(name, /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u);
  });
});