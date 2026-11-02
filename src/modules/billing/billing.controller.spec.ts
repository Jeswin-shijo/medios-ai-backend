import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { UserRole } from '../users/schemas/user.schema';
import { BillingController } from './billing.controller';

describe('BillingController roles', () => {
  test('pharmacist and lab get 403 on /billing routes: every route is admin and front desk only', () => {
    const proto = BillingController.prototype as any;
    const routes = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor');
    assert.equal(routes.length, 6);
    for (const name of routes) {
      const roles: UserRole[] = Reflect.getMetadata(ROLES_KEY, proto[name]);
      assert.deepEqual([...roles].sort(), [UserRole.ADMIN, UserRole.STAFF].sort(), name);
      assert.ok(!roles.includes(UserRole.PHARMACIST) && !roles.includes(UserRole.LAB), name);
    }
  });
});
