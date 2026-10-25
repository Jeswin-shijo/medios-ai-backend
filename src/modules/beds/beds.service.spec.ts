import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { PatientsService } from '../patients/patients.service';
import { UserRole } from '../users/schemas/user.schema';
import { Actor } from './actor';
import { BedEvents } from './bed-events';
import { AdmitInput, BedsService } from './beds.service';

const A: Actor = { id: 'user-a', name: 'Nurse Asha', role: UserRole.NURSE };
const B: Actor = { id: 'user-b', name: 'Dr. Bala', role: UserRole.DOCTOR };
const suggestionId = new Types.ObjectId().toString();

/** Counts change signals. */
class SpyEvents extends BedEvents {
  calls = 0;
  changed() {
    this.calls++;
    super.changed();
  }
}

/** Counts patient updates, so a test can show none was attempted. */
class SpyPatients extends PatientsService {
  updates = 0;
  update(...args: Parameters<PatientsService['update']>) {
    this.updates++;
    return super.update(...args);
  }
}

describe('BedsService', () => {
  const { Ward, Bed, Admission, Patient } = models();
  let service: BedsService;
  let events: SpyEvents;
  let patients: SpyPatients;
  let gwaId: string;
  let b1: string;
  let b2: string;
  let b3: string;
  let b4: string;
  let patientId: string;

  const input = (): AdmitInput => ({
    patientId,
    suggestionId,
    doctor: 'Dr. Shajin',
    department: 'General Medicine',
    roomClass: 'general',
    needs: [],
    notes: 'Fever for three days',
    expectedStayDays: 3,
  });
  const bed = (id: string) => Bed.findById(id).lean().exec();
  const expireHold = (id: string) => Bed.updateOne({ _id: id }, { holdExpiresAt: new Date(Date.now() - 60_000) }).exec();

  before(async () => {
    await connectTestDb();
  });

  after(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
    const [gwa] = await Ward.create([
      {
        code: 'GWA', name: 'General ward A (men)', shortName: 'Ward A', floor: 1, type: 'general', gender: 'male',
        ratePerDay: 800, nearDepartments: ['General Medicine'], sortOrder: 0,
      },
      {
        code: 'ICU', name: 'ICU', shortName: 'ICU', floor: 0, type: 'icu', gender: 'any',
        ratePerDay: 7500, nearDepartments: ['Cardiology'], sortOrder: 1,
      },
    ]);
    gwaId = String(gwa._id);
    const gwaBed = (number: number, state: string, extra: Record<string, unknown> = {}) => ({
      ward: gwa._id, label: `Ward A • Bed ${number}`, number, features: ['oxygen'], state, ...extra,
    });
    const created = await Bed.create([
      gwaBed(1, 'free'),
      gwaBed(2, 'free'),
      gwaBed(3, 'occupied', { sample: true, occupantGender: 'Male' }),
      gwaBed(4, 'cleaning'),
    ]);
    [b1, b2, b3, b4] = created.map((b) => String(b._id));
    const patient = await Patient.create({ uhid: 'MHK202600099', name: 'Test Patient', age: 50, gender: 'Male', phone: '9000000099' });
    patientId = String(patient._id);

    events = new SpyEvents();
    patients = new SpyPatients(Patient);
    service = new BedsService(Ward, Bed, Admission, patients, events);
  });

  test('concurrent holds: exactly one wins', async () => {
    const results = await Promise.allSettled([service.hold(b1, A, suggestionId), service.hold(b1, B, suggestionId)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof ConflictException);
    assert.equal(rejected[0].reason.message, 'That bed was just taken. Choose another.');
  });

  test('expired hold can be taken', async () => {
    await service.hold(b1, A, suggestionId);
    await expireHold(b1);
    const held = await service.hold(b1, B, suggestionId);
    assert.equal(held.bedId, b1);
    assert.ok(held.holdExpiresAt.getTime() > Date.now());
    assert.equal((await bed(b1)).holdBy, B.id);
  });

  test("admit needs the caller's live hold", async () => {
    await assert.rejects(service.admit(b1, A, input()), /hold on this bed ran out/);
    await service.hold(b1, A, suggestionId);
    await assert.rejects(service.admit(b1, B, input()), /hold on this bed ran out/);
    await expireHold(b1);
    await assert.rejects(service.admit(b1, A, input()), /hold on this bed ran out/);
    assert.equal(await Admission.countDocuments().exec(), 0);
  });

  test('admit occupies the bed and admits the patient', async () => {
    await service.hold(b1, A, suggestionId);
    const admission = await service.admit(b1, A, input());

    const occupied = await bed(b1);
    assert.equal(occupied.state, 'occupied');
    assert.equal(String(occupied.admission), String(admission._id));
    assert.equal(occupied.occupantGender, 'Male');
    assert.equal(occupied.holdBy, undefined);

    const stored = await Admission.findById(admission._id).lean().exec();
    assert.equal(stored.status, 'active');
    assert.equal(String(stored.bed), b1);
    assert.equal(stored.patientUhid, 'MHK202600099');
    assert.equal(stored.admittedBy, A.name);

    const patient = await Patient.findById(patientId).lean().exec();
    assert.equal(patient.status, 'Admitted');
    assert.equal(patient.visitType, 'IPD');
  });

  test('same patient cannot be admitted twice', async () => {
    await service.hold(b1, A, suggestionId);
    await service.admit(b1, A, input());
    await service.hold(b2, A, suggestionId);
    await assert.rejects(service.admit(b2, A, input()), /already admitted/);
    assert.equal((await bed(b2)).state, 'held');
    assert.equal(await Admission.countDocuments({ status: 'active' }).exec(), 1);
  });

  test('expired hold at confirm', async () => {
    await service.hold(b1, A, suggestionId);
    await expireHold(b1);
    await assert.rejects(service.admit(b1, A, input()), /ran out/);
    assert.equal(await Admission.countDocuments().exec(), 0);
    assert.equal((await Patient.findById(patientId).lean().exec()).status, 'Today');
  });

  test('discharge → cleaning and patient Discharged', async () => {
    await service.hold(b1, A, suggestionId);
    const admission = await service.admit(b1, A, input());
    await service.discharge(b1, B);

    const cleaning = await bed(b1);
    assert.equal(cleaning.state, 'cleaning');
    assert.equal(cleaning.admission, null);
    assert.equal(cleaning.occupantGender, undefined);

    const stored = await Admission.findById(admission._id).lean().exec();
    assert.equal(stored.status, 'discharged');
    assert.ok(stored.dischargedAt instanceof Date);
    assert.equal(stored.dischargedBy, B.name);
    assert.equal((await Patient.findById(patientId).lean().exec()).status, 'Discharged');

    await assert.rejects(service.discharge(b1, B), /This bed is not occupied\./);
  });

  test('discharge a sample bed without admission', async () => {
    await service.discharge(b3, A);
    const cleaning = await bed(b3);
    assert.equal(cleaning.state, 'cleaning');
    assert.equal(cleaning.sample, false);
    assert.equal(cleaning.occupantGender, undefined);
    assert.equal(patients.updates, 0);
  });

  test('clean/block/unblock transitions', async () => {
    await service.markCleaned(b4, A);
    assert.equal((await bed(b4)).state, 'free');
    await assert.rejects(service.markCleaned(b1, A), /This bed is not waiting for cleaning\./);

    await service.block(b1, A, 'Broken rail');
    const blocked = await bed(b1);
    assert.equal(blocked.state, 'blocked');
    assert.equal(blocked.blockedReason, 'Broken rail');
    await assert.rejects(service.block(b3, A, 'Broken rail'), /Only a free bed can be blocked\./);

    await service.unblock(b1, A);
    const unblocked = await bed(b1);
    assert.equal(unblocked.state, 'free');
    assert.equal(unblocked.blockedReason, undefined);
    await assert.rejects(service.unblock(b2, A), /This bed is not blocked\./);
  });

  test('transfer moves the patient', async () => {
    await service.hold(b1, A, suggestionId);
    const admission = await service.admit(b1, A, input());
    await service.hold(b2, A, suggestionId);
    await service.transfer(b1, A, { toBedId: b2, suggestionId, reason: 'Needs to be nearer the nurses' });

    const to = await bed(b2);
    assert.equal(to.state, 'occupied');
    assert.equal(String(to.admission), String(admission._id));
    assert.equal(to.occupantGender, 'Male');
    const from = await bed(b1);
    assert.equal(from.state, 'cleaning');
    assert.equal(from.admission, null);

    const stored = await Admission.findById(admission._id).lean().exec();
    assert.equal(String(stored.bed), b2);
    assert.equal(stored.transfers.length, 1);
    assert.equal(String(stored.transfers[0].fromBed), b1);
    assert.equal(String(stored.transfers[0].toBed), b2);
    assert.equal(stored.transfers[0].reason, 'Needs to be nearer the nurses');
  });

  test('transfer without a live hold on the new bed leaves the patient where they are', async () => {
    await service.hold(b1, A, suggestionId);
    const admission = await service.admit(b1, A, input());
    await assert.rejects(service.transfer(b1, A, { toBedId: b2, suggestionId }), /hold on this bed ran out/);

    assert.equal((await bed(b1)).state, 'occupied');
    assert.equal((await bed(b2)).state, 'free');
    const stored = await Admission.findById(admission._id).lean().exec();
    assert.equal(String(stored.bed), b1);
    assert.equal(stored.transfers.length, 0);
  });

  test('board totals and expired holds read as free', async () => {
    await service.hold(b1, A, suggestionId);
    await expireHold(b1);
    const board = await service.board(B);
    assert.equal(board.beds.find((b) => b.id === b1).state, 'free');
    assert.deepEqual(board.totals, { total: 4, occupied: 1, free: 2, cleaning: 1, held: 0, blocked: 0, percentFull: 25 });
  });

  test('board shows holds and the admitted patient', async () => {
    await service.hold(b1, A, suggestionId);
    const admission = await service.admit(b1, A, input());
    await service.hold(b2, A, suggestionId);

    const board = await service.board(A);
    assert.deepEqual(board.wards.map((w) => w.code), ['GWA', 'ICU']);
    const view = (id: string) => board.beds.find((b) => b.id === id);
    assert.equal(view(b1).wardId, gwaId);
    assert.deepEqual(view(b1).patient, {
      id: patientId,
      name: 'Test Patient',
      uhid: 'MHK202600099',
      admissionId: String(admission._id),
      admittedAt: admission.admittedAt.toISOString(),
    });
    assert.equal(view(b2).state, 'held');
    assert.equal(view(b2).heldByMe, true);
    assert.equal(view(b3).patient, undefined);
    assert.equal(view(b3).sample, true);
    assert.equal((await service.board(B)).beds.find((b) => b.id === b2).heldByMe, false);
  });

  test('inventory and the active admission', async () => {
    assert.equal(await service.activeAdmissionForPatient(patientId), null);
    await service.hold(b1, A, suggestionId);
    const admission = await service.admit(b1, A, input());
    assert.equal(String((await service.activeAdmissionForPatient(patientId))._id), String(admission._id));

    const { wards, beds } = await service.inventory();
    assert.equal(wards.find((w) => w.code === 'GWA').id, gwaId);
    const free = beds.find((b) => b.id === b2);
    assert.equal(free.wardId, gwaId);
    assert.equal(free.state, 'free');
    assert.equal(free.freeSince.getTime(), (await bed(b2)).stateSince.getTime());
    const occupied = beds.find((b) => b.id === b3);
    assert.equal(occupied.occupantGender, 'Male');
    assert.equal(occupied.freeSince, undefined);
  });

  test('every change emits', async () => {
    let last = events.calls;
    const emits = async (change: () => Promise<unknown>) => {
      await change();
      assert.ok(events.calls > last);
      last = events.calls;
    };
    await emits(() => service.hold(b1, A, suggestionId));
    await emits(() => service.admit(b1, A, input()));
    await emits(() => service.discharge(b1, A));
    await emits(() => service.markCleaned(b1, A));
    await emits(() => service.block(b1, A, 'Broken rail'));
  });
});
