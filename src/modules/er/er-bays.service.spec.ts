import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { Actor } from '../beds/actor';
import { UserRole } from '../users/schemas/user.schema';
import { ErBaysService } from './er-bays.service';

const ADMIN: Actor = { id: 'user-admin', name: 'Admin Asha', role: UserRole.ADMIN };
const NURSE: Actor = { id: 'user-nurse', name: 'Nurse Anita', role: UserRole.NURSE };

describe('ErBaysService', () => {
  const m = models();
  let service: ErBaysService;

  const visit = async (n: number, status = 'in-treatment') =>
    (
      await m.ErVisit.create({
        number: `ER-${n}`,
        patient: new Types.ObjectId(),
        patientUhid: `U${n}`,
        patientName: `Patient ${n}`,
        mode: 'walk-in',
        complaint: 'other',
        arrivedAt: new Date(),
        status,
        case: new Types.ObjectId(),
      })
    )._id.toString();
  const bayId = async (name: string) => String(((await m.ErBay.findOne({ name }).lean()) as any)._id);

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    service = new ErBaysService(m.ErBay, m.ErVisit);
    await service.ensureDefaults();
  });

  test('ensureDefaults makes the default list once and never overwrites a saved one', async () => {
    const list = await service.list();
    assert.equal(list.length, 20);
    assert.deepEqual(list.filter((b) => b.kind === 'resus').map((b) => b.name), ['Bay 1', 'Bay 2']);
    assert.equal(list.filter((b) => b.kind === 'bay').length, 10);
    assert.equal(list.filter((b) => b.kind === 'stretcher').length, 8);
    await service.ensureDefaults();
    assert.equal((await service.list()).length, 20);
    await m.ErBay.deleteMany({ name: { $ne: 'Bay 3' } });
    await service.ensureDefaults();
    assert.equal((await service.list()).length, 1);
  });

  test('a red patient is offered a resus bay and a bay holds one visit', async () => {
    assert.equal((await service.suggest('red'))?.name, 'Bay 1');
    assert.equal((await service.suggest('green'))?.name, 'Bay 3');
    const a = await visit(1);
    const b = await visit(2);
    const v = await service.assign(ADMIN, a, await bayId('Bay 1'));
    assert.equal(v.bayName, 'Bay 1');
    assert.equal((await service.suggest('red'))?.name, 'Bay 2');
    const bay1 = await bayId('Bay 1');
    await assert.rejects(() => service.assign(ADMIN, b, bay1), { status: 409, message: 'That bay is taken.' });
    // The same visit asking again is fine.
    await service.assign(ADMIN, a, await bayId('Bay 1'));
  });

  test('suggest falls back from resus to a bay to a stretcher, and never gives resus to other colours', async () => {
    await m.ErBay.updateMany({ kind: 'resus' }, { outOfUse: true });
    assert.equal((await service.suggest('red'))?.name, 'Bay 3');
    await m.ErBay.updateMany({ kind: 'bay' }, { visit: new Types.ObjectId() });
    assert.equal((await service.suggest('red'))?.name, 'Stretcher 1');
    await m.ErBay.updateMany({}, { outOfUse: false });
    await m.ErBay.updateMany({ kind: { $ne: 'resus' } }, { visit: new Types.ObjectId() });
    assert.equal((await service.suggest('orange')), null);
    assert.equal((await service.suggest('red'))?.name, 'Bay 1');
  });

  test('moving a visit to a new bay frees the old one; null frees it', async () => {
    const a = await visit(1);
    await service.assign(ADMIN, a, await bayId('Bay 3'));
    const moved = await service.assign(ADMIN, a, await bayId('Bay 4'));
    assert.equal(moved.bayName, 'Bay 4');
    assert.equal(((await m.ErBay.findOne({ name: 'Bay 3' }).lean()) as any).visit, undefined);
    const freed = await service.assign(ADMIN, a, null);
    assert.equal(freed.bayId, null);
    assert.equal(freed.bayName, null);
    assert.equal(await m.ErBay.countDocuments({ visit: a }), 0);
  });

  test('assign refuses a patient who left and an out-of-use bay', async () => {
    const gone = await visit(1, 'left');
    await assert.rejects(() => service.assign(ADMIN, gone, null), { status: 409, message: 'This patient has left the ER.' });
    const bay5 = await bayId('Bay 5');
    await assert.rejects(() => service.assign(ADMIN, gone, bay5), { status: 409, message: 'This patient has left the ER.' });
    assert.equal(await m.ErBay.countDocuments({ visit: { $exists: true } }), 0);
    await m.ErBay.updateOne({ name: 'Bay 6' }, { outOfUse: true });
    const [bay6, v2] = [await bayId('Bay 6'), await visit(2)];
    await assert.rejects(() => service.assign(ADMIN, v2, bay6), { status: 409 });
  });

  test('two visits racing for one bay: one wins', async () => {
    const [a, b] = [await visit(1), await visit(2)];
    const target = await bayId('Bay 7');
    const results = await Promise.allSettled([service.assign(ADMIN, a, target), service.assign(ADMIN, b, target)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(await m.ErBay.countDocuments({ name: 'Bay 7', visit: { $exists: true } }), 1);
  });

  test('save is admin only, validates names, and cannot remove or take out of use an occupied bay', async () => {
    const full = (await service.list()).map((b) => ({ id: b.id, name: b.name, kind: b.kind, outOfUse: b.outOfUse }));
    await assert.rejects(() => service.save(NURSE, full), { status: 403 });
    await assert.rejects(() => service.save(ADMIN, [{ name: '  ', kind: 'bay', outOfUse: false }]), { status: 400 });
    await assert.rejects(() => service.save(ADMIN, [{ name: 'x'.repeat(41), kind: 'bay', outOfUse: false }]), { status: 400 });
    await assert.rejects(() => service.save(ADMIN, [{ name: 'A', kind: 'cot' as any, outOfUse: false }]), { status: 400 });
    await assert.rejects(() => service.save(ADMIN, [{ name: 'A', kind: 'bay', outOfUse: false }, { name: ' A ', kind: 'bay', outOfUse: false }]), { status: 400 });

    await assert.rejects(() => service.save(ADMIN, [full[0], { ...full[0], name: 'Other' }]), { status: 400 });

    const a = await visit(1);
    await service.assign(ADMIN, a, await bayId('Bay 3'));
    // Removed while occupied.
    await assert.rejects(() => service.save(ADMIN, full.filter((b) => b.name !== 'Bay 3')), { status: 409 });
    // Renamed away while occupied.
    await assert.rejects(() => service.save(ADMIN, full.map((b) => (b.name === 'Bay 3' ? { ...b, name: 'Bay Three' } : b))), { status: 409 });
    // Taken out of use while occupied.
    await assert.rejects(() => service.save(ADMIN, full.map((b) => (b.name === 'Bay 3' ? { ...b, outOfUse: true } : b))), { status: 409 });
    assert.equal(await m.ErBay.countDocuments(), 20);

    // A free bay can be renamed, taken out of use, removed; a new one added; the order follows the list.
    const next = full
      .filter((b) => b.name !== 'Stretcher 8')
      .map((b) => (b.name === 'Bay 4' ? { ...b, name: 'Trauma 4', outOfUse: true } : b));
    next.push({ id: undefined as any, name: 'Bay 13', kind: 'bay', outOfUse: false });
    const saved = await service.save(ADMIN, next);
    assert.equal(saved.length, 20);
    assert.equal(saved[19].name, 'Bay 13');
    assert.equal(saved.find((b) => b.name === 'Trauma 4')?.outOfUse, true);
    assert.equal((await service.suggest('green'))?.name, 'Bay 5');
    assert.equal(await m.ErBay.countDocuments({ name: 'Stretcher 8' }), 0);
  });
});
