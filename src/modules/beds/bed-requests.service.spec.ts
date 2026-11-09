import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { clinicNow } from '../../common/utils/clinic-time';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { PatientsService } from '../patients/patients.service';
import { UserRole } from '../users/schemas/user.schema';
import { Actor } from './actor';
import { BedAlerts } from './bed-alerts';
import { BedEvents, BedRequestEvent } from './bed-events';
import { BedRequestsService, CreateBedRequestInput } from './bed-requests.service';
import { BedsService } from './beds.service';

const DOCTOR: Actor = { id: 'user-d', name: 'Dr. Shajin', role: UserRole.DOCTOR };

describe('BedRequestsService', () => {
  const { Ward, Bed, Admission, Patient, BedRequest, TaskAlertItem, DischargeOrder } = models();
  let service: BedRequestsService;
  let events: BedEvents;
  let seen: BedRequestEvent[];
  let patientId: string;
  let icuBedId: string;

  const input = (over: Partial<CreateBedRequestInput> = {}): CreateBedRequestInput => ({
    type: 'admission', patientId, roomClass: 'general', needs: [], notes: 'Fever', department: 'General Medicine',
    doctor: 'Dr. Shajin', expectedStayDays: 3, priority: 'medium', ...over,
  });
  const newPatient = async (n: number) =>
    String((await Patient.create({ uhid: `MHK20260010${n}`, name: `Patient ${n}`, age: 40, gender: 'Female', phone: `900000010${n}` }))._id);
  const alerts = () => TaskAlertItem.find({ link: /^bed-request:/ }).lean().exec();

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
    const icu = await Ward.create({
      code: 'ICU', name: 'ICU', shortName: 'ICU', floor: 0, type: 'icu', gender: 'any', ratePerDay: 7500, nearDepartments: [], sortOrder: 0,
    });
    icuBedId = String((await Bed.create({ ward: icu._id, label: 'ICU • Bed 1', number: 1, features: [], state: 'occupied' }))._id);
    patientId = await newPatient(1);
    events = new BedEvents();
    seen = [];
    events.requests$.subscribe((e) => seen.push(e));
    const patients = new PatientsService(Patient);
    const beds = new BedsService(Ward, Bed, Admission, patients, events, DischargeOrder);
    service = new BedRequestsService(BedRequest, patients, beds, new BedAlerts(TaskAlertItem), events);
  });

  const admitInIcu = async (pid: string) => {
    const admission = await Admission.create({
      patient: pid, patientUhid: 'U', patientName: 'N', bed: icuBedId, roomClass: 'icu', expectedStayDays: 2, admittedAt: new Date(), admittedBy: 'x',
    });
    await Bed.updateOne({ _id: icuBedId }, { admission: admission._id });
    return admission;
  };

  test('create stores a searching request and emits a request event', async () => {
    const req = await service.create(DOCTOR, input({ priority: 'high' }));
    assert.equal(req.state, 'searching');
    assert.equal(req.open, true);
    assert.equal(req.attempts, 0);
    assert.equal(req.priorityRank, 1);
    assert.equal(req.patientName, 'Patient 1');
    assert.equal(req.requestedByName, 'Dr. Shajin');
    assert.equal(req.stateReason, 'Bed Agent is looking for a bed.');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].id, String(req._id));
    assert.equal(seen[0].state, 'searching');
  });

  test('create refuses a patient who is already admitted', async () => {
    await admitInIcu(patientId);
    await assert.rejects(service.create(DOCTOR, input()), (e: any) => e instanceof ConflictException && e.message === 'This patient is already admitted.');
    assert.equal(await BedRequest.countDocuments(), 0);
  });

  test('transfer needs an admitted patient in the bed', async () => {
    await assert.rejects(
      service.create(DOCTOR, input({ type: 'transfer', fromBedId: icuBedId })),
      (e: any) => e instanceof ConflictException && e.message === 'This bed has no admitted patient.',
    );
  });

  test('create refuses a second open request for the same patient', async () => {
    await service.create(DOCTOR, input());
    await assert.rejects(
      service.create(DOCTOR, input()),
      (e: any) => e instanceof ConflictException && e.message === 'This patient already has an open bed request.',
    );
    assert.equal(await BedRequest.countDocuments(), 1);
  });

  test('a patient may have a new request after the last one closed', async () => {
    const first = await service.create(DOCTOR, input());
    await service.cancel(DOCTOR, String(first._id));
    const second = await service.create(DOCTOR, input());
    assert.equal(second.open, true);
    assert.equal(await BedRequest.countDocuments(), 2);
    await assert.rejects(service.cancel(DOCTOR, String(first._id)), (e: any) => e.message === 'This request is already closed.');
  });

  test('waiting raises one alert and assigned resolves it', async () => {
    const req = await service.create(DOCTOR, input());
    const id = String(req._id);
    await service.toState(id, 'waiting', 'No general bed is free.');
    await service.toState(id, 'waiting', 'Still no general bed.');
    let found = await alerts();
    assert.equal(found.length, 1);
    assert.equal(found[0].title, 'No bed for Patient 1 (MHK202600101)');
    assert.equal(found[0].subtitle, 'Still no general bed.');
    assert.equal(found[0].category, 'Critical');
    assert.equal(found[0].status, 'Pending');
    assert.equal(found[0].link, `bed-request:${id}`);
    await service.toState(id, 'attention', 'The agent hit a problem.');
    found = await alerts();
    assert.equal(found.length, 1);
    assert.equal(found[0].title, 'Bed request needs attention: Patient 1 (MHK202600101)');
    const done = await service.toState(id, 'assigned', 'Placed.', { assignedBedLabel: 'Ward A • Bed 1' });
    assert.equal(done?.open, false);
    assert.equal((await alerts())[0].status, 'Completed');
    assert.equal(seen.at(-1)?.bedLabel, 'Ward A • Bed 1');
  });

  test('claim lets only one caller hold a request; an expired lock can be claimed again', async () => {
    const id = String((await service.create(DOCTOR, input()))._id);
    const results = await Promise.all([service.claim(id), service.claim(id)]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await service.claim(id), null);
    await BedRequest.updateOne({ _id: id }, { lockedUntil: new Date(Date.now() - 1000) });
    assert.ok(await service.claim(id));
    await service.release(id);
    assert.ok(await service.claim(id));
  });

  test('waiting() orders by priority, then oldest', async () => {
    const mk = async (n: number, priority: CreateBedRequestInput['priority']) => {
      const r = await service.create(DOCTOR, input({ patientId: await newPatient(n), priority }));
      await service.toState(String(r._id), 'waiting', 'No bed.');
      return String(r._id);
    };
    const low = await mk(2, 'low');
    const first = await mk(3, 'critical');
    const second = await mk(4, 'critical');
    const ids = (await service.waiting()).map((r) => String(r._id));
    assert.deepEqual(ids, [first, second, low]);
  });

  test('list filters step-downs', async () => {
    const stepDownPatient = await newPatient(5);
    await admitInIcu(stepDownPatient);
    const down = await service.create(DOCTOR, input({ type: 'transfer', patientId: stepDownPatient, fromBedId: icuBedId, roomClass: 'general' }));
    await service.create(DOCTOR, input());
    const rows = await service.list({ type: 'step-down' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, String(down._id));
    assert.equal(rows[0].stepDown, true);
    assert.equal('notes' in rows[0], false);
    assert.deepEqual(rows[0].resolvedNeeds, []);
    assert.equal((await service.get(rows[0].id)).notes, 'Fever');
    assert.equal((await service.list({})).length, 2);
    assert.equal((await service.list({ type: 'admission' })).length, 1);
    assert.equal((await service.list({ state: 'waiting' })).length, 0);
  });

  test('toState keeps stateSince while the state stays the same', async () => {
    const id = String((await service.create(DOCTOR, input()))._id);
    const pause = () => new Promise((resolve) => setTimeout(resolve, 10));
    const waiting = await service.toState(id, 'waiting', 'No bed.');
    await pause();
    // A reason-only change updates the reason and the alert, not when the state began.
    const reworded = await service.toState(id, 'waiting', '$5 deposit pending.', { attempts: 1 });
    assert.equal(reworded.stateSince.getTime(), waiting.stateSince.getTime());
    assert.equal(reworded.stateReason, '$5 deposit pending.');
    assert.equal(reworded.attempts, 1);
    assert.equal((await alerts())[0].subtitle, '$5 deposit pending.');
    await pause();
    const attention = await service.toState(id, 'attention', 'A doctor must decide.');
    assert.ok(attention.stateSince.getTime() > reworded.stateSince.getTime());
  });

  test('two concurrent moves to waiting leave exactly one alert', async () => {
    const id = String((await service.create(DOCTOR, input()))._id);
    await Promise.all([service.toState(id, 'waiting', 'No bed.'), service.toState(id, 'waiting', 'No bed.')]);
    assert.equal((await alerts()).length, 1);
  });

  test('toState onlyIfOpen does nothing to a cancelled request', async () => {
    const id = String((await service.create(DOCTOR, input()))._id);
    await service.cancel(DOCTOR, id);
    const before = seen.length;
    assert.equal(await service.toState(id, 'waiting', 'No bed.', {}, { onlyIfOpen: true }), null);
    assert.equal((await service.get(id)).state, 'cancelled');
    assert.equal((await alerts()).filter((a) => a.status === 'Pending').length, 0);
    assert.equal(seen.length, before);
  });

  test('cancel resolves the request\'s alert and records who cancelled', async () => {
    const id = String((await service.create(DOCTOR, input()))._id);
    await service.toState(id, 'waiting', 'No bed.');
    const done = await service.cancel(DOCTOR, id);
    assert.equal(done.closedByName, 'Dr. Shajin');
    assert.equal((await alerts())[0].status, 'Completed');
    assert.equal(seen.at(-1)?.state, 'cancelled');
  });

  test('cancel refuses while the agent holds the lock', async () => {
    const id = String((await service.create(DOCTOR, input()))._id);
    await service.claim(id);
    await assert.rejects(
      service.cancel(DOCTOR, id),
      (e: any) => e instanceof ConflictException && e.message === 'The Bed Agent is placing this patient right now. Try again in a moment.',
    );
    await service.release(id);
    assert.equal((await service.cancel(DOCTOR, id)).state, 'cancelled');
  });

  describe('checkHandAssign', () => {
    test('checkHandAssign accepts the matching open request', async () => {
      const id = String((await service.create(DOCTOR, input()))._id);
      await service.checkHandAssign(id, { patientId, type: 'admission' });
    });

    test('checkHandAssign refuses an unknown request', async () => {
      await assert.rejects(
        service.checkHandAssign('6ae0b6c6c1d50aee80a67731', { patientId, type: 'admission' }),
        (e: any) => e instanceof NotFoundException && e.message === 'Bed request not found.',
      );
    });

    test('checkHandAssign refuses a closed request', async () => {
      const id = String((await service.create(DOCTOR, input()))._id);
      await service.cancel(DOCTOR, id);
      await assert.rejects(
        service.checkHandAssign(id, { patientId, type: 'admission' }),
        (e: any) => e instanceof ConflictException && e.message === 'This request is already closed.',
      );
    });

    test("checkHandAssign refuses another patient's request or a transfer from another bed", async () => {
      const other = await newPatient(2);
      const id = String((await service.create(DOCTOR, input()))._id);
      const wrong = (e: any) => e instanceof BadRequestException && e.message === 'This bed request is for another patient or bed.';
      await assert.rejects(service.checkHandAssign(id, { patientId: other, type: 'admission' }), wrong);
      await assert.rejects(service.checkHandAssign(id, { patientId, type: 'transfer', fromBedId: icuBedId }), wrong);

      await admitInIcu(other);
      const tid = String((await service.create(DOCTOR, input({ type: 'transfer', patientId: other, fromBedId: icuBedId })))._id);
      await service.checkHandAssign(tid, { patientId: other, type: 'transfer', fromBedId: icuBedId });
      await assert.rejects(service.checkHandAssign(tid, { patientId: other, type: 'transfer', fromBedId: '6ae0b6c6c1d50aee80a67731' }), wrong);
    });
  });

  test('leaving-soon lists an occupied leaving bed that passes the rules, never a wrong-gender ward, and nothing for a non-waiting request', async () => {
    const now = clinicNow();
    const inHours = (h: number) => new Date(now.getTime() + h * 3_600_000);
    const ward = (code: string, name: string, shortName: string, gender: string, sortOrder: number) =>
      Ward.create({ code, name, shortName, floor: 1, type: 'general', gender, ratePerDay: 800, nearDepartments: [], sortOrder });
    const men = await ward('GWA', 'General ward A (men)', 'Ward A', 'male', 1);
    const women = await ward('GWB', 'General ward B (women)', 'Ward B', 'female', 2);
    /** An occupied bed with a real stay; `order` gives the stay a discharge order. */
    const occupied = async (w: { _id: unknown; shortName: string }, n: number, gender: string, order?: { state: string; hours: number }) => {
      const bed = await Bed.create({ ward: w._id, label: `${w.shortName} • Bed ${n}`, number: n, features: [], state: 'occupied', occupantGender: gender });
      const admission = await Admission.create({
        patient: new Types.ObjectId(), patientUhid: `U${n}`, patientName: `In ${n}`, bed: bed._id, roomClass: 'general', expectedStayDays: 3,
        admittedAt: now, admittedBy: 'x',
      });
      await Bed.updateOne({ _id: bed._id }, { admission: admission._id }).exec();
      if (order) {
        await DischargeOrder.create({
          plan: new Types.ObjectId(), admission: admission._id, patient: admission.patient, kind: 'home', state: order.state,
          plannedLeaveAt: inHours(order.hours), windowAt: now, diagnosis: 'x', orderedBy: { id: 'u', name: 'Dr. X' }, orderedAt: now,
        });
      }
      return String(bed._id);
    };
    await occupied(men, 1, 'Male', { state: 'ordered', hours: 1 }); // the soonest, but a men's ward
    const later = await occupied(women, 1, 'Female', { state: 'ordered', hours: 3 });
    const sooner = await occupied(women, 2, 'Female', { state: 'ready', hours: 2 });
    await occupied(women, 3, 'Female'); // no order: staying
    await occupied(women, 4, 'Female', { state: 'cancelled', hours: 1 }); // order cancelled: staying
    await occupied(women, 5, 'Female', { state: 'left', hours: 1 });

    const id = String((await service.create(DOCTOR, input()))._id); // a woman, general ward
    assert.deepEqual(await service.leavingSoon(id), []); // still searching
    await service.toState(id, 'waiting', 'No general bed is free.');
    const wardB = 'General ward B (women)';
    assert.deepEqual(await service.leavingSoon(id), [
      { bedId: sooner, bedLabel: 'Ward B • Bed 2', wardName: wardB, plannedAt: inHours(2).toISOString() },
      { bedId: later, bedLabel: 'Ward B • Bed 1', wardName: wardB, plannedAt: inHours(3).toISOString() },
    ]);
    // Never held: every bed is as it was.
    assert.equal(await Bed.countDocuments({ state: 'occupied' }), 7);
    assert.equal(await Bed.countDocuments({ holdBy: { $exists: true } }), 0);

    await service.toState(id, 'attention', 'Confirm isolation.');
    assert.deepEqual(await service.leavingSoon(id), []);
    await assert.rejects(service.leavingSoon(new Types.ObjectId().toString()), (e: any) => e instanceof NotFoundException);
  });
});
