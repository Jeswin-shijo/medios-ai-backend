import 'reflect-metadata';
import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ConflictException, ExecutionContext, ForbiddenException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '../users/schemas/user.schema';
import { RevenueController } from './revenue.controller';
import { RevenueScheduler } from './revenue.scheduler';

const R = UserRole;
/** The Global roles table, written out by hand. */
const TOTALS = [R.ADMIN, R.STAFF, R.DOCTOR, R.NURSE];
const DESK = [R.ADMIN, R.STAFF];
const ADMIN = [R.ADMIN];

/** "VERB path" -> the roles it must allow. Every route of the controller appears here once. */
const TABLE: Record<string, UserRole[]> = {
  'GET overview': DESK,
  'GET snapshots': DESK,
  'POST explain/:billId': DESK,
  'POST summary': DESK,
  'GET bills': DESK,
  'GET bills/:id': DESK,
  'POST bills/:id/charges': DESK,
  'POST bills/:id/payments': DESK,
  'POST bills/:id/final/request': DESK,
  'POST bills/:id/final/prepare': DESK,
  'POST bills/:id/settle': DESK,
  'POST bills/:id/corrections': DESK,
  'POST bills/:id/refund': DESK,
  'GET estimates/:billId': DESK,
  'PUT estimates/:id': DESK,
  'GET approvals': DESK,
  'GET payments': DESK,
  'POST payments/:id/cancel': ADMIN,
  'GET payments/:id/receipt': DESK,
  'POST refunds/:id/pay': DESK,
  'GET price-list': DESK,
  'PUT price-list': ADMIN,
  'GET settings': DESK,
  'PUT settings': ADMIN,
  'GET patients/:id/total': TOTALS,
};

const proto = RevenueController.prototype as unknown as Record<string, unknown>;
const names = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor' && typeof proto[n] === 'function');
const handlers = names.filter((n) => Reflect.hasMetadata(PATH_METADATA, proto[n] as object));
const keyOf = (fn: object) => `${RequestMethod[Reflect.getMetadata(METHOD_METADATA, fn)]} ${Reflect.getMetadata(PATH_METADATA, fn)}`;
const guard = new RolesGuard(new Reflector());
const allowed = (name: string, role: UserRole) => {
  const ctx = {
    getHandler: () => proto[name],
    getClass: () => RevenueController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as unknown as ExecutionContext;
  try {
    return guard.canActivate(ctx);
  } catch (e) {
    if (e instanceof ForbiddenException) return false;
    throw e;
  }
};

describe('RevenueController roles', () => {
  test('the controller is mounted at revenue and has exactly the routes of the table', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, RevenueController), 'revenue');
    assert.equal(Object.keys(TABLE).length, 25);
    assert.deepEqual(handlers.map((n) => keyOf(proto[n] as object)).sort(), Object.keys(TABLE).sort());
  });

  test('every route has the roles in the table; pharmacist and lab get 403 everywhere', () => {
    const everyone = Object.values(R) as UserRole[];
    assert.ok(handlers.length > 0);
    for (const name of handlers) {
      const key = keyOf(proto[name] as object);
      assert.ok(Reflect.getMetadata(ROLES_KEY, proto[name] as object), `${key} has a @Roles decorator`);
      for (const role of everyone) assert.equal(allowed(name, role), TABLE[key].includes(role), `${key} as ${role}`);
      assert.equal(allowed(name, R.PHARMACIST), false, `${key} as pharmacist`);
      assert.equal(allowed(name, R.LAB), false, `${key} as lab`);
    }
  });

  test('no route reaches apply or a decision handler (P10-b): approvals come only through the Coordinator', async () => {
    const paths = handlers.map((n) => keyOf(proto[n] as object));
    for (const k of paths) assert.doesNotMatch(k, /apply|decid|approve|reject/i, k);
    const calls: string[] = [];
    const spy = (name: string) => new Proxy({}, { get: (_t, method: string) => async () => { calls.push(`${name}.${method}`); return {}; } });
    const c = new RevenueController(spy('overview') as never, spy('bills') as never, spy('estimates') as never, spy('payments') as never, spy('final') as never, spy('corrections') as never, spy('refunds') as never, spy('prices') as never, spy('settings') as never);
    const user = { _id: 'u1', name: 'Desk', role: R.STAFF };
    const id = '507f1f77bcf86cd799439011';
    await c.addCharge(user, { id }, { category: 'other', qty: 1, reason: 'x' } as never);
    await c.requestCorrection(user, { id }, { kind: 'reversal', reason: 'x' } as never);
    await c.requestRefund(user, { id });
    await c.payRefund(user, { id }, { mode: 'cash' } as never);
    assert.deepEqual(calls, ['corrections.addMissed', 'corrections.request', 'refunds.request', 'refunds.pay']);
  });

  test('the services\' 409 messages pass through unchanged', async () => {
    const boom = new ConflictException('The balance is not zero');
    const settle = { settle: async () => { throw boom; } };
    const none = null as never;
    const c = new RevenueController(none, none, none, none, settle as never, none, none, none, none);
    await assert.rejects(() => c.settle({ _id: 'u1', name: 'Desk', role: R.STAFF }, { id: '507f1f77bcf86cd799439011' }), (e: Error) => e === boom && e.message === 'The balance is not zero');
  });

  test('routes call the service methods with the actor and the ids', async () => {
    const seen: unknown[][] = [];
    const rec = (name: string) => async (...a: unknown[]) => { seen.push([name, ...a]); return { ok: name }; };
    const c = new RevenueController(
      { overview: rec('overview'), series: rec('series') } as never,
      { list: rec('list'), view: rec('view'), patientTotal: rec('patientTotal') } as never,
      { get: rec('estimate'), edit: rec('edit') } as never,
      { record: rec('record'), list: rec('payList'), cancel: rec('cancel'), receipt: rec('receipt') } as never,
      { request: rec('finalRequest'), prepare: rec('prepare'), settle: rec('settle') } as never,
      { addMissed: rec('addMissed'), request: rec('correct') } as never,
      { request: rec('refundRequest'), pay: rec('refundPay') } as never,
      { list: rec('priceList'), upsert: rec('upsert') } as never,
      { get: rec('settingsGet'), save: rec('settingsSave') } as never,
    );
    const user = { _id: 'u1', name: 'Desk', role: R.STAFF };
    const actor = { id: 'u1', name: 'Desk', role: R.STAFF };
    const id = '507f1f77bcf86cd799439011';
    await c.settle(user, { id });
    await c.prepareFinal(user, { id });
    await c.requestFinal(user, { id });
    await c.recordPayment(user, { id }, { amount: 5, mode: 'cash', kind: 'part' });
    await c.cancelPayment(user, { id }, { reason: 'oops' });
    await c.requestCorrection(user, { id }, { kind: 'reversal', reason: 'x', lineId: id });
    await c.payments({ day: '2026-10-20' });
    await c.bills({ state: 'open' });
    await c.estimate({ billId: id });
    assert.deepEqual(seen[0], ['settle', actor, id]);
    assert.deepEqual(seen[1], ['prepare', actor, id]);
    assert.deepEqual(seen[2], ['finalRequest', actor, id]);
    assert.deepEqual(seen[3], ['record', actor, id, { amount: 5, mode: 'cash', reference: undefined, kind: 'part' }]);
    assert.deepEqual(seen[4], ['cancel', actor, id, 'oops']);
    assert.deepEqual(seen[5], ['correct', actor, { billId: id, lineId: id, kind: 'reversal', amount: undefined, qty: undefined, unitPrice: undefined, percent: undefined, reason: 'x' }]);
    assert.deepEqual(seen[6], ['payList', { day: '2026-10-20' }]);
    assert.deepEqual(seen[7], ['list', { state: 'open', kind: undefined, q: undefined }]);
    assert.deepEqual(seen[8], ['estimate', id]);
  });

  test('the scheduler starts after bootstrap and stops on destroy', () => {
    const p = RevenueScheduler.prototype as unknown as Record<string, unknown>;
    assert.equal(typeof p.onApplicationBootstrap, 'function');
    assert.equal(typeof p.onModuleDestroy, 'function');
  });
  test('GET approvals merges the pending corrections and refunds, newest first', async () => {
    const none = null as never;
    const c = new RevenueController(none, none, none, none, none, { listPending: async () => [{ recordId: 'c1', requestedAt: '2026-10-20T10:00:00.000Z' }, { recordId: 'c2', requestedAt: '2026-10-20T08:00:00.000Z' }] } as never, { listPending: async () => [{ recordId: 'r1', requestedAt: '2026-10-20T09:00:00.000Z' }] } as never, none, none);
    const rows = (await c.approvals()) as unknown as { recordId: string }[];
    assert.deepEqual(rows.map((r) => r.recordId), ['c1', 'r1', 'c2']);
  });
});
