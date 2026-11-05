import * as assert from 'node:assert/strict';
import { describe, test, before, beforeEach, after, afterEach } from 'node:test';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { QueueService } from './queue.service';
import { QueueEvents } from './queue-events';
import { OpdService } from '../opd/opd.service';
import { SettingsService } from '../settings/settings.service';
import { AppointmentEvents, AppointmentSlotFreed, AppointmentStatusChange } from '../appointments/appointment-events';

const responseOf = (error: unknown) => (error as { getResponse(): Record<string, any> }).getResponse();
const statusOf = (error: unknown) => (error as { getStatus(): number }).getStatus();

describe('QueueService doctor-wise tokens', () => {
  let queue: QueueService;
  let docA: string;
  let docB: string;
  const m = () => models();

  const patient = (uhid: string) => m().Patient.create({ uhid, name: `Patient ${uhid}`, phone: '9876543210', gender: 'Male', age: 30 } as any);
  const issueFor = async (uhid: string, doctorId?: string, extra: Record<string, unknown> = {}) => {
    if (!(await m().Patient.exists({ uhid }))) await patient(uhid);
    return queue.issue({ uhid, doctorId, ...extra }, 'Tester');
  };

  before(connectTestDb);
  after(closeTestDb);

  beforeEach(async () => {
    await resetTestDb();
    await m().Department.create({ code: 'general-medicine', name: 'General Medicine', tokenPrefix: 'G', order: 1 } as any);
    const a = await m().OpDoctor.create({ name: 'Dr. A', departmentCode: 'general-medicine', room: 'Room 101', tokenPrefix: 'G', fee: 300 } as any);
    const b = await m().OpDoctor.create({ name: 'Dr. B', departmentCode: 'general-medicine', room: 'Room 102', tokenPrefix: 'G2', fee: 300 } as any);
    docA = String(a._id);
    docB = String(b._id);
    await m().HospitalSettings.create({ queue: { counters: ['Room 101', 'Room 102'] }, reception: { defaultDoctorId: docA } } as any);
    const settings = new SettingsService(m().HospitalSettings);
    const opd = new OpdService(m().Department, m().OpDoctor, settings);
    queue = new QueueService(m().QueueToken, m().QueueSequence, m().Appointment, m().Patient, settings, new QueueEvents(), new AppointmentEvents(), opd);
  });

  test('numbers restart per doctor', async () => {
    const labels = [
      (await issueFor('U1', docA)).token.label,
      (await issueFor('U2', docA)).token.label,
      (await issueFor('U3', docB)).token.label,
    ];
    assert.deepEqual(labels, ['G-001', 'G-002', 'G2-001']);
  });

  test('no doctor given uses the default doctor', async () => {
    const { token } = await issueFor('U1');
    assert.equal(token.label, 'G-001');
    assert.equal(token.doctorName, 'Dr. A');
    assert.equal(token.room, 'Room 101');
    assert.equal(token.department, 'General Medicine');
    assert.equal(token.series, docA);
  });

  test("an inactive doctor's line is joined only when asked to allow it", async () => {
    await m().OpDoctor.updateOne({ _id: docB }, { $set: { active: false } });
    await assert.rejects(issueFor('U1', docB), /not seeing patients/);
    const { token } = await issueFor('U1', docB, { allowInactiveDoctor: true });
    assert.equal(token.label, 'G2-001');
    assert.equal(token.series, docB);
    // Still one active token per patient.
    const again = await issueFor('U1', docA, { allowInactiveDoctor: true });
    assert.equal(again.existing, true);
  });

  test('a patient holding a token gets it back, whichever doctor is asked', async () => {
    const first = await issueFor('U1', docA);
    const again = await issueFor('U1', docB);
    assert.equal(again.existing, true);
    assert.equal(String(again.token._id), String(first.token._id));
  });

  test("call next in Room 102 takes only Dr. B's line", async () => {
    await issueFor('U1', docA);
    await issueFor('U2', docB);
    const { called } = await queue.call('Room 102', 'Tester');
    assert.equal(called?.label, 'G2-001');
  });

  test("position counts only the same doctor's line", async () => {
    await issueFor('U1', docA);
    await issueFor('U2', docA);
    await issueFor('U3', docB);
    const board = await queue.board();
    const pos = Object.fromEntries(board.tokens.map((t: any) => [t.label, t.position]));
    assert.deepEqual(pos, { 'G-001': 1, 'G-002': 2, 'G2-001': 1 });
  });

  test('kioskView counts ahead in the same line only', async () => {
    await issueFor('U1', docA);
    await issueFor('U2', docB);
    const { token } = await issueFor('U3', docB);
    const view = await queue.kioskView(token, false);
    assert.equal(view.ahead, 1);
    assert.equal(view.room, 'Room 102');
    assert.equal(view.doctorName, 'Dr. B');
    assert.equal(view.department, 'General Medicine');
    assert.equal(view.trackCode, token.trackCode);
  });

  test('every token gets a distinct tracking code', async () => {
    const a = (await issueFor('U1', docA)).token.trackCode;
    const b = (await issueFor('U2', docA)).token.trackCode;
    assert.ok(a && b);
    assert.notEqual(a, b);
  });

  test('appointment is checked in only with the default doctor', async () => {
    const appt = (uhid: string) =>
      m().Appointment.create({ uhid, patientName: 'P', date: queue.today(), time: '10:00 AM', status: 'Scheduled', gender: 'Male', age: 30 } as any);
    const other = await appt('U1');
    await issueFor('U1', docB);
    assert.equal((await m().Appointment.findById(other._id))!.status, 'Scheduled');
    const mine = await appt('U2');
    const { token } = await issueFor('U2', docA);
    assert.equal(token.appointmentId, String(mine._id));
    assert.equal((await m().Appointment.findById(mine._id))!.status, 'Checked In');
    const skipped = await appt('U3');
    await issueFor('U3', docA, { skipAppointment: true });
    assert.equal((await m().Appointment.findById(skipped._id))!.status, 'Scheduled');
  });

  test('old date_1_number_1 index is dropped on start', async () => {
    await m().QueueToken.collection.createIndex({ date: 1, number: 1 }, { unique: true });
    const has = async () => (await m().QueueToken.collection.indexes()).some((i) => i.name === 'date_1_number_1');
    assert.equal(await has(), true);
    await queue.onModuleInit();
    assert.equal(await has(), false);
    queue.onModuleDestroy();
  });

  test("activeTokenFor finds today's active token only", async () => {
    assert.equal(await queue.activeTokenFor('U1'), null);
    const { token } = await issueFor('U1', docA);
    assert.equal(String((await queue.activeTokenFor('U1'))!._id), String(token._id));
    await queue.cancel(String(token._id));
    assert.equal(await queue.activeTokenFor('U1'), null);
    assert.equal(String((await queue.tokenById(String(token._id)))!._id), String(token._id));
  });

  test('tokenById: a malformed or unknown id is not found, but a real database error is not hidden', async () => {
    assert.equal(await queue.tokenById('not-an-id'), null);
    assert.equal(await queue.tokenById(String(new Types.ObjectId())), null);
    const failing = new Proxy(m().QueueToken, { get: (model, key, self) => (key === 'findById' ? () => ({ exec: () => Promise.reject(new Error('database down')) }) : Reflect.get(model, key, self)) });
    const settings = new SettingsService(m().HospitalSettings);
    const broken = new QueueService(failing, m().QueueSequence, m().Appointment, m().Patient, settings, new QueueEvents(), new AppointmentEvents(), new OpdService(m().Department, m().OpDoctor, settings));
    await assert.rejects(broken.tokenById(String(new Types.ObjectId())), /database down/);
  });

  test("an appointment whose doctor is gone is refused like an inactive one's; a failing doctor look-up is not hidden", async () => {
    await patient('U1');
    await m().Appointment.create({ uhid: 'U1', patientName: 'Patient U1', age: 30, gender: 'Male', date: queue.today(), time: '10:00 AM', status: 'Scheduled', doctorId: String(new Types.ObjectId()) } as any);
    await assert.rejects(queue.issue({ uhid: 'U1' }, 'Tester'), (e) => {
      assert.equal(responseOf(e).code, 'DOCTOR_INACTIVE');
      assert.match(responseOf(e).message, /^This appointment's doctor is not seeing patients now/);
      return true;
    });
    // With a doctor chosen, the patient is checked in on that doctor's line.
    assert.equal((await queue.issue({ uhid: 'U1', doctorId: docA }, 'Tester')).token.label, 'G-001');
    await patient('U2');
    await m().Appointment.create({ uhid: 'U2', patientName: 'Patient U2', age: 30, gender: 'Male', date: queue.today(), time: '10:15 AM', status: 'Scheduled', doctorId: docB } as any);
    const opd = (queue as unknown as { opd: OpdService }).opd;
    const getDoctor = opd.getDoctor.bind(opd);
    opd.getDoctor = async () => {
      throw new Error('database down');
    };
    try {
      await assert.rejects(queue.issue({ uhid: 'U2' }, 'Tester'), /database down/);
    } finally {
      opd.getDoctor = getDoctor;
    }
  });

  test("waitingCountsBySeries counts each doctor's waiting tokens", async () => {
    await issueFor('U1', docA);
    await issueFor('U2', docA);
    await issueFor('U3', docB);
    const counts = await queue.waitingCountsBySeries();
    assert.equal(counts.get(docA), 2);
    assert.equal(counts.get(docB), 1);
  });

  describe("an appointment's own doctor (Scheduling books each appointment with a doctor)", () => {
    const booked = (uhid: string, doctorId: string, time = '10:00 AM') =>
      m().Appointment.create({ uhid, patientName: 'P', date: queue.today(), time, status: 'Scheduled', gender: 'Male', age: 30, doctorId } as any);

    test("with no doctor asked, the token joins the appointment's doctor's line and checks it in", async () => {
      await patient('U1');
      const appt = await booked('U1', docB);
      const { token } = await queue.issue({ appointmentId: String(appt._id) }, 'Tester');
      assert.equal(token.label, 'G2-001');
      assert.equal(token.series, docB);
      assert.equal(token.appointmentId, String(appt._id));
      assert.equal((await m().Appointment.findById(appt._id))!.status, 'Checked In');
      // A card tap or UHID check-in finds the same line.
      await patient('U2');
      const other = await booked('U2', docB, '10:15 AM');
      const byUhid = await queue.issue({ uhid: 'U2' }, 'Tester');
      assert.equal(byUhid.token.series, docB);
      assert.equal((await m().Appointment.findById(other._id))!.status, 'Checked In');
    });

    test("another doctor's line leaves the appointment alone", async () => {
      const appt = await booked('U1', docB);
      const { token } = await issueFor('U1', docA);
      assert.equal(token.series, docA);
      assert.equal(token.appointmentId, undefined);
      assert.equal((await m().Appointment.findById(appt._id))!.status, 'Scheduled');
    });

    test("an inactive doctor's appointment is refused with DOCTOR_INACTIVE, naming the doctor, unless a doctor is chosen", async () => {
      await patient('U1');
      const appt = await booked('U1', docB);
      await m().OpDoctor.updateOne({ _id: docB }, { $set: { active: false } });
      const inactive = (e: unknown) => {
        assert.equal(statusOf(e), 409);
        assert.equal(responseOf(e).code, 'DOCTOR_INACTIVE');
        assert.equal(responseOf(e).message, 'This appointment is with Dr. B, who is not seeing patients now. Check it in with another doctor on the Token Queue.');
        return true;
      };
      await assert.rejects(queue.issue({ appointmentId: String(appt._id) }, 'Tester'), inactive);
      // A card tap or a UHID check-in finds the same appointment and is refused the same way.
      await assert.rejects(queue.issue({ uhid: 'U1' }, 'Tester'), inactive);
      assert.equal(await m().QueueToken.countDocuments({}), 0);
      assert.equal((await m().Appointment.findById(appt._id))!.status, 'Scheduled');
      // Joining a line without checking the appointment in is not refused.
      const { token } = await queue.issue({ uhid: 'U1', skipAppointment: true }, 'Tester');
      assert.equal(token.series, docA);
      assert.equal(token.appointmentId, undefined);
      assert.equal((await m().Appointment.findById(appt._id))!.status, 'Scheduled');
      // A repeat tap by a patient who now holds a token gets that token back, as any repeat does.
      const again = await queue.issue({ uhid: 'U1' }, 'Tester');
      assert.deepEqual([again.existing, String(again.token._id)], [true, String(token._id)]);
    });

    test("with an active doctor chosen, an inactive doctor's appointment moves to that doctor, slot and all, and is checked in on their line", async () => {
      await patient('U1');
      const date = queue.today();
      const appt = await m().Appointment.create({ uhid: 'U1', patientName: 'P', date, time: '10:00 AM', status: 'Scheduled', gender: 'Male', age: 30, doctorId: docB, doctorName: 'Dr. B', departmentCode: 'general-medicine', slotKey: `${docB}|${date}|10:00 AM` } as any);
      await m().OpDoctor.updateOne({ _id: docB }, { $set: { active: false } });
      const events = (queue as unknown as { appointmentEvents: AppointmentEvents }).appointmentEvents;
      const checkedInWith: (string | undefined)[] = [];
      const freed: AppointmentSlotFreed[] = [];
      const subs = [
        // What Revenue reads when it prices the visit at check-in.
        events.statusChanges$.subscribe((c) => void m().Appointment.findById(c.id).lean().then((a: any) => checkedInWith.push(`${c.status}:${a?.doctorId}`))),
        events.slotFreed$.subscribe((s) => freed.push(s)),
      ];
      try {
        const { token } = await queue.issue({ appointmentId: String(appt._id), doctorId: docA }, 'Tester');
        assert.equal(token.series, docA);
        assert.equal(token.label, 'G-001');
        assert.equal(token.appointmentId, String(appt._id));
        const moved = (await m().Appointment.findById(appt._id).lean()) as any;
        assert.deepEqual(
          [moved.status, moved.doctorId, moved.doctorName, moved.departmentCode, moved.slotKey],
          ['Checked In', docA, 'Dr. A', 'general-medicine', `${docA}|${date}|10:00 AM`],
        );
        await new Promise((r) => setTimeout(r, 50));
        assert.deepEqual(checkedInWith, [`Checked In:${docA}`]);
        // Dr. B's slot is freed for the waitlist, as Scheduling's own move does.
        assert.deepEqual(freed, [{ id: String(appt._id), doctorId: docB, date, time: '10:00 AM' }]);
      } finally {
        subs.forEach((s) => s.unsubscribe());
      }
    });

    test('a chosen doctor who already holds that time still takes the appointment, without a slot', async () => {
      await patient('U1');
      await patient('U2');
      const date = queue.today();
      const appt = await m().Appointment.create({ uhid: 'U1', patientName: 'P', date, time: '10:00 AM', status: 'Scheduled', gender: 'Male', age: 30, doctorId: docB, doctorName: 'Dr. B', slotKey: `${docB}|${date}|10:00 AM` } as any);
      const theirs = await m().Appointment.create({ uhid: 'U2', patientName: 'Q', date, time: '10:00 AM', status: 'Scheduled', gender: 'Male', age: 30, doctorId: docA, doctorName: 'Dr. A', slotKey: `${docA}|${date}|10:00 AM` } as any);
      await m().OpDoctor.updateOne({ _id: docB }, { $set: { active: false } });
      const { token } = await queue.issue({ appointmentId: String(appt._id), doctorId: docA }, 'Tester');
      assert.equal(token.series, docA);
      const moved = (await m().Appointment.findById(appt._id).lean()) as any;
      assert.deepEqual([moved.status, moved.doctorId, moved.slotKey], ['Checked In', docA, undefined]);
      assert.equal(((await m().Appointment.findById(theirs._id).lean()) as any).slotKey, `${docA}|${date}|10:00 AM`);
    });

    test("an inactive chosen doctor (a paid kiosk visit) takes no appointment from another inactive doctor", async () => {
      await patient('U1');
      const appt = await booked('U1', docB);
      const c = await m().OpDoctor.create({ name: 'Dr. C', departmentCode: 'general-medicine', room: 'Room 101', tokenPrefix: 'G3', fee: 300, active: false } as any);
      await m().OpDoctor.updateOne({ _id: docB }, { $set: { active: false } });
      const { token } = await queue.issue({ uhid: 'U1', doctorId: String(c._id), allowInactiveDoctor: true }, 'Tester');
      assert.equal(token.series, String(c._id));
      assert.equal(token.appointmentId, undefined);
      const left = (await m().Appointment.findById(appt._id).lean()) as any;
      assert.deepEqual([left.status, left.doctorId], ['Scheduled', docB]);
    });

    test("with two appointments today, the asked doctor's one is checked in", async () => {
      const first = await booked('U1', docA, '09:00 AM');
      const second = await booked('U1', docB, '11:00 AM');
      const { token } = await issueFor('U1', docB);
      assert.equal(token.appointmentId, String(second._id));
      assert.equal((await m().Appointment.findById(second._id))!.status, 'Checked In');
      assert.equal((await m().Appointment.findById(first._id))!.status, 'Scheduled');
    });
  });

  describe('hospital-wide line (no doctors)', () => {
    beforeEach(async () => {
      await m().OpDoctor.deleteMany({});
    });

    test('concurrent first tokens of the day all succeed with distinct numbers', async () => {
      for (let i = 1; i <= 6; i++) await patient(`W${i}`);
      const issued = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => queue.issue({ uhid: `W${i}` }, 'Tester')));
      const numbers = issued.map((r) => r.token.number).sort((a, b) => a - b);
      assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6]);
    });

    test('label stays the old prefix+number with series empty', async () => {
      const { token } = await issueFor('W1');
      const prefix = (await queue.queueSettings()).tokenPrefix;
      assert.equal(token.label, `${prefix}1`);
      assert.equal(token.series, '');
    });

    test('an old sequence doc without series continues after start', async () => {
      await m().QueueSequence.collection.insertOne({ date: queue.today(), last: 7 });
      await queue.onModuleInit();
      queue.onModuleDestroy();
      const { token } = await issueFor('W1');
      assert.equal(token.number, 8);
    });
  });
});

describe('QueueService tells the appointment events about status changes it makes', () => {
  const m = models();
  let queue: QueueService;
  let changes: AppointmentStatusChange[];
  let appointmentId: string;

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  afterEach(() => queue.onModuleDestroy());
  beforeEach(async () => {
    await resetTestDb();
    await m.HospitalSettings.create({ queue: { counters: ['Room 101'] } });
    const appointmentEvents = new AppointmentEvents();
    const settings = new SettingsService(m.HospitalSettings);
    const opd = new OpdService(m.Department, m.OpDoctor, settings);
    queue = new QueueService(m.QueueToken, m.QueueSequence, m.Appointment, m.Patient, settings, new QueueEvents(), appointmentEvents, opd);
    await queue.onModuleInit();
    changes = [];
    appointmentEvents.statusChanges$.subscribe((c) => changes.push(c));
    const apt = await m.Appointment.create({ uhid: 'U1', patientName: 'Patient One', age: 40, gender: 'Male', date: queue.today(), time: '10:00 AM', status: 'Scheduled' });
    appointmentId = String(apt._id);
  });

  test('a queue check-in emits statusChanged Checked In, exactly once', async () => {
    await queue.issue({ appointmentId }, 'desk');
    await new Promise((r) => setTimeout(r, 50)); // lets the queue's own subscriber run: it must not sync again
    assert.deepEqual(changes, [{ id: appointmentId, status: 'Checked In' }]);
    assert.equal(((await m.Appointment.findById(appointmentId).lean()) as any).status, 'Checked In');
  });

  test('a repeat check-in changes nothing, so it emits nothing', async () => {
    await queue.issue({ appointmentId }, 'desk');
    await queue.issue({ appointmentId }, 'desk');
    assert.equal(changes.length, 1);
  });

  test('skip back to Checked In emits it', async () => {
    const { token } = await queue.issue({ appointmentId }, 'desk');
    const { called } = await queue.call('Room 101', 'doc');
    assert.equal(String(called!._id), String(token._id));
    await queue.skip(String(token._id));
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(changes.map((c) => c.status), ['Checked In', 'In Consultation', 'Checked In']);
  });
});
