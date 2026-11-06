import 'reflect-metadata';
import { before, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Logger } from '@nestjs/common';
import { ReceptionScheduler } from './reception.scheduler';

const gate = () => {
  let release: () => void = () => undefined;
  const wait = new Promise<void>((r) => (release = r));
  return { wait, release };
};

describe('ReceptionScheduler', () => {
  // The deliberate failures log errors; keep the output clean.
  before(() => Logger.overrideLogger(false));

  test('each minute pass finishes stuck paid visits, and is skipped while the previous one is still running', async () => {
    const g = gate();
    let calls = 0;
    const s = new ReceptionScheduler({ finishStuck: async () => { calls++; await g.wait; } } as never);
    const first = s.tick();
    await s.tick();
    assert.equal(calls, 1);
    g.release();
    await first;
    await s.tick();
    assert.equal(calls, 2);
  });

  test('a failing pass is caught and the next pass still runs', async () => {
    let calls = 0;
    const s = new ReceptionScheduler({ finishStuck: async () => { calls++; throw new Error('boom'); } } as never);
    await s.tick();
    await s.tick();
    assert.equal(calls, 2);
  });
});
