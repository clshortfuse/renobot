import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import pino from 'pino';

import { createShutdown } from '../src/lifecycle.js';

describe('process lifecycle', () => {
  it('logs and completes graceful shutdown once', async () => {
    const { logger, logs } = createCapturingLogger();
    /** @type {number[]} */
    const exitCodes = [];
    let destroyCount = 0;
    const shutDown = createShutdown({
      client: {
        async destroy() {
          destroyCount += 1;
        },
      },
      logger,
      setExitCode: (exitCode) => exitCodes.push(exitCode),
    });

    await Promise.all([
      shutDown('SIGINT'),
      shutDown('duplicate', 1),
    ]);

    assert.equal(destroyCount, 1);
    assert.deepEqual(exitCodes, [0]);
    assert.deepEqual(
      logs.map((log) => [log.msg, log.reason]),
      [
        ['Shutting down Renobot', 'SIGINT'],
        ['Renobot stopped', 'SIGINT'],
      ],
    );
  });

  it('logs shutdown failures and selects a failing exit code', async () => {
    const { logger, logs } = createCapturingLogger();
    /** @type {number[]} */
    const exitCodes = [];
    const shutDown = createShutdown({
      client: {
        async destroy() {
          throw new Error('close failed');
        },
      },
      logger,
      setExitCode: (exitCode) => exitCodes.push(exitCode),
    });

    await shutDown('SIGTERM');

    assert.deepEqual(exitCodes, [0, 1]);
    assert.deepEqual(
      logs.map((log) => log.msg),
      ['Shutting down Renobot', 'Renobot shutdown failed'],
    );
    const failureLog = logs[1];
    assert.ok(failureLog);
    assert.equal(failureLog.reason, 'SIGTERM');
    assert.equal(
      /** @type {Record<string, unknown>} */ (failureLog.err).message,
      'close failed',
    );
  });

  it('disconnects persistence exactly once even if bot shutdown fails', async () => {
    let disconnects = 0;
    const { logger } = createCapturingLogger();
    const database = /** @type {import('../src/database.js').PortalDatabase} */ (/** @type {unknown} */ ({
      disconnect: async () => { disconnects += 1; },
    }));
    const shutDown = createShutdown({
      client: { destroy: async () => { throw new Error('bot failed'); } },
      database,
      logger,
      setExitCode: () => {},
    });
    await Promise.all([shutDown('SIGTERM'), shutDown('SIGINT')]);
    assert.equal(disconnects, 1);
  });
});

/**
 * @returns {{
 *   logger: import('pino').Logger,
 *   logs: Record<string, unknown>[],
 * }}
 */
function createCapturingLogger() {
  /** @type {Record<string, unknown>[]} */
  const logs = [];
  const logger = pino(
    { base: null, timestamp: false },
    {
      write(line) {
        logs.push(JSON.parse(line));
      },
    },
  );

  return { logger, logs };
}