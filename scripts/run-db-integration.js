import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Never inherit a production DATABASE_URL or accept a caller-supplied test path.
const directory = mkdtempSync(join(tmpdir(), 'renobot-sqlite-test-'));
try {
  const environment = { ...process.env, DATABASE_URL: `file:${join(directory, 'renobot_test.db').replaceAll('\\', '/')}` };
  for (const args of [
    ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
    ['--test', 'test/integration/database.integration.js'],
  ]) {
    const result = spawnSync(process.execPath, args, { env: environment, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}