import 'reflect-metadata';
import { before, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Logger } from '@nestjs/common';
import { DISCHARGE_START, DischargeScheduler, untilNextHour } from './discharge.scheduler';

const gate = () => {
  let release: () => void = () => undefined;
  const wait = new Promise<void>((r) => (release = r));
  return { wait, release };
};

/** A clinic-clock (local) moment in September 2026. */
const at = (day: number, h: number, min = 0) => new Date(2026, 8, day, h, min, 0, 0);
const START = new Date(2026, 9, 1, 8, 0, 0, 0);

/**
 * The scheduler over stub services that record each call in order. `fail` names the steps that throw; `start` the
 * stored stamp (the counter stub counts how often it is read).
 */
function wired(opts: { fail?: string[]; start?: Date | null } = {}) {
  const calls: string[] = [];
  const args: Record<string, unknown[]> = {};
  const counterReads = { n: 0 };
  /** The stored stamp; a spec changes it as a reseed would (null: the read fails). */
  const stamp = { value: opts.start === undefined ? START : opts.start };
  const step =
    (name: string) =>
    async (...a: unknown[]) => {
      calls.push(name);
      args[name] = a;
      if (opts.fail?.includes(name)) throw new Error(`${name} broke`);
      return 0;
    };
  const plans = { catchUp: step('catchUp'), dropOrphans: step('dropOrphans'), remindDue: step('remindDue') };
  const orders = { openDueWindows: step('openDueWindows') };
  const lines = { refreshOpen: step('refreshOpen') };
  const repair = {
    resendMissing: step('resendMissing'),
    repairSummaries: step('repairSummaries'),
    repairOrdersAndPlans: step('repairOrdersAndPlans'),
    repairEndings: step('repairEndings'),
  };
  const overview = { snapshot: step('snapshot') };
  const counters = {
    findOneAndUpdate: (filter: { key: string }, update: { $setOnInsert: { last: number } }) => ({
      exec: async () => {
        counterReads.n += 1;
        assert.equal(filter.key, DISCHARGE_START);
        assert.ok(update.$setOnInsert, 'the stamp is only ever inserted, never overwritten');
        if (stamp.value === null) throw new Error('database down');
        return { last: stamp.value.getTime() };
      },
    }),
  };
  const s = new DischargeScheduler(plans as never, orders as never, lines as never, repair as never, overview as never, counters as never);
  s.clock = () => at(26, 11, 5);
  return { s, calls, args, counterReads, stamp };
}

const ORDER = [
  'catchUp',
  'dropOrphans',
  'openDueWindows',
  'remindDue',
  'refreshOpen',
  'resendMissing',
  'repairSummaries',
  'repairOrdersAndPlans',
  'repairEndings',
  'snapshot',
];

describe('DischargeScheduler', () => {
  // The deliberate failures log errors; keep the output clean.
  before(() => Logger.overrideLogger(false));

  test('the tick runs catch-up, windows, reminders, lines and the repairs in order, with one clinic time and the start stamp', async () => {
    const { s, calls, args } = wired();
    await s.tick();
    assert.deepEqual(calls, ORDER);
    // R17: the catch-up takes no start; the repairs are bounded by it.
    assert.deepEqual(args.catchUp, []);
    assert.deepEqual(args.openDueWindows, [at(26, 11, 5)]);
    assert.deepEqual(args.remindDue, [at(26, 11, 5)]);
    assert.deepEqual(args.resendMissing, [START]);
    assert.deepEqual(args.repairSummaries, [START]);
    assert.deepEqual(args.repairOrdersAndPlans, [START]);
    assert.deepEqual(args.repairEndings, [at(26, 11, 5), START]);
  });

  test('a step that throws does not stop the next one', async () => {
    const { s, calls } = wired({ fail: ORDER });
    await s.tick();
    assert.deepEqual(calls, ORDER, 'every step ran although each one threw');
    // And the pass after it still runs.
    s.clock = () => at(26, 12, 5);
    await s.tick();
    assert.deepEqual(calls, [...ORDER, ...ORDER]);
  });

  test('without the start stamp the repairs wait, and the rest of the pass still runs', async () => {
    const { s, calls } = wired({ start: null });
    await s.tick();
    assert.deepEqual(calls, ['catchUp', 'dropOrphans', 'openDueWindows', 'remindDue', 'refreshOpen', 'snapshot']);
  });

  test('a reset stamp is picked up by the next pass: the stamp is read at boot and on every pass (R32)', async () => {
    const { s, args, counterReads, stamp } = wired();
    s.onApplicationBootstrap();
    try {
      await s.tick();
      assert.deepEqual(args.resendMissing, [START]);
      // A reseed deletes the counter and sets it after its records, while this API keeps running.
      const LATER = new Date(START.getTime() + 3_600_000);
      stamp.value = LATER;
      await s.tick();
      for (const step of ['resendMissing', 'repairSummaries', 'repairOrdersAndPlans']) assert.deepEqual(args[step], [LATER], step);
      assert.deepEqual(args.repairEndings, [at(26, 11, 5), LATER]);
      assert.equal(counterReads.n, 3, 'once at boot, then once per pass');
      // A read that fails makes only that pass's repairs wait.
      stamp.value = null;
      args.resendMissing = [];
      await s.tick();
      assert.deepEqual(args.resendMissing, []);
      stamp.value = LATER;
      await s.tick();
      assert.deepEqual(args.resendMissing, [LATER]);
    } finally {
      s.onModuleDestroy();
    }
  });

  test('the snapshot runs once per clinic hour, from the tick or the hour timer', async () => {
    const { s, calls } = wired();
    const snaps = () => calls.filter((c) => c === 'snapshot').length;
    await s.tick();
    await s.tick();
    await s.hour();
    assert.equal(snaps(), 1, 'one in the 11:00 hour');
    s.clock = () => at(26, 11, 59);
    await s.tick();
    assert.equal(snaps(), 1);
    s.clock = () => at(26, 12, 0);
    await s.hour();
    await s.tick();
    assert.equal(snaps(), 2, 'one in the 12:00 hour');
  });

  test('a failed snapshot is tried again by the next pass in the same hour', async () => {
    const { s, calls } = wired({ fail: ['snapshot'] });
    await s.tick();
    await s.tick();
    assert.equal(calls.filter((c) => c === 'snapshot').length, 2);
  });

  test('the guard stops overlapping ticks, and overlapping snapshots', async () => {
    const g = gate();
    const { s, calls } = wired();
    const slow = async () => {
      calls.push('slow');
      await g.wait;
      return 0;
    };
    (s as any).plans.catchUp = slow;
    const first = s.tick();
    await s.tick();
    assert.deepEqual(calls, ['slow'], 'the second tick did nothing while the first ran');
    g.release();
    await first;
    await s.tick();
    assert.equal(calls.filter((c) => c === 'slow').length, 2);

    const h = gate();
    let snaps = 0;
    (s as any).overview.snapshot = async () => {
      snaps += 1;
      await h.wait;
    };
    s.clock = () => at(26, 14);
    const firstHour = s.hour();
    await s.hour();
    assert.equal(snaps, 1);
    h.release();
    await firstHour;
  });

  test('the timers are unref\'d and cleared on shutdown', () => {
    const { s } = wired();
    s.onApplicationBootstrap();
    try {
      const timers = ['tickTimer', 'alignTimer'].map((k) => (s as any)[k] as NodeJS.Timeout);
      for (const t of timers) {
        assert.ok(t, 'set');
        assert.equal(t.hasRef(), false, 'never keeps the process alive');
      }
    } finally {
      s.onModuleDestroy();
    }
    assert.equal(untilNextHour(3_600_000 * 5 + 1000), 3_600_000);
  });
});
