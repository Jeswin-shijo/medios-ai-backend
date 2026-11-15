import 'reflect-metadata';
import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Logger } from '@nestjs/common';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { SUPPORT_START, SupportScheduler } from './support.scheduler';

const ORDER = ['catchUp', 'remindDue', 'sendDue', 'markEscalated', 'reannounce', 'makeDue', 'syncCalls', 'dialDue', 'repairEffects'];

const gate = () => {
  let release: () => void = () => undefined;
  const wait = new Promise<void>((r) => (release = r));
  return { wait, release };
};

describe('SupportScheduler', () => {
  const m = models();
  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
  });

  /** The scheduler over stub services that record each call in order; `fail` names the steps that throw, `hold` one that waits. */
  function wired(opts: { fail?: string[]; hold?: { step: string; wait: Promise<void> } } = {}) {
    const calls: string[] = [];
    const args: Record<string, unknown[]> = {};
    const step =
      (name: string) =>
      async (...a: unknown[]) => {
        calls.push(name);
        args[name] = a;
        if (opts.hold?.step === name) await opts.hold.wait;
        if (opts.fail?.includes(name)) throw new Error(`${name} broke`);
        return 0;
      };
    const updates = { catchUp: step('catchUp'), remindDue: step('remindDue'), sendDue: step('sendDue') };
    const tickets = { markEscalated: step('markEscalated'), reannounce: step('reannounce') };
    const checkups = { makeDue: step('makeDue'), syncCalls: step('syncCalls'), dialDue: step('dialDue'), repairEffects: step('repairEffects') };
    const defaults = { n: 0 };
    const texts = { ensureDefaults: async () => void (defaults.n += 1) };
    const s = new SupportScheduler(updates as never, tickets as never, checkups as never, texts as never, m.CoordinatorCounter);
    return { s, calls, args, defaults };
  }

  test('the tick sends due updates, flags escalations and makes check-ups due, in order', async () => {
    const { s, calls } = wired();
    await s.tick();
    assert.deepEqual(calls, ORDER);
  });

  test("a failing step doesn't stop the next, and the failure is logged", async () => {
    const logged: string[] = [];
    const orig = Logger.prototype.error;
    Logger.prototype.error = function (msg: unknown) {
      logged.push(String(msg));
    };
    try {
      const { s, calls } = wired({ fail: ['catchUp', 'sendDue', 'dialDue'] });
      await s.tick();
      assert.deepEqual(calls, ORDER, 'every step still ran');
      assert.equal(logged.length, 3);
      assert.match(logged[0], /catch-up failed: catchUp broke/);
    } finally {
      Logger.prototype.error = orig;
    }
  });

  test('catch-up ignores messages before the start stamp: it is given the stored stamp, which is set once and never moves', async () => {
    const { s, args } = wired();
    const first = await s.startedAt();
    assert.ok(Math.abs(first.getTime() - Date.now()) < 5000, 'stamped at first read');
    assert.equal((await m.CoordinatorCounter.findOne({ key: SUPPORT_START }).lean())?.last, first.getTime());
    await new Promise((r) => setTimeout(r, 15));
    await s.tick();
    assert.equal((args.catchUp[0] as Date).getTime(), first.getTime(), 'the pass uses the stored stamp, not the time of the pass');
    assert.equal((await s.startedAt()).getTime(), first.getTime());
  });

  test('a reseed that resets the stamp is honoured by the next pass', async () => {
    const { s, args } = wired();
    await s.startedAt();
    const reseeded = Date.now() + 120_000;
    await m.CoordinatorCounter.updateOne({ key: SUPPORT_START }, { $set: { last: reseeded } });
    await s.tick();
    assert.equal((args.catchUp[0] as Date).getTime(), reseeded);
  });

  test('when the stamp cannot be read, the catch-up waits and the other steps still run', async () => {
    const orig = Logger.prototype.error;
    Logger.prototype.error = () => undefined;
    try {
      const { s, calls } = wired();
      s.startedAt = async () => {
        throw new Error('database down');
      };
      await s.tick();
      assert.deepEqual(calls, ORDER.slice(1));
    } finally {
      Logger.prototype.error = orig;
    }
  });

  test('the tick skips while the previous tick is still running', async () => {
    const g = gate();
    const { s, calls } = wired({ hold: { step: 'sendDue', wait: g.wait } });
    const first = s.tick();
    await new Promise((r) => setTimeout(r, 50));
    await s.tick();
    assert.equal(calls.filter((c) => c === 'catchUp').length, 1, 'the second tick did nothing');
    g.release();
    await first;
    assert.deepEqual(calls, ORDER);
    await s.tick();
    assert.equal(calls.filter((c) => c === 'catchUp').length, 2, 'ticks run again once the first is done');
  });

  test('start-up stores the default texts and the start stamp, and the timer stops on destroy', async () => {
    const { s, defaults } = wired();
    s.onApplicationBootstrap();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(defaults.n, 1);
    assert.ok(await m.CoordinatorCounter.findOne({ key: SUPPORT_START }).lean());
    s.onModuleDestroy();
  });
});
