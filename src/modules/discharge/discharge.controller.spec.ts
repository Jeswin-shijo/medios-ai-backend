import 'reflect-metadata';
import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BadRequestException, ExecutionContext, ForbiddenException, RequestMethod, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '../users/schemas/user.schema';
import { DischargeSettingsService } from './discharge-settings.service';
import { DischargeController } from './discharge.controller';

const { ADMIN: A, DOCTOR: D, NURSE: N, STAFF: S, PHARMACIST, LAB } = UserRole;
const READ = [A, D, N, S];
const ORDER = [A, D];
const WARD = [A, N];
const LEAVE = [A, N, S];
const ADMIN = [A];
/** A tick on a doctor's line needs ORDER, on a nurse's line WARD: the route allows both, and the service decides. */
const TICK = [A, D, N];

/** Every `/api/discharge` route and who may call it (global constraints, "Roles"). */
const TABLE: Record<string, UserRole[]> = {
  'GET overview': READ,
  'GET queue': READ,
  'GET plans/:planId': READ,
  'GET admissions/:admissionId': READ,
  'GET patients/:patientId/line': READ,
  'GET summaries/to-sign': READ,
  'GET left-today': READ,
  'POST day-summary': READ,
  'PATCH plans/:planId/target': ORDER,
  'POST plans/:planId/order': ORDER,
  'POST orders/check': ORDER,
  'PATCH orders/:id': ORDER,
  'POST orders/:id/cancel': ORDER,
  'POST orders/:id/start-now': ORDER,
  'POST orders/:id/lines/:key': TICK,
  'POST orders/:id/lab/:requestId/follow-up-later': ORDER,
  'POST orders/:id/bill-override': ADMIN,
  'GET orders/:id/summary': READ,
  'PUT orders/:id/summary': ORDER,
  'POST orders/:id/summary/sign': ORDER,
  'POST orders/:id/summary/unlock': ORDER,
  'POST orders/:id/summary/redraft-course': ORDER,
  'POST orders/:id/gate-pass': LEAVE,
  'POST orders/:id/left': LEAVE,
  'POST orders/:id/body-released': LEAVE,
  'POST plans/:planId/left-without-discharge': WARD,
  'GET settings': READ,
  'PUT settings': ADMIN,
};

const proto = DischargeController.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;

/** The controller's routes, read from Nest's own metadata. */
function routes() {
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor' && Reflect.getMetadata(PATH_METADATA, proto[name]) !== undefined)
    .map((name) => {
      const handler = proto[name];
      const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number];
      return { name, handler, key: `${method} ${Reflect.getMetadata(PATH_METADATA, handler)}`, roles: Reflect.getMetadata(ROLES_KEY, handler) as UserRole[] | undefined };
    });
}

const guard = new RolesGuard(new Reflector());
/** What the app's RolesGuard says for a user of this role on this handler. */
function allowed(handler: unknown, role: UserRole): boolean {
  const ctx = {
    getHandler: () => handler,
    getClass: () => DischargeController,
    switchToHttp: () => ({ getRequest: () => ({ user: { _id: 'u1', name: 'Someone', role } }) }),
  } as unknown as ExecutionContext;
  try {
    return guard.canActivate(ctx);
  } catch (e) {
    if (e instanceof ForbiddenException) return false;
    throw e;
  }
}

/** main.ts's global pipe. */
const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false });
/** The type Nest validates a handler's @Body() against. */
function bodyType(name: string): unknown {
  const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, DischargeController, name) ?? {}) as Record<string, { index: number }>;
  const entry = Object.entries(args).find(([k]) => k.startsWith(`${RouteParamtypes.BODY}:`));
  assert.ok(entry, `${name} has a @Body()`);
  return (Reflect.getMetadata('design:paramtypes', DischargeController.prototype, name) as unknown[])[entry![1].index];
}
const throughPipe = (name: string, body: unknown) => pipe.transform(body, { type: 'body', metatype: bodyType(name) as never, data: '' });
/** The type Nest validates a handler's @Query() against, and the query run through the pipe. */
function queryType(name: string): unknown {
  const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, DischargeController, name) ?? {}) as Record<string, { index: number }>;
  const entry = Object.entries(args).find(([k]) => k.startsWith(`${RouteParamtypes.QUERY}:`));
  assert.ok(entry, `${name} has a @Query()`);
  return (Reflect.getMetadata('design:paramtypes', DischargeController.prototype, name) as unknown[])[entry![1].index];
}
const throughQuery = (name: string, query: unknown) => pipe.transform(query, { type: 'query', metatype: queryType(name) as never, data: '' });

const PLAN = '507f1f77bcf86cd799439011';
const ORDER_ID = '507f1f77bcf86cd799439012';
const REQUEST = '507f1f77bcf86cd799439013';
const T = '2026-09-26T05:30:00.000Z';
const line = { medicine: 'pantoprazole', product: 'pantoprazole-tab-40', dose: 40, route: 'oral', frequency: 'OD', durationDays: 7 };
const home = { kind: 'home', plannedLeaveAt: '2026-09-26T13:00', diagnosis: 'Pneumonia', condition: 'improved', takeHome: { lines: [line] }, followUp: { inDays: 7 } };
const USER = { _id: 'u1', name: 'Dr. Shajin', role: D };
const ACTOR = { id: 'u1', name: 'Dr. Shajin', role: D };

/** The controller over stub services that record each call. */
function wired() {
  const calls: [string, unknown[]][] = [];
  const rec =
    (name: string, result: (...a: any[]) => unknown = () => ({ from: name })) =>
    (...args: unknown[]) => {
      calls.push([name, args]);
      return Promise.resolve(result(...args));
    };
  const order = { _id: ORDER_ID, plan: PLAN };
  const summaryDoc = {
    toObject: () => ({
      _id: 's1', order: ORDER_ID, kind: 'home', sections: { diagnosis: 'Pneumonia' }, course: { text: 'Treated.', source: 'rules' },
      edited: [], versions: [], draftedAt: new Date(T), updatedAt: new Date(T),
    }),
  };
  const overview = {
    overview: rec('overview'), queue: rec('queue'), detail: rec('detail', (id: string) => ({ detailOf: id })), byAdmission: rec('byAdmission'),
    patientLine: rec('patientLine', () => null), leftToday: rec('leftToday'), daySummary: rec('daySummary'),
  };
  const plans = { setTarget: rec('setTarget', () => ({ _id: PLAN })) };
  const orders = {
    order: rec('order', () => order), edit: rec('edit', () => order), cancel: rec('cancel', () => order), startNow: rec('startNow', () => order), preview: rec('preview'),
  };
  const lines = { tick: rec('tick', () => order), followUpLater: rec('followUpLater', () => order), overrideBill: rec('overrideBill', () => order) };
  const summary = {
    draft: rec('draft', () => summaryDoc), save: rec('save', () => summaryDoc), sign: rec('sign', () => summaryDoc), unlock: rec('unlock', () => summaryDoc),
    redraftCourse: rec('redraftCourse', () => summaryDoc), toSign: rec('toSign'),
  };
  const leaving = {
    gatePass: rec('gatePass'), left: rec('left', () => ({ ...order, state: 'left' })), bodyReleased: rec('bodyReleased', () => ({ ...order, state: 'left' })),
    leftWithoutDischarge: rec('leftWithoutDischarge', () => ({ _id: PLAN })),
  };
  const settings = { get: rec('getSettings'), save: rec('saveSettings') };
  const controller = new DischargeController(
    overview as never, plans as never, orders as never, lines as never, summary as never, leaving as never, settings as never,
  );
  return { controller, calls };
}

describe('DischargeController', () => {
  test('every route is under /discharge with the roles of the table', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, DischargeController), 'discharge');
    assert.equal(Reflect.getMetadata(ROLES_KEY, DischargeController), undefined, 'no class-wide roles to override a route');
    const found = Object.fromEntries(routes().map((r) => [r.key, r.roles]));
    assert.deepEqual(Object.keys(found).sort(), Object.keys(TABLE).sort());
    for (const [key, roles] of Object.entries(TABLE)) assert.deepEqual([...(found[key] ?? [])].sort(), [...roles].sort(), key);
  });

  test('pharmacist and lab get 403 on every route', () => {
    const all = routes();
    assert.equal(all.length, 28);
    for (const r of all) {
      assert.ok(r.roles?.length, `${r.key} names its roles (a route without @Roles lets everyone in)`);
      assert.equal(allowed(r.handler, PHARMACIST), false, `${r.key}: pharmacist`);
      assert.equal(allowed(r.handler, LAB), false, `${r.key}: lab`);
      // Every route is open to an admin.
      assert.equal(allowed(r.handler, A), true, `${r.key}: admin`);
    }
  });

  test('staff can print a gate pass but not order', () => {
    assert.equal(allowed(proto.gatePass, S), true);
    assert.equal(allowed(proto.left, S), true);
    assert.equal(allowed(proto.order, S), false);
    assert.equal(allowed(proto.tick, S), false, 'the front desk ticks no line');
    assert.equal(allowed(proto.leftWithoutDischarge, S), false);
    assert.equal(allowed(proto.overrideBill, S), false);
    assert.equal(allowed(proto.getOverview, S), true);
    // A nurse ticks lines and prints, never orders; a doctor orders, never prints.
    assert.equal(allowed(proto.tick, N), true);
    assert.equal(allowed(proto.order, N), false);
    assert.equal(allowed(proto.gatePass, D), false);
    assert.equal(allowed(proto.saveSettings, D), false);
  });

  test('the settings route passes unknown keys through to save (400 for an unknown key)', async () => {
    const stored: Record<string, unknown>[] = [];
    const settings = new DischargeSettingsService({
      getSettings: async () => ({ discharge: {} }),
      setDischarge: async (v: Record<string, unknown>) => void stored.push(v),
    } as never);
    const c = new DischargeController({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, settings);
    const admin = { _id: 'a1', name: 'Admin', role: A };
    const body = await throughPipe('saveSettings', { leaveMinutes: 90, sneaky: true });
    assert.deepEqual(body, { leaveMinutes: 90, sneaky: true }, 'the pipe strips nothing');
    await assert.rejects(c.saveSettings(admin, body as never), (e: unknown) => {
      assert.ok(e instanceof BadRequestException, String(e));
      assert.equal((e as BadRequestException).message, '"sneaky" is not a discharge setting');
      return true;
    });
    assert.deepEqual(stored, []);
    await c.saveSettings(admin, (await throughPipe('saveSettings', { leaveMinutes: 90 })) as never);
    assert.deepEqual(stored, [{ leaveMinutes: 90 }]);
  });

  test('the order body validates its take-home lines and follow-up nested: trimmed and whitelisted, and "none" stays "none"', async () => {
    const body = (await throughPipe('order', {
      ...home,
      takeHome: { lines: [{ ...line, note: '  after food  ', sneaky: 'x' }], extra: 1 },
      followUp: { inDays: 7, note: '  call first  ', other: 'y' },
    })) as Record<string, any>;
    assert.deepEqual(JSON.parse(JSON.stringify(body.takeHome)), { lines: [{ ...line, note: 'after food' }] });
    assert.deepEqual(JSON.parse(JSON.stringify(body.followUp)), { inDays: 7, note: 'call first' });
    const none = (await throughPipe('order', { ...home, takeHome: 'none', followUp: 'none' })) as Record<string, any>;
    assert.deepEqual([none.takeHome, none.followUp], ['none', 'none']);
    for (const bad of [
      { ...home, takeHome: 'nothing' },
      { ...home, takeHome: { lines: [{ ...line, dose: -1 }] } },
      { ...home, takeHome: { lines: [] } },
      { ...home, takeHome: [line] },
      { ...home, followUp: { inDays: 0 } },
      { ...home, followUp: 'later' },
    ]) {
      await assert.rejects(throughPipe('order', bad), BadRequestException, JSON.stringify(bad));
    }
  });

  test('R50: sign and save need `seen` on the HTTP body (400 without it); the service argument stays optional', async () => {
    for (const body of [{}, { seen: '' }, { seen: 'yesterday' }]) {
      await assert.rejects(throughPipe('signSummary', body), BadRequestException, `sign ${JSON.stringify(body)}`);
      await assert.rejects(throughPipe('saveSummary', { ...body, sections: { diagnosis: 'CAP' } }), BadRequestException, `save ${JSON.stringify(body)}`);
    }
    assert.deepEqual(JSON.parse(JSON.stringify(await throughPipe('signSummary', { seen: T }))), { seen: T });
    const saved = JSON.parse(JSON.stringify(await throughPipe('saveSummary', { sections: { diagnosis: 'CAP' }, seen: T })));
    assert.deepEqual(saved, { sections: { diagnosis: 'CAP' }, seen: T });
  });

  test('M4: the queue search is trimmed like the ward and doctor filters', async () => {
    const q = (await throughQuery('queue', { ward: '  General ward A ', doctor: ' Dr. Shajin ', q: '  ravi  ' })) as Record<string, unknown>;
    assert.deepEqual([q.ward, q.doctor, q.q], ['General ward A', 'Dr. Shajin', 'ravi']);
  });

  test('each route calls its service with the actor first; a change answers with the plan\'s detail', async () => {
    const { controller: c, calls } = wired();
    const take = () => calls.splice(0);

    // Reads.
    await c.queue({ ward: 'General ward A', status: 'due', q: 'ravi' } as never);
    assert.deepEqual(take(), [['queue', [{ ward: 'General ward A', doctor: undefined, status: 'due', q: 'ravi' }]]]);
    assert.deepEqual(await c.detail({ planId: PLAN }), { detailOf: PLAN });
    assert.equal(await c.patientLine({ patientId: PLAN }), null);
    take();

    // The plan and the order: the actor goes first, and the answer is the plan's checklist panel.
    assert.deepEqual(await c.setTarget(USER, { planId: PLAN }, { targetDay: '2026-09-28', note: 'Awaiting echo' } as never), { detailOf: PLAN });
    assert.deepEqual(take(), [['setTarget', [ACTOR, PLAN, '2026-09-28', 'Awaiting echo']], ['detail', [PLAN]]]);
    assert.deepEqual(await c.order(USER, { planId: PLAN }, home as never), { detailOf: PLAN });
    assert.deepEqual(take(), [['order', [ACTOR, PLAN, home]], ['detail', [PLAN]]]);
    await c.check(USER, { planId: PLAN, lines: [line] } as never);
    assert.deepEqual(take(), [['preview', [ACTOR, { planId: PLAN, lines: [line] }]]]);
    assert.deepEqual(await c.edit(USER, { id: ORDER_ID }, { note: 'x' } as never), { detailOf: PLAN });
    assert.deepEqual(take(), [['edit', [ACTOR, ORDER_ID, { note: 'x' }]], ['detail', [PLAN]]]);
    await c.cancel(USER, { id: ORDER_ID }, { reason: 'Fever again' } as never);
    assert.deepEqual(take(), [['cancel', [ACTOR, ORDER_ID, 'Fever again']], ['detail', [PLAN]]]);
    await c.startNow(USER, { id: ORDER_ID });
    assert.deepEqual(take(), [['startNow', [ACTOR, ORDER_ID]], ['detail', [PLAN]]]);
    const tick = { state: 'done', receiver: { name: 'Suresh Kumar', relationship: 'Son' } };
    await c.tick(USER, { id: ORDER_ID, key: 'body-handover' } as never, tick as never);
    assert.deepEqual(take(), [['tick', [ACTOR, ORDER_ID, 'body-handover', tick]], ['detail', [PLAN]]]);
    await c.followUpLater(USER, { id: ORDER_ID, requestId: REQUEST });
    assert.deepEqual(take(), [['followUpLater', [ACTOR, ORDER_ID, REQUEST]], ['detail', [PLAN]]]);
    await c.overrideBill(USER, { id: ORDER_ID }, { reason: 'Revenue was down' } as never);
    assert.deepEqual(take(), [['overrideBill', [ACTOR, ORDER_ID, 'Revenue was down']], ['detail', [PLAN]]]);

    // The summary: drafted on every read, and save and sign pass what the editor loaded (R38).
    const view = await c.getSummary({ id: ORDER_ID });
    assert.deepEqual(take(), [['draft', [ORDER_ID]]]);
    assert.deepEqual([view.id, view.orderId, view.title, view.updatedAt, view.sections], ['s1', ORDER_ID, 'Discharge summary', T, { diagnosis: 'Pneumonia' }]);
    const saved = await c.saveSummary(USER, { id: ORDER_ID }, { sections: { diagnosis: 'CAP' }, course: 'Better', seen: T } as never);
    assert.equal(saved.updatedAt, T);
    assert.deepEqual(take(), [['save', [ACTOR, ORDER_ID, { diagnosis: 'CAP' }, 'Better', T]]]);
    await c.saveSummary(USER, { id: ORDER_ID }, { course: 'Only the course' } as never);
    assert.deepEqual(take(), [['save', [ACTOR, ORDER_ID, {}, 'Only the course', undefined]]]);
    await c.signSummary(USER, { id: ORDER_ID }, { seen: T } as never);
    assert.deepEqual(take(), [['sign', [ACTOR, ORDER_ID, T]]]);
    await c.unlockSummary(USER, { id: ORDER_ID });
    await c.redraftCourse(USER, { id: ORDER_ID });
    assert.deepEqual(take(), [['unlock', [ACTOR, ORDER_ID]], ['redraftCourse', [ACTOR, ORDER_ID]]]);

    // Leaving: the gate pass is the printout; the endings answer with the plan's detail.
    assert.deepEqual(await c.gatePass(USER, { id: ORDER_ID }), { from: 'gatePass' });
    assert.deepEqual(take(), [['gatePass', [ACTOR, ORDER_ID]]]);
    await c.left(USER, { id: ORDER_ID });
    await c.bodyReleased(USER, { id: ORDER_ID });
    assert.deepEqual(take(), [['left', [ACTOR, ORDER_ID]], ['detail', [PLAN]], ['bodyReleased', [ACTOR, ORDER_ID]], ['detail', [PLAN]]]);
    const lwd = { reason: 'Not in bed at the round', lastSeenAt: '2026-09-26T06:30' };
    assert.deepEqual(await c.leftWithoutDischarge(USER, { planId: PLAN }, lwd as never), { detailOf: PLAN });
    assert.deepEqual(take(), [['leftWithoutDischarge', [ACTOR, PLAN, lwd]], ['detail', [PLAN]]]);

    // Settings and the day summary.
    await c.getSettings();
    await c.saveSettings(USER, { leaveMinutes: 90 });
    await c.daySummary();
    assert.deepEqual(take(), [['getSettings', []], ['saveSettings', [ACTOR, { leaveMinutes: 90 }]], ['daySummary', []]]);
  });
});
