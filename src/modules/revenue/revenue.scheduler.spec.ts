import 'reflect-metadata';
import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { RevenueScheduler } from './revenue.scheduler';

const gate = () => {
  let release: () => void = () => undefined;
  const wait = new Promise<void>((r) => (release = r));
  return { wait, release };
};

describe('RevenueScheduler', () => {
  test('a minute pass is skipped while the previous one is still running', async () => {
    const g = gate();
    let calls = 0;
    const s = new RevenueScheduler({ reconcile: async () => { calls++; await g.wait; } } as never, { snapshot: async () => undefined } as never);
    const first = s.tick();
    await s.tick();
    assert.equal(calls, 1);
    g.release();
    await first;
    await s.tick();
    assert.equal(calls, 2);
  });

  test('an hourly pass is skipped while the previous one is still running', async () => {
    const g = gate();
    let calls = 0;
    const s = new RevenueScheduler({ reconcile: async () => undefined } as never, { snapshot: async () => { calls++; await g.wait; } } as never);
    const first = s.hour();
    await s.hour();
    assert.equal(calls, 1);
    g.release();
    await first;
    await s.hour();
    assert.equal(calls, 2);
  });

  test('a failing reconcile or snapshot is caught and the next pass still runs', async () => {
    let r = 0;
    let h = 0;
    const s = new RevenueScheduler(
      { reconcile: async () => { r++; throw new Error('boom'); } } as never,
      { snapshot: async () => { h++; throw new Error('boom'); } } as never,
    );
    await s.tick();
    await s.tick();
    await s.hour();
    await s.hour();
    assert.equal(r, 2);
    assert.equal(h, 2);
  });
});
