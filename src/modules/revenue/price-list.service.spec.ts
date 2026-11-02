import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { UserRole } from '../users/schemas/user.schema';
import { PriceListService } from './price-list.service';

const ADMIN = { id: 'a1', name: 'Admin', role: UserRole.ADMIN };
const STAFF = { id: 's1', name: 'Front', role: UserRole.STAFF };

describe('PriceListService', () => {
  const m = models();
  let svc: PriceListService;

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    svc = new PriceListService(m.PriceItem, m.Ward, m.OpDoctor);
  });

  test('priceFor an unknown code is ₹0 with needsPrice', async () => {
    assert.deepEqual(await svc.priceFor('lab:nothing'), { price: 0, name: 'lab:nothing', needsPrice: true });
    await svc.upsert(ADMIN, { code: 'lab:cbc', name: 'CBC', category: 'lab', price: 350 });
    assert.deepEqual(await svc.priceFor('lab:cbc'), { price: 350, name: 'CBC', needsPrice: false });
    await svc.upsert(ADMIN, { code: 'lab:cbc', name: 'CBC', category: 'lab', price: 350, active: false });
    assert.equal((await svc.priceFor('lab:cbc')).needsPrice, true);
    await svc.upsert(ADMIN, { code: 'lab:zero', name: 'Zero', category: 'lab', price: 0 });
    assert.deepEqual(await svc.priceFor('lab:zero'), { price: 0, name: 'Zero', needsPrice: true });
  });

  test('a price change applies only to new charges and is logged', async () => {
    await svc.upsert(ADMIN, { code: 'proc:hernia-repair', name: 'Hernia repair', category: 'procedure', price: 40000 });
    const changed = await svc.upsert(ADMIN, { code: 'proc:hernia-repair', name: 'Hernia repair', category: 'procedure', price: 45000 });
    assert.equal(changed!.price, 45000);
    assert.equal(changed!.log.length, 2);
    assert.equal(changed!.log[0].from, null);
    assert.equal(changed!.log[1].from, 40000);
    assert.equal(changed!.log[1].to, 45000);
    assert.equal(changed!.log[1].by, 'Admin');
    assert.ok(changed!.log[1].at instanceof Date);

    await assert.rejects(() => svc.upsert(STAFF, { code: 'lab:x', name: 'X', category: 'lab', price: 1 }), (e: any) => e.status === 403);
    for (const bad of [
      { code: 'Lab:CBC', name: 'x', category: 'lab', price: 1 },
      { code: 'lab', name: 'x', category: 'lab', price: 1 },
      { code: 'lab:cbc', name: 'x', category: 'bogus', price: 1 },
      { code: 'lab:cbc', name: 'x', category: 'lab', price: -1 },
      { code: 'lab:cbc', name: 'x', category: 'lab', price: 1.5 },
    ]) {
      await assert.rejects(() => svc.upsert(ADMIN, bad), (e: any) => e.status === 400, JSON.stringify(bad));
    }
    assert.equal((await svc.list({ category: 'procedure' })).length, 1);
    assert.equal((await svc.list({ q: 'HERNIA' })).length, 1);
  });

  test("bedRate reads the ward's ratePerDay", async () => {
    const ward = await m.Ward.create({ code: 'ICU-1', name: 'Intensive Care', shortName: 'ICU', floor: 1, type: 'icu', gender: 'any', ratePerDay: 6500 });
    assert.deepEqual(await svc.bedRate(String(ward._id)), { price: 6500, wardType: 'icu', wardName: 'Intensive Care' });
    assert.deepEqual(await svc.bedRate('64b000000000000000000000'), { price: 0, wardType: 'general', wardName: '' });
    assert.deepEqual(await svc.bedRate('not-an-id'), { price: 0, wardType: 'general', wardName: '' });
  });

  test('opdFee of a doctor with fee 0 needs a price', async () => {
    const paid = await m.OpDoctor.create({ name: 'Dr A', departmentCode: 'gm', room: 'R1', tokenPrefix: 'A', fee: 300 });
    const free = await m.OpDoctor.create({ name: 'Dr B', departmentCode: 'gm', room: 'R2', tokenPrefix: 'B', fee: 0 });
    assert.deepEqual(await svc.opdFee(String(paid._id)), { price: 300, doctorName: 'Dr A', needsPrice: false });
    assert.deepEqual(await svc.opdFee(String(free._id)), { price: 0, doctorName: 'Dr B', needsPrice: true });
    assert.equal((await svc.opdFee('64b000000000000000000000')).needsPrice, true);
  });
});
