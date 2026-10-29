import * as assert from 'node:assert/strict';
import { describe, test, before, beforeEach, after } from 'node:test';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { QueueService } from './queue.service';
import { QueueEvents } from './queue-events';
import { OpdService } from '../opd/opd.service';
import { SettingsService } from '../settings/settings.service';
import { AppointmentEvents } from '../appointments/appointment-events';

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

  test("waitingCountsBySeries counts each doctor's waiting tokens", async () => {
    await issueFor('U1', docA);
    await issueFor('U2', docA);
    await issueFor('U3', docB);
    const counts = await queue.waitingCountsBySeries();
    assert.equal(counts.get(docA), 2);
    assert.equal(counts.get(docB), 1);
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
