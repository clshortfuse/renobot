import assert from 'node:assert/strict';
import { it } from 'node:test';
import { ModelQueue } from '../src/reviews/model-queue.js';
import { SummaryAdmission } from '../src/reviews/summary-admission.js';

it('serializes FIFO jobs and rejects overflow', async () => {
  const queue = new ModelQueue({ maxPending: 2 });
  const gate = Promise.withResolvers();
  const order = /** @type {number[]} */ ([]);
  const first = queue.run(async () => { order.push(1); await gate.promise; });
  const second = queue.run(async () => { order.push(2); });
  const third = queue.run(async () => { order.push(3); });
  await assert.rejects(queue.run(async () => {}), /full/u);
  assert.deepEqual(order, [1]);
  gate.resolve(undefined);
  await Promise.all([first, second, third]);
  assert.deepEqual(order, [1, 2, 3]);
});

it('continues after a failed job', async () => {
  const queue = new ModelQueue();
  const failed = queue.run(async () => { throw new Error('failed'); });
  const next = queue.run(async () => 'next');
  await assert.rejects(failed, /failed/u);
  assert.equal(await next, 'next');
});

it('expires pending jobs without running them', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const queue = new ModelQueue({ maxWaitMs: 100 });
  const gate = Promise.withResolvers();
  const first = queue.run(() => gate.promise);
  let ran = false;
  const waiting = queue.run(async () => { ran = true; });
  const rejected = assert.rejects(waiting, /expired/u);
  t.mock.timers.tick(101);
  await rejected;
  gate.resolve(undefined);
  await first;
  assert.equal(ran, false);
});

it('limits users, cooldowns and admitted summaries', () => {
  const admission = new SummaryAdmission();
  assert.equal(admission.acquire('one', 0), undefined);
  assert.match(admission.acquire('one', 1) ?? '', /already/u);
  admission.release('one');
  assert.match(admission.acquire('one', 2) ?? '', /30 seconds/u);
  assert.equal(admission.acquire('one', 30000), undefined);
  for (let i = 0; i < 5; i++) assert.equal(admission.acquire(String(i), 30000), undefined);
  assert.match(admission.acquire('overflow', 30000) ?? '', /full/u);
});

it('clears the cooldown after a failed summary', () => {
  const admission = new SummaryAdmission();
  assert.equal(admission.acquire('user', 0), undefined);
  admission.release('user', false);
  assert.equal(admission.acquire('user', 1), undefined);
  admission.release('user', true);
  assert.match(admission.acquire('user', 2) ?? '', /30 seconds/u);
});

it('reports exact admission position and waiting count', async () => {
  const queue = new ModelQueue();
  const gate = Promise.withResolvers();
  const reports = /** @type {number[][]} */ ([]);
  const report = async (/** @type {number} */ position, /** @type {number} */ waiting) => {
    reports.push([position, waiting]);
  };
  const first = queue.run(() => gate.promise, report);
  const second = queue.run(async () => 'second', report);
  const third = queue.run(async () => 'third', report);
  await Promise.resolve();
  assert.deepEqual(reports, [[0, 0], [1, 1], [2, 2]]);
  gate.resolve(undefined);
  await Promise.all([first, second, third]);
});