import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { BadRequestException, ExecutionContext, ForbiddenException, ValidationPipe } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '../users/schemas/user.schema';
import { AnswerDto, PharmacyOrderDto } from './dto/pharmacy.dto';
import { PharmacyController } from './pharmacy.controller';

const R = UserRole;
const READ = [R.ADMIN, R.DOCTOR, R.NURSE, R.PHARMACIST];
const ORDER = [R.ADMIN, R.DOCTOR];
const CHECK = [R.ADMIN, R.PHARMACIST];
const STOCK = [R.ADMIN, R.PHARMACIST];
const ADMIN = [R.ADMIN];

/** "VERB path" -> the roles it must allow. Every route of the controller appears here once. */
const TABLE: Record<string, UserRole[]> = {
  'GET catalogue': READ,
  'GET overview': READ,
  'GET snapshots': READ,
  'GET orders': READ,
  'GET orders/:id': READ,
  'GET lines/:id': READ,
  'GET patients/:id/lines': READ,
  'GET worklist': READ,
  'POST check': ORDER,
  'POST orders': ORDER,
  'POST lines/:id/cancel': ORDER,
  'POST lines/:id/answer': ORDER,
  'POST lines/:id/approve': CHECK,
  'POST lines/:id/query': CHECK,
  'POST lines/:id/reject': CHECK,
  'GET lines/:id/issue-options': CHECK,
  'POST lines/:id/issue': CHECK,
  'POST lines/:id/out-of-stock': CHECK,
  'POST lines/:id/flags/:key/explain': READ,
  'GET stock': READ,
  'GET stock/movements': READ,
  'POST stock/receive': STOCK,
  'POST stock/batches/:id/adjust': STOCK,
  'POST stock/batches/:id/remove-expired': STOCK,
  'PUT stock/levels': STOCK,
  'GET settings': READ,
  'PUT settings': ADMIN,
};

const proto = PharmacyController.prototype as unknown as Record<string, unknown>;
const handlers = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor' && typeof proto[n] === 'function' && Reflect.hasMetadata(PATH_METADATA, proto[n] as object));
const keyOf = (fn: object) => `${RequestMethod[Reflect.getMetadata(METHOD_METADATA, fn)]} ${Reflect.getMetadata(PATH_METADATA, fn)}`;
const guard = new RolesGuard(new Reflector());
const allowed = (name: string, role: UserRole) => {
  const ctx = {
    getHandler: () => proto[name],
    getClass: () => PharmacyController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as unknown as ExecutionContext;
  try {
    return guard.canActivate(ctx);
  } catch (e) {
    if (e instanceof ForbiddenException) return false;
    throw e;
  }
};

describe('PharmacyController roles', () => {
  test('the controller is mounted at pharmacy and has exactly the 27 routes', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, PharmacyController), 'pharmacy');
    assert.deepEqual(handlers.map((n) => keyOf(proto[n] as object)).sort(), Object.keys(TABLE).sort());
  });

  test('every route allows exactly its roles, and lab and front desk get 403 everywhere', () => {
    const everyone = Object.values(R) as UserRole[];
    for (const name of handlers) {
      const key = keyOf(proto[name] as object);
      for (const role of everyone) {
        assert.equal(allowed(name, role), TABLE[key].includes(role), `${key} as ${role}`);
      }
      assert.equal(allowed(name, R.LAB), false, `${key} as lab`);
      assert.equal(allowed(name, R.STAFF), false, `${key} as staff`);
    }
  });

  test('a nurse can read but not order, check or touch stock; a doctor cannot check, issue or receive; a pharmacist cannot order or answer', () => {
    const by = (key: string) => handlers.find((n) => keyOf(proto[n] as object) === key)!;
    assert.equal(allowed(by('GET orders'), R.NURSE), true);
    assert.equal(allowed(by('POST orders'), R.NURSE), false);
    assert.equal(allowed(by('POST lines/:id/approve'), R.NURSE), false);
    assert.equal(allowed(by('POST lines/:id/approve'), R.DOCTOR), false);
    assert.equal(allowed(by('POST lines/:id/issue'), R.DOCTOR), false);
    assert.equal(allowed(by('POST stock/receive'), R.DOCTOR), false);
    assert.equal(allowed(by('POST lines/:id/answer'), R.PHARMACIST), false);
    assert.equal(allowed(by('POST lines/:id/cancel'), R.PHARMACIST), false);
    assert.equal(allowed(by('PUT settings'), R.DOCTOR), false);
    assert.equal(allowed(by('PUT settings'), R.ADMIN), true);
  });
});

describe('PharmacyController bodies', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  test('an answer with querySeq as a string is a 400, not a 409', async () => {
    await assert.rejects(() => pipe.transform({ querySeq: '1', outcome: 'keep', reason: 'x' }, { type: 'body', metatype: AnswerDto }), BadRequestException);
    const ok = (await pipe.transform({ querySeq: 1, outcome: 'keep', reason: 'x' }, { type: 'body', metatype: AnswerDto })) as AnswerDto;
    assert.equal(ok.querySeq, 1);
  });
  test('an order with 11 lines is a 400', async () => {
    const line = { medicine: 'ibuprofen', product: 'ibuprofen-tab-400', dose: 400, route: 'oral', frequency: 'TDS', durationDays: 5 };
    await assert.rejects(
      () => pipe.transform({ patientId: '507f1f77bcf86cd799439011', priority: 'routine', lines: Array.from({ length: 11 }, () => line) }, { type: 'body', metatype: PharmacyOrderDto }),
      BadRequestException,
    );
  });
});
