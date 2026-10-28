import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { PatientsService } from '../patients/patients.service';
import { UserRole } from '../users/schemas/user.schema';
import { Actor } from './actor';
import { BedEvents } from './bed-events';
import { AdmissionRequestInput } from './bed-types';
import { AdmitInput, BedsService } from './beds.service';
import { applyRules } from './rules';

const A: Actor = { id: 'user-a', name: 'Nurse Asha', role: UserRole.NURSE };
const B: Actor = { id: 'user-b', name: 'Dr. Bala', role: UserRole.DOCTOR };
const suggestionId = new Types.ObjectId().toString();
const OTHER_GENDER = 'This room now has a patient of another gender. Choose another bed.';
/** A woman asking for a twin room. */
const woman: AdmissionRequestInput = {
  age: 40, gender: 'Female', roomClass: 'twin', needs: [], department: 'General Medicine', expectedStayDays: 3, notes: '',
};

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
  /** Twin room 3: beds A and B, both free. Returns their ids. */
  const twinRoom = async (): Promise<[string, string]> => {
    const ward = await Ward.create({
      code: 'TWN', name: 'Twin-sharing rooms', shortName: 'Twin', floor: 2, type: 'twin', gender: 'any',
      ratePerDay: 1500, nearDepartments: [], sortOrder: 2,
    });
    const [a, b] = await Bed.create([
      { ward: ward._id, label: 'Twin 3 • Bed A', number: 5, room: '3', features: [], state: 'free' },
      { ward: ward._id, label: 'Twin 3 • Bed B', number: 6, room: '3', features: [], state: 'free' },
    ]);
    return [String(a._id), String(b._id)];
  };
  const offeredTo = async (req: AdmissionRequestInput) => {
    const { wards, beds } = await service.inventory();
    return applyRules(req, wards, beds, new Date()).candidates.map((c) => c.id);
  };

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
    const results = await Promise.allSettled([service.hold(b1, A, suggestionId, 'Male'), service.hold(b1, B, suggestionId, 'Male')]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof ConflictException);
    assert.equal(rejected[0].reason.message, 'That bed was just taken. Choose another.');
  });

  test('expired hold can be taken', async () => {
    await service.hold(b1, A, suggestionId, 'Male');
    await expireHold(b1);
    const held = await service.hold(b1, B, suggestionId, 'Male');
    assert.equal(held.bedId, b1);
    assert.ok(held.holdExpiresAt.getTime() > Date.now());
    assert.equal((await bed(b1)).holdBy, B.id);
  });

  test('a twin room stays one gender: a held or occupied roommate refuses another gender', async () => {
    const [a, b] = await twinRoom();
    await service.hold(a, A, suggestionId, 'Male');
    assert.equal((await bed(a)).holdGender, 'Male');
    await assert.rejects(
      service.hold(b, B, suggestionId, 'Female'),
      (err: unknown) => err instanceof ConflictException && err.message === OTHER_GENDER,
    );
    assert.equal((await bed(b)).state, 'free');

    // Admitted, the man still keeps the room male.
    await service.admit(a, A, input());
    assert.equal((await bed(a)).holdGender, undefined);
    await assert.rejects(service.hold(b, B, suggestionId, 'Female'), (err: unknown) => (err as Error).message === OTHER_GENDER);
    await service.hold(b, B, suggestionId, 'Male');
    await service.release(b, B);
    assert.equal((await bed(b)).holdGender, undefined);
  });

  test('two holds for different genders in one twin room at once: at most one stays', async () => {
    const [a, b] = await twinRoom();
    const results = await Promise.allSettled([service.hold(a, A, suggestionId, 'Male'), service.hold(b, B, suggestionId, 'Female')]);
    const held = await Bed.countDocuments({ _id: { $in: [a, b] }, state: 'held' }).exec();
    assert.ok(held <= 1, `${held} beds held`);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, held);
  });

  test("the rules leave out a twin bed whose roommate is held for another gender", async () => {
    const [a, b] = await twinRoom();
    await service.hold(a, A, suggestionId, 'Male');
    assert.ok(!(await offeredTo(woman)).includes(b));
    assert.ok((await offeredTo({ ...woman, gender: 'Male' })).includes(b));
  });

  test('an expired hold does not count for the twin room', async () => {
    const [a, b] = await twinRoom();
    await service.hold(a, A, suggestionId, 'Male');
    await expireHold(a);
    assert.ok((await offeredTo(woman)).includes(b));
    await service.hold(b, B, suggestionId, 'Female');
    assert.equal((await bed(b)).holdGender, 'Female');
  });

  test("admit needs the caller's live hold", async () => {
    await assert.rejects(service.admit(b1, A, input()), /hold on this bed ran out/);
    await service.hold(b1, A, suggestionId, 'Male');
    await assert.rejects(service.admit(b1, B, input()), /hold on this bed ran out/);
    await expireHold(b1);
    await assert.rejects(service.admit(b1, A, input()), /hold on this bed ran out/);
    assert.equal(await Admission.countDocuments().exec(), 0);
  });

  test('admit occupies the bed and admits the patient', async () => {
    await service.hold(b1, A, suggestionId, 'Male');
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
    await service.hold(b1, A, suggestionId, 'Male');
    await service.admit(b1, A, input());
    await service.hold(b2, A, suggestionId, 'Male');
    await assert.rejects(service.admit(b2, A, input()), /already admitted/);
    assert.equal((await bed(b2)).state, 'held');
    assert.equal(await Admission.countDocuments({ status: 'active' }).exec(), 1);
  });

  test('expired hold at confirm', async () => {
    await service.hold(b1, A, suggestionId, 'Male');
    await expireHold(b1);
    await assert.rejects(service.admit(b1, A, input()), /ran out/);
    assert.equal(await Admission.countDocuments().exec(), 0);
    assert.equal((await Patient.findById(patientId).lean().exec()).status, 'Today');
  });

  test('discharge → cleaning and patient Discharged', async () => {
    await service.hold(b1, A, suggestionId, 'Male');
    const admission = await service.admit(b1, A, input());
    await service.discharge(b1, B, String(admission._id));

    const cleaning = await bed(b1);
    assert.equal(cleaning.state, 'cleaning');
    assert.equal(cleaning.admission, null);
    assert.equal(cleaning.occupantGender, undefined);

    const stored = await Admission.findById(admission._id).lean().exec();
    assert.equal(stored.status, 'discharged');
    assert.ok(stored.dischargedAt instanceof Date);
    assert.equal(stored.dischargedBy, B.name);
    assert.equal((await Patient.findById(patientId).lean().exec()).status, 'Discharged');

    await assert.rejects(service.discharge(b1, B, String(admission._id)), /This bed is not occupied\./);
  });

  test('discharge must name the admission in the bed: a stale one changes nothing', async () => {
    await service.hold(b1, A, suggestionId, 'Male');
    const admission = await service.admit(b1, A, input());
    const changed = (err: unknown) =>
      err instanceof ConflictException && err.message === 'This bed changed since you opened it. Check the board and try again.';
    const calls = events.calls;

    await assert.rejects(service.discharge(b1, B, new Types.ObjectId().toString()), changed);
    await assert.rejects(service.discharge(b1, B, null), changed);
    // A sample occupant has no admission: naming one is stale too.
    await assert.rejects(service.discharge(b3, B, String(admission._id)), changed);

    const kept = await bed(b1);
    assert.equal(kept.state, 'occupied');
    assert.equal(String(kept.admission), String(admission._id));
    assert.equal((await Admission.findById(admission._id).lean().exec()).status, 'active');
    assert.equal((await Patient.findById(patientId).lean().exec()).status, 'Admitted');
    assert.equal((await bed(b3)).state, 'occupied');
    assert.equal(events.calls, calls);
  });

  test('discharge a sample bed without admission', async () => {
    await service.discharge(b3, A, null);
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

  test('a bed whose hold expired can be blocked; a live hold cannot', async () => {
    await service.hold(b1, A, suggestionId, 'Male');
    await expireHold(b1);
    await service.block(b1, B, 'Broken rail');
    const blocked = await bed(b1);
    assert.equal(blocked.state, 'blocked');
    assert.equal(blocked.blockedReason, 'Broken rail');
    assert.equal(blocked.holdBy, undefined);
    assert.equal(blocked.holdExpiresAt, undefined);
    assert.equal(blocked.holdSuggestion, undefined);
    assert.equal(blocked.holdGender, undefined);

    await service.hold(b2, A, suggestionId, 'Male');
    await assert.rejects(service.block(b2, B, 'Broken rail'), /Only a free bed can be blocked\./);
    assert.equal((await bed(b2)).state, 'held');
  });

  test('transfer moves the patient', async () => {
    await service.hold(b1, A, suggestionId, 'Male');
    const admission = await service.admit(b1, A, input());
    await service.hold(b2, A, suggestionId, 'Male');
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
    await service.hold(b1, A, suggestionId, 'Male');
    const admission = await service.admit(b1, A, input());
    await assert.rejects(service.transfer(b1, A, { toBedId: b2, suggestionId }), /hold on this bed ran out/);

    assert.equal((await bed(b1)).state, 'occupied');
    assert.equal((await bed(b2)).state, 'free');
    const stored = await Admission.findById(admission._id).lean().exec();
    assert.equal(String(stored.bed), b1);
    assert.equal(stored.transfers.length, 0);
  });

  test('the admission in a bed, to start a transfer from', async () => {
    await service.hold(b1, A, suggestionId, 'Male');
    const admission = await service.admit(b1, A, { ...input(), needs: ['oxygen'] });
    assert.deepEqual(await service.admissionInBed(b1), {
      admissionId: String(admission._id),
      patient: { id: patientId, name: 'Test Patient', uhid: 'MHK202600099', age: 50, gender: 'Male' },
      roomClass: 'general',
      needs: ['oxygen'],
      department: 'General Medicine',
      doctor: 'Dr. Shajin',
      notes: 'Fever for three days',
      expectedStayDays: 3,
    });
    // A free bed and a sample occupant have no admission to move.
    for (const empty of [b2, b3]) {
      await assert.rejects(
        service.admissionInBed(empty),
        (err: unknown) => err instanceof NotFoundException && err.message === 'This bed has no admitted patient.',
      );
    }
  });

  test('board totals and expired holds read as free', async () => {
    await service.hold(b1, A, suggestionId, 'Male');
    await expireHold(b1);
    const board = await service.board(B);
    assert.equal(board.beds.find((b) => b.id === b1).state, 'free');
    assert.deepEqual(board.totals, { total: 4, occupied: 1, free: 2, cleaning: 1, held: 0, blocked: 0, percentFull: 25 });
  });

  test('board shows holds and the admitted patient', async () => {
    await service.hold(b1, A, suggestionId, 'Male');
    const admission = await service.admit(b1, A, input());
    await service.hold(b2, A, suggestionId, 'Male');

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
      sample: false,
    });
    assert.equal(view(b2).state, 'held');
    assert.equal(view(b2).heldByMe, true);
    assert.equal(view(b3).patient, undefined);
    assert.equal(view(b3).sample, true);
    assert.equal((await service.board(B)).beds.find((b) => b.id === b2).heldByMe, false);
  });

  test('inventory and the active admission', async () => {
    assert.equal(await service.activeAdmissionForPatient(patientId), null);
    await service.hold(b1, A, suggestionId, 'Male');
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

  /** A second patient, for races and twin rooms. */
  const otherPatient = async (gender: 'Male' | 'Female', n: number) =>
    String((await Patient.create({ uhid: `MHK20260010${n}`, name: `Other ${n}`, age: 40, gender, phone: `900000010${n}` }))._id);
  const sampleAdmission = (bedId: string) =>
    Admission.create({
      patient: new Types.ObjectId(), patientUhid: 'SAMPLE-1', patientName: 'Sample Sam', bed: bedId, roomClass: 'general',
      expectedStayDays: 2, status: 'active', admittedAt: new Date(), admittedBy: 'Seed', sample: true,
    });

  test('admitToFreeBed admits to a free bed with no hold', async () => {
    const { suggestionId: _omit, ...noSuggestion } = input();
    const admission = await service.admitToFreeBed(b1, A, noSuggestion);
    assert.equal(admission.status, 'active');
    assert.equal(admission.suggestion, undefined);
    const after = await bed(b1);
    assert.equal(after.state, 'occupied');
    assert.equal(String(after.admission), String(admission._id));
    assert.equal(after.occupantGender, 'Male');
    assert.equal((await Patient.findById(patientId).lean().exec()).status, 'Admitted');
    const withSuggestion = await service.admitToFreeBed(b2, A, { ...input(), patientId: await otherPatient('Male', 1) });
    assert.equal(String(withSuggestion.suggestion), suggestionId);
  });

  test('admitToFreeBed treats an expired hold as free and refuses a live hold', async () => {
    await service.hold(b1, B, suggestionId, 'Male');
    await assert.rejects(() => service.admitToFreeBed(b1, A, input()), ConflictException);
    assert.equal(await Admission.countDocuments(), 0);
    await expireHold(b1);
    await service.admitToFreeBed(b1, A, input());
    const after = await bed(b1);
    assert.equal(after.state, 'occupied');
    assert.equal(after.holdBy, undefined);
  });

  test('admitToFreeBed: of two admits to one free bed at once, exactly one wins', async () => {
    const other = await otherPatient('Male', 2);
    const results = await Promise.allSettled([
      service.admitToFreeBed(b1, A, input()),
      service.admitToFreeBed(b1, B, { ...input(), patientId: other }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof ConflictException);
    assert.equal(await Admission.countDocuments(), 1);
  });

  test('admitToFreeBed refuses a twin bed whose roommate is another gender', async () => {
    const [a, b] = await twinRoom();
    const femaleId = await otherPatient('Female', 3);
    await service.admitToFreeBed(a, A, { ...input(), patientId: femaleId });
    await assert.rejects(() => service.admitToFreeBed(b, A, input()), { message: OTHER_GENDER });
    assert.equal((await bed(b)).state, 'free');
    assert.equal(await Admission.countDocuments({ patient: patientId }), 0);
    assert.equal(patients.updates, 1);
  });

  test('transferToFreeBed moves the patient and sends the old bed to cleaning', async () => {
    const admission = await service.admitToFreeBed(b1, A, input());
    const moved = await service.transferToFreeBed(b1, b2, A, 'Closer to the nurses');
    assert.equal(String(moved.bed), b2);
    assert.equal(moved.transfers.length, 1);
    assert.equal(moved.transfers[0].reason, 'Closer to the nurses');
    const [from, to] = [await bed(b1), await bed(b2)];
    assert.equal(from.state, 'cleaning');
    assert.equal(from.admission, null);
    assert.equal(to.state, 'occupied');
    assert.equal(String(to.admission), String(admission._id));
    assert.equal(to.occupantGender, 'Male');
    await assert.rejects(() => service.transferToFreeBed(b2, b4, A), ConflictException);
    assert.equal(String((await Admission.findById(admission._id).lean().exec()).bed), b2);
  });

  test('transferToFreeBed refuses a twin bed when neither the old bed nor the caller knows the gender', async () => {
    const [a] = await twinRoom();
    const admission = await service.admitToFreeBed(b1, A, input());
    await Bed.updateOne({ _id: b1 }, { $unset: { occupantGender: 1 } }).exec();

    await assert.rejects(() => service.transferToFreeBed(b1, a, A), ConflictException);
    assert.equal((await bed(a)).state, 'free');
    assert.equal(String((await Admission.findById(admission._id).lean().exec()).bed), b1);
    assert.equal((await bed(b1)).state, 'occupied');

    // Given the gender (the Bed Agent passes the request's), the move goes ahead and the twin bed records it.
    await service.transferToFreeBed(b1, a, A, undefined, 'Male');
    const to = await bed(a);
    assert.equal(to.state, 'occupied');
    assert.equal(to.occupantGender, 'Male');
  });

  test('discharging a sample admission ends it and never updates a patient', async () => {
    const sample = await sampleAdmission(b3);
    await Bed.updateOne({ _id: b3 }, { admission: sample._id });
    await service.discharge(b3, A, String(sample._id));
    assert.equal((await Admission.findById(sample._id).lean().exec()).status, 'discharged');
    assert.equal((await bed(b3)).state, 'cleaning');
    assert.equal(patients.updates, 0);
  });

  test("the board shows a sample admission's name with sample: true", async () => {
    const sample = await sampleAdmission(b3);
    await Bed.updateOne({ _id: b3 }, { admission: sample._id });
    const shown = (await service.board(A)).beds.find((x) => x.id === b3).patient;
    assert.equal(shown.name, 'Sample Sam');
    assert.equal(shown.sample, true);
    assert.equal(shown.id, '');
    await assert.rejects(() => service.admissionInBed(b3), { message: 'A sample inpatient cannot be transferred.' });
  });

  test('every change emits', async () => {
    let last = events.calls;
    const emits = async (change: () => Promise<unknown>) => {
      await change();
      assert.ok(events.calls > last);
      last = events.calls;
    };
    await emits(() => service.hold(b1, A, suggestionId, 'Male'));
    let admissionId = '';
    await emits(async () => (admissionId = String((await service.admit(b1, A, input()))._id)));
    await emits(() => service.discharge(b1, A, admissionId));
    await emits(() => service.markCleaned(b1, A));
    await emits(() => service.block(b1, A, 'Broken rail'));
  });
});
