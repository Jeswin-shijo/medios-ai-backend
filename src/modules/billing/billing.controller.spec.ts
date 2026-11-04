import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '../users/schemas/user.schema';
import { BillingController } from './billing.controller';

/** The request context the RolesGuard reads: the handler's metadata and the signed-in role. */
function ctx(handler: unknown, role: UserRole) {
  return {
    getHandler: () => handler,
    getClass: () => BillingController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as any;
}

describe('BillingController roles', () => {
  const proto = BillingController.prototype as any;
  const guard = new RolesGuard(new Reflector());

  test('every /billing route but the invoice list is admin and front desk only', () => {
    const routes = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor' && n !== 'findAll');
    assert.equal(routes.length, 5);
    for (const name of routes) {
      const roles: UserRole[] = Reflect.getMetadata(ROLES_KEY, proto[name]);
      assert.deepEqual([...roles].sort(), [UserRole.ADMIN, UserRole.STAFF].sort(), name);
      assert.ok(!roles.includes(UserRole.PHARMACIST) && !roles.includes(UserRole.LAB), name);
    }
  });

  test('R43: GET /billing/invoices answers [] (200) for doctor and nurse, without reading invoices', async () => {
    let reads = 0;
    const controller = new BillingController({ findAll: async () => { reads++; return [{ invoiceNumber: 'INV-1' }]; } } as any);
    for (const role of [UserRole.DOCTOR, UserRole.NURSE, UserRole.PHARMACIST, UserRole.LAB]) {
      assert.equal(guard.canActivate(ctx(proto.findAll, role)), true, role);
      assert.deepEqual(await controller.findAll({ role }), [], role);
    }
    assert.equal(reads, 0);
  });

  test('R43: admin and front desk still get the invoice list', async () => {
    const seen: unknown[] = [];
    const controller = new BillingController({
      findAll: async (q: unknown) => { seen.push(q); return [{ invoiceNumber: 'INV-1' }]; },
    } as any);
    for (const role of [UserRole.ADMIN, UserRole.STAFF]) {
      assert.equal(guard.canActivate(ctx(proto.findAll, role)), true, role);
      assert.deepEqual(await controller.findAll({ role }, 'MHK1', 'Paid'), [{ invoiceNumber: 'INV-1' }], role);
    }
    assert.deepEqual(seen, [{ uhid: 'MHK1', status: 'Paid' }, { uhid: 'MHK1', status: 'Paid' }]);
  });

  test('R43: every /billing write stays 403 for pharmacist, lab, doctor and nurse', () => {
    for (const name of ['create', 'recordPayment', 'updateNotes']) {
      for (const role of [UserRole.PHARMACIST, UserRole.LAB, UserRole.DOCTOR, UserRole.NURSE]) {
        assert.throws(() => guard.canActivate(ctx(proto[name], role)), ForbiddenException, `${name} ${role}`);
      }
      assert.equal(guard.canActivate(ctx(proto[name], UserRole.STAFF)), true, name);
    }
  });
});
