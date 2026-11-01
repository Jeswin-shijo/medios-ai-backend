import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { BadRequestException, ExecutionContext, ForbiddenException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '../users/schemas/user.schema';
import { SchedulingRosterService } from './scheduling-roster.service';
import { SchedulingDoctorsService } from './scheduling-doctors.service';
import { SchedulingController } from './scheduling.controller';
import { SchedulingScheduler } from './scheduling.scheduler';

const R = UserRole;
const READ = [R.ADMIN, R.DOCTOR, R.NURSE, R.STAFF];
const BOOK = [R.ADMIN, R.DOCTOR, R.STAFF];
const CLINICAL = [R.ADMIN, R.DOCTOR];
const TEAM = [R.ADMIN, R.DOCTOR, R.NURSE];
const ADMIN = [R.ADMIN];

/** "VERB path" -> the roles it must allow. Written out by hand; every route of the controller appears here once. */
const TABLE: Record<string, UserRole[]> = {
  'GET overview': READ,
  'GET snapshots': READ,
  'POST summary': READ,
  'GET catalogue': READ,
  'GET doctors': READ,
  'PUT doctors/:id/profile': CLINICAL,
  'GET doctors/:id/slots': READ,
  'GET appointments': READ,
  'POST appointments': BOOK,
  'PATCH appointments/:id/move': BOOK,
  'PATCH appointments/:id/cancel': BOOK,
  'POST appointments/:id/wants-earlier': BOOK,
  'GET procedures': READ,
  'GET procedures/board': READ,
  'POST procedures': CLINICAL,
  'POST procedures/activate-cath-lab': CLINICAL,
  'POST procedures/:id/start': TEAM,
  'POST procedures/:id/done': TEAM,
  'POST procedures/:id/cancel': CLINICAL,
  'GET consults': READ,
  'POST consults': CLINICAL,
  'POST consults/:id/accept': CLINICAL,
  'POST consults/:id/seen': CLINICAL,
  'POST consults/:id/repage': CLINICAL,
  'POST consults/:id/cancel': CLINICAL,
  'GET roster': READ,
  'PUT roster/entries': ADMIN,
  'DELETE roster/entries/:id': ADMIN,
  'POST roster/copy-week': ADMIN,
  'GET staff': READ,
  'PUT staff': ADMIN,
  'GET duty-now': READ,
  'GET rooms': READ,
  'POST rooms/:key/blocks': ADMIN,
  'DELETE rooms/blocks/:id': ADMIN,
  'GET waitlist': READ,
  'POST waitlist/:id/book': BOOK,
  'POST waitlist/:id/find': BOOK,
  'POST waitlist/:id/cancel': BOOK,
  'POST followups': CLINICAL,
  'GET settings': READ,
  'PUT settings': ADMIN,
};

const proto = SchedulingController.prototype as unknown as Record<string, unknown>;
const names = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor' && typeof proto[n] === 'function');
const handlers = names.filter((n) => Reflect.hasMetadata(PATH_METADATA, proto[n] as object));
const keyOf = (fn: object) => `${RequestMethod[Reflect.getMetadata(METHOD_METADATA, fn)]} ${Reflect.getMetadata(PATH_METADATA, fn)}`;
const guard = new RolesGuard(new Reflector());
const allowed = (name: string, role: UserRole) => {
  const ctx = {
    getHandler: () => proto[name],
    getClass: () => SchedulingController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as unknown as ExecutionContext;
  try {
    return guard.canActivate(ctx);
  } catch (e) {
    if (e instanceof ForbiddenException) return false;
    throw e;
  }
};

describe('SchedulingController roles', () => {
  test('the controller is mounted at scheduling and has exactly the routes of the table', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, SchedulingController), 'scheduling');
    assert.equal(Object.keys(TABLE).length, 42);
    assert.deepEqual(handlers.map((n) => keyOf(proto[n] as object)).sort(), Object.keys(TABLE).sort());
  });

  test('every route has the roles in the table; pharmacist and lab get 403 everywhere', () => {
    const everyone = Object.values(R) as UserRole[];
    for (const name of handlers) {
      const key = keyOf(proto[name] as object);
      assert.ok(Reflect.getMetadata(ROLES_KEY, proto[name] as object), `${key} has a @Roles decorator`);
      for (const role of everyone) assert.equal(allowed(name, role), TABLE[key].includes(role), `${key} as ${role}`);
      assert.equal(allowed(name, R.PHARMACIST), false, `${key} as pharmacist`);
      assert.equal(allowed(name, R.LAB), false, `${key} as lab`);
    }
  });
});

describe('doctor leave', () => {
  const made = (doctorUserId: string | undefined) => {
    const saved: unknown[] = [];
    const profiles = { findOne: () => ({ lean: () => ({ exec: async () => null }) }), updateOne: (_f: unknown, u: unknown) => ({ exec: async () => saved.push(u) }) };
    const appointments = { find: () => ({ exec: async () => [] }) };
    const opd = { getDoctor: async () => ({ id: 'd1', userId: doctorUserId, active: true }) };
    const service = new SchedulingDoctorsService(profiles as never, appointments as never, opd as never);
    return { service, saved };
  };
  const leave = [{ from: '2026-10-05', to: '2026-10-06' }];

  test('a doctor may set leave only on their own OP doctor', async () => {
    const own = made('u1');
    await own.service.setProfile({ id: 'u1', name: 'Dr A', role: R.DOCTOR }, 'd1', { leave });
    assert.equal(own.saved.length, 1);
    const other = made('u2');
    await assert.rejects(() => other.service.setProfile({ id: 'u1', name: 'Dr A', role: R.DOCTOR }, 'd1', { leave }), ForbiddenException);
    assert.equal(other.saved.length, 0);
    await other.service.setProfile({ id: 'a1', name: 'Admin', role: R.ADMIN }, 'd1', { leave });
    assert.equal(other.saved.length, 1);
  });

  test('a doctor may not change the slot length, even on their own profile (Z13)', async () => {
    const own = made('u1');
    await assert.rejects(() => own.service.setProfile({ id: 'u1', name: 'Dr A', role: R.DOCTOR }, 'd1', { slotMinutes: 20 }), ForbiddenException);
  });
});

describe('roster edits', () => {
  const admin = { _id: 'a1', name: 'Admin', role: R.ADMIN };
  const entry = { date: '2026-10-05', shift: 'morning' as const, staffId: '507f1f77bcf86cd799439011', titles: ['no-such-title'] };
  const build = (retry: () => Promise<number>, roster: Record<string, unknown>) => {
    const none = null as never;
    return new SchedulingController(none, none, none, { retryWaiting: retry } as never, none, roster as never, { addBlock: async () => ({ id: 'b' }) } as never, none, none, none, none);
  };

  test('PUT roster/entries is a 400 for a title key that is not a known duty title, and saves nothing', async () => {
    let saved = 0;
    const real = new SchedulingRosterService(null as never, null as never, null as never, { titles: async () => [{ key: 'duty-doctor' }] } as never);
    const roster = { assertKnownTitles: (t: string[]) => real.assertKnownTitles(t), setEntry: async () => ++saved };
    const c = build(async () => 0, roster);
    await assert.rejects(() => c.setEntry(admin, entry), BadRequestException);
    assert.equal(saved, 0);
    await c.setEntry(admin, { ...entry, titles: ['duty-doctor'] });
    assert.equal(saved, 1);
  });

  test('a roster edit and a room block retry waiting procedures, and a failing retry never fails the save', async () => {
    let calls = 0;
    const c = build(async () => { calls++; throw new Error('boom'); }, { assertKnownTitles: async () => undefined, setEntry: async () => ({ ok: 1 }), removeEntry: async () => ({ removed: true }), copyWeek: async () => ({ copied: 1, skipped: 0 }) });
    const id = '507f1f77bcf86cd799439011';
    assert.deepEqual(await c.setEntry(admin, { ...entry, titles: [] }), { ok: 1 });
    assert.deepEqual(await c.removeEntry(admin, { id }), { removed: true });
    assert.deepEqual(await c.copyWeek(admin, { from: '2026-10-05', to: '2026-10-12' }), { copied: 1, skipped: 0 });
    await c.addBlock(admin, { key: 'ot-1' }, { from: '2026-10-05T08:00', to: '2026-10-05T10:00' });
    assert.equal(calls, 4);
  });
});

describe('fix round 1', () => {
  const none = null as never;
  const admin = { _id: 'a1', name: 'Admin', role: R.ADMIN };

  test('an impossible moment is a 400 in slots and in a room block, not an Invalid Date passed on', async () => {
    let reached = 0;
    const c = new SchedulingController(none, { freeSlots: async () => { reached++; return []; } } as never, none, none, none, none, { addBlock: async () => { reached++; return {}; } } as never, none, none, none, none);
    await assert.rejects(() => c.slots({ id: 'x' }, { from: '2026-02-31T10:00' }), BadRequestException);
    await assert.rejects(() => c.addBlock(admin, { key: 'ot-1' }, { from: '2026-02-31T10:00', to: '2026-03-01T10:00' }), BadRequestException);
    await assert.rejects(() => c.addBlock(admin, { key: 'ot-1' }, { from: '2026-03-01T10:00', to: '2026-13-01T10:00' }), BadRequestException);
    assert.equal(reached, 0);
  });

  test('GET doctors passes ?activeOnly=true on, and lists everyone without it', async () => {
    const seen: boolean[] = [];
    const c = new SchedulingController(none, { listWithProfiles: async (a: boolean) => { seen.push(a); return []; } } as never, none, none, none, none, none, none, none, none, none);
    await c.listDoctors({});
    await c.listDoctors({ activeOnly: 'true' });
    await c.listDoctors({ activeOnly: 'false' });
    assert.deepEqual(seen, [false, true, false]);
  });

  test('the scheduler starts after bootstrap and stops on destroy', () => {
    const p = SchedulingScheduler.prototype as unknown as Record<string, unknown>;
    assert.equal(typeof p.onApplicationBootstrap, 'function');
    assert.equal(p.onModuleInit, undefined);
    assert.equal(typeof p.onModuleDestroy, 'function');
  });
});
