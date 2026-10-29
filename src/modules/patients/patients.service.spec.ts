import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { PatientsService } from './patients.service';

describe('PatientsService.update', () => {
  const m = models();
  let service: PatientsService;

  /** An unknown ER patient, as the ER agent registers one. */
  const placeholder = async () =>
    String((await m.Patient.create({ uhid: 'MHK202600901', name: 'Unknown male, ER-0007', age: 40, gender: 'Male', phone: '', detailsPending: true }))._id);
  const pending = async (id: string) => ((await m.Patient.findById(id).lean().exec()) as any).detailsPending;

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    service = new PatientsService(m.Patient);
  });

  test('a real name and a phone clear details pending', async () => {
    const id = await placeholder();
    const out = await service.update(id, { name: 'Ravi Kumar', phone: '9100000001' });
    assert.equal(out.detailsPending, false);
    assert.equal(await pending(id), false);
  });

  test('still pending when only the age changed, or the name or the phone is still missing', async () => {
    const id = await placeholder();
    assert.equal((await service.update(id, { age: 42 })).detailsPending, true);
    assert.equal((await service.update(id, { phone: '9100000001' })).detailsPending, true, 'the name is still the placeholder');
    await service.update(id, { phone: '' });
    assert.equal((await service.update(id, { name: 'Ravi Kumar' })).detailsPending, true, 'no phone yet');
    assert.equal((await service.update(id, { phone: '   ' })).detailsPending, true, 'a blank phone is no phone');
    assert.equal(await pending(id), true);
  });

  test('an explicit detailsPending: false is honoured', async () => {
    const id = await placeholder();
    const out = await service.update(id, { detailsPending: false, phone: '9100000002' });
    assert.equal(out.detailsPending, false);
    assert.equal(await pending(id), false);
  });

  test('a patient who was never a placeholder is left as is', async () => {
    const p = await m.Patient.create({ uhid: 'MHK202600902', name: 'Latha Devi', age: 33, gender: 'Female', phone: '9100000003' });
    const out = await service.update(String(p._id), { age: 34 });
    assert.equal(out.detailsPending, false);
  });
});
