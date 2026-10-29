import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { hourOf } from '../common/utils/series';
import { AgentRegistry } from '../modules/coordinator/agent-registry';
import { CoordinatorEvents } from '../modules/coordinator/coordinator-events';
import { MessagesService } from '../modules/coordinator/messages.service';
import { LabReportsService } from '../modules/lab-reports/lab-reports.service';
import { LabOrdersService } from '../modules/lab/lab-orders.service';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../test/test-db';
import { seedBeds } from './seed-beds';
import { seedCoordinator } from './seed-coordinator';
import { seedEr } from './seed-er';
import { LAB_DEMO_ACCOUNTS, seedLab } from './seed-lab';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAY = '2026-09-26';

describe('seedLab', () => {
  const m = models();
  let log: string[] = [];
  let seededAt = 0;
  const ids: Record<string, string> = {};

  /** Quiet console while seeding; returns what was logged. */
  const quiet = async (work: () => Promise<void>): Promise<string[]> => {
    const lines: string[] = [];
    const real = console.log;
    console.log = (...a: unknown[]) => {
      lines.push(a.join(' '));
    };
    try {
      await work();
    } finally {
      console.log = real;
    }
    return lines;
  };

  before(async () => {
    await connectTestDb();
    await resetTestDb();
    await m.Patient.create([
      { uhid: 'MHK202500325', name: 'David Raj', age: 45, gender: 'Male', phone: '9000000325' },
      { uhid: 'MHK202500327', name: 'James Wilson', age: 62, gender: 'Male', phone: '9000000327' },
      { uhid: 'MHK202500401', name: 'Priya Natarajan', age: 34, gender: 'Female', phone: '9000000401' },
      { uhid: 'MHK202500402', name: 'Suresh Kandasamy', age: 58, gender: 'Male', phone: '9000000402' },
      { uhid: 'MHK202500403', name: 'Meena Bhaskar', age: 29, gender: 'Female', phone: '9000000403', department: 'Obstetrics' },
      { uhid: 'MHK202500404', name: 'Anwar Hussain', age: 71, gender: 'Male', phone: '9000000404' },
    ]);
    await m.User.create({ email: 'admin@medios.ai', passwordHash: 'x', name: 'Hospital Admin', role: 'admin' });
    await m.User.create({ email: 'nurse@medios.ai', passwordHash: 'x', name: 'Demo Nurse', role: 'nurse' });
    for (const [key, email, name, role] of [
      ['doctor', 'doctor@medios.ai', 'Dr. Shajin', 'doctor'],
      ['lab', 'lab@medios.ai', 'Vishnu Prasad', 'lab'],
    ] as const) ids[key] = String((await m.User.create({ email, passwordHash: 'x', name, role }))._id);
    const path = LAB_DEMO_ACCOUNTS[0];
    ids.pathologist = String((await m.User.create({ email: path.email, passwordHash: 'x', name: path.name, role: path.role, department: path.department }))._id);
    await quiet(async () => {
      await seedBeds(DAY);
      await seedCoordinator(DAY);
      await seedEr(DAY);
    });
    // Demo patients with no open case: the OPD requests open cases for them.
    await m.Patient.create(
      Array.from({ length: 9 }, (_, i) => ({ uhid: `MHK2025005${String(10 + i)}`, name: `Opd Patient ${String.fromCharCode(65 + i)}${String.fromCharCode(97 + i)}x`, age: 30 + i, gender: i % 2 ? 'Female' : 'Male', phone: `900000${String(600 + i)}` })),
    );
    seededAt = Date.now();
    log = await quiet(() => seedLab(DAY));
  });

  after(async () => {
    await closeTestDb();
  });

  test('seeded lines cover every status and all three locations', async () => {
    const requests = await m.LabRequest.find().lean<any[]>().exec();
    assert.ok(requests.length >= 28 && requests.length <= 32, `${requests.length} requests`);
    const lines = await m.LabLine.find().lean<any[]>().exec();
    const samples = await m.LabSample.find().lean<any[]>().exec();
    const statuses = new Set(lines.map((l) => l.status));
    for (const s of ['ordered', 'collected', 'received', 'awaiting-validation', 'released', 'cancelled']) assert.ok(statuses.has(s), `no ${s} line`);
    const sampleStatuses = new Set(samples.map((s) => s.status));
    for (const s of ['waiting', 'collected', 'received', 'rejected', 'cancelled']) assert.ok(sampleStatuses.has(s), `no ${s} sample`);
    // Requests are in every state: some finished, some not, one with every line cancelled.
    assert.ok(requests.some((r) => r.doneAt) && requests.some((r) => !r.doneAt));
    assert.ok(requests.some((r) => lines.filter((l) => String(l.request) === String(r._id)).every((l) => l.status === 'cancelled')));

    // Two rejected samples, each with its recollection.
    const rejected = samples.filter((s) => s.status === 'rejected');
    assert.equal(rejected.length, 2);
    for (const s of rejected) assert.ok(samples.some((x) => String(x.replaces) === String(s._id)), 'recollection');

    // All three locations, matching the cases' kinds.
    const locations = await m.LabLocation.find().lean<any[]>().exec();
    assert.deepEqual([...new Set(locations.map((l) => l.area))].sort(), ['ER', 'OPD', 'Ward']);
    for (const l of locations.filter((x) => x.area === 'Ward')) assert.ok(l.ward, 'a ward name');
    const kind = { ER: 'er', Ward: 'ipd', OPD: 'opd' } as const;
    for (const l of locations) assert.equal((await m.Case.findById(l.case).lean<any>().exec())!.kind, kind[l.area as 'ER']);
    for (const r of requests) assert.ok(locations.some((l) => String(l.case) === String(r.case)), `${r.number} has a location`);
    assert.equal(new Set(requests.map((r) => r.number)).size, requests.length);
    assert.equal((await m.CoordinatorCounter.findOne({ key: 'lab-request' }).lean<any>().exec())!.last, requests.length);

    // ER requests sit on open ER cases.
    for (const l of locations.filter((x) => x.area === 'ER')) assert.equal((await m.Case.findById(l.case).lean<any>().exec())!.state, 'open');

    // The two-person rule, and every other bookkeeping flag the state implies.
    for (const l of lines.filter((x) => x.enteredBy)) {
      assert.equal(l.enteredBy.id, ids.lab);
      if (l.validatedBy) assert.equal(l.validatedBy.id, ids.pathologist);
    }
    for (const l of lines.filter((x) => x.status === 'released')) {
      assert.ok(l.releasedRealAt instanceof Date && l.lastReleasedRealAt instanceof Date && l.reportId);
      assert.ok(l.validatedBy && l.version >= 1 && l.history.length === l.version);
    }
    for (const r of requests) {
      assert.ok(r.announcedAt instanceof Date, `${r.number} announcedAt`);
      const mine = lines.filter((l) => String(l.request) === String(r._id));
      const closed = mine.every((l) => l.status === 'released' || l.status === 'cancelled');
      assert.equal(!!r.doneAt, closed, `${r.number} doneAt`);
      assert.equal(!!r.firstReceivedAt, samples.some((s) => String(s.request) === String(r._id) && s.received));
    }
    for (const s of samples.filter((x) => x.collected)) assert.ok(s.collectedRealAt instanceof Date);

    // One amendment, in history.
    assert.ok(lines.some((l) => l.version === 2 && l.history[1].amendReason));

    assert.match(log.join('\n'), new RegExp(`✅ ${requests.length} lab requests, ${samples.length} samples, 3 critical, 168 snapshots`));
  });

  test('the unacknowledged critical has a running clock and one alert', async () => {
    const criticals = (await m.LabLine.find({ 'critical.active': true }).lean<any[]>().exec());
    assert.equal(criticals.length, 3);
    const open = criticals.filter((l) => !l.critical.ackAt);
    assert.equal(open.length, 1);
    assert.equal(open[0].status, 'released');

    const clocks = await m.Clock.find({ def: 'lab-critical' }).lean<any[]>().exec();
    assert.equal(clocks.length, 3);
    const running = clocks.filter((c) => c.state === 'running');
    assert.equal(running.length, 1);
    assert.equal(running[0].ref, String(open[0]._id));
    const inMin = (running[0].dueAt.getTime() - seededAt) / MINUTE;
    assert.ok(inMin > 8 && inMin < 12, `due in ${inMin} min`);
    assert.ok(running[0].startedAt.getTime() <= seededAt);
    // The detail its escalation would show: request number and test, as the live clock stores it.
    const openReq: any = await m.LabRequest.findById(open[0].request).lean().exec();
    assert.equal(running[0].detail, `${openReq.number} · Electrolytes · Potassium`);
    for (const c of clocks.filter((x) => x.state !== 'running')) {
      assert.equal(c.state, 'met');
      assert.ok(c.stoppedAt);
    }

    const alerts = await m.TaskAlertItem.find({ type: 'Lab Alert' }).lean<any[]>().exec();
    assert.equal(alerts.length, 3);
    for (const a of alerts) {
      assert.equal(a.category, 'Critical');
      assert.match(a.link, /^lab-line:[0-9a-f]{24}$/);
    }
    const alertOf = (l: any) => alerts.filter((a) => a.link === `lab-line:${l._id}`);
    assert.equal(alertOf(open[0]).length, 1);
    assert.equal(alertOf(open[0])[0].status, 'Pending');
    for (const l of criticals.filter((x) => x.critical.ackAt)) {
      assert.equal(alertOf(l).length, 1);
      assert.equal(alertOf(l)[0].status, 'Completed');
      assert.equal(l.critical.ackById, ids.doctor);
    }
    // The messages the services would have sent for each critical.
    for (const l of criticals) {
      assert.equal(await m.AgentMessage.countDocuments({ type: 'lab.critical', 'payload.lineId': String(l._id) }).exec(), 1);
      assert.equal(await m.AgentMessage.countDocuments({ type: 'lab.critical-acked', 'payload.lineId': String(l._id) }).exec(), l.critical.ackAt ? 1 : 0);
    }
    // No lab escalation is open: nothing is overdue.
    assert.equal(await m.Escalation.countDocuments({ ladder: { $in: ['lab', 'lab-critical'] } }).exec(), 0);
  });

  test('every open request\'s expected clock is running, and nothing else is', async () => {
    const requests = await m.LabRequest.find().lean<any[]>().exec();
    const samples = await m.LabSample.find().lean<any[]>().exec();
    const clocks = await m.Clock.find({ def: { $in: ['lab-collect', 'lab-recollect', 'lab-tat'] } }).lean<any[]>().exec();
    const lines = await m.LabLine.find().lean<any[]>().exec();
    let checked = 0;
    for (const r of requests) {
      const mine = samples.filter((s) => String(s.request) === String(r._id));
      const own = clocks.filter((c) => c.ref === String(r._id));
      const state = (def: string) => own.find((c) => c.def === def)?.state;
      if (r.doneAt) {
        assert.ok(own.every((c) => c.state === 'met' && c.stoppedAt), `${r.number} has a clock still running`);
        continue;
      }
      checked++;
      const waitingOriginal = mine.some((s) => s.status === 'waiting' && !s.replaces);
      const waitingAgain = mine.some((s) => s.status === 'waiting' && s.replaces);
      assert.equal(state('lab-collect'), waitingOriginal ? 'running' : 'met', `${r.number} lab-collect`);
      assert.equal(state('lab-recollect') === 'running', waitingAgain, `${r.number} lab-recollect`);
      assert.equal(state('lab-tat'), r.firstReceivedAt ? 'running' : undefined, `${r.number} lab-tat`);
      for (const c of own.filter((x) => x.state === 'running')) {
        assert.ok(c.dueAt.getTime() > seededAt, `${r.number} ${c.def} is overdue`);
        assert.equal(String(c.case), String(r.case));
      }
      if (r.firstReceivedAt) {
        const due = Math.min(...lines.filter((l) => String(l.request) === String(r._id) && l.status !== 'released' && l.status !== 'cancelled').map((l) => l.tatDueAt.getTime()));
        assert.equal(own.find((c) => c.def === 'lab-tat')!.dueAt.getTime(), due, `${r.number} lab-tat due`);
      }
    }
    assert.ok(checked >= 15);
    // A request that cancelled before any sample was collected has no collect clock running either.
    assert.equal(clocks.filter((c) => c.state === 'running').length, clocks.filter((c) => c.state === 'running' && c.dueAt.getTime() > seededAt).length);
  });

  test('the duty holders are set, and the pathologist signs in as a lab user', async () => {
    const t = await m.DutyTitle.find({ key: { $in: ['lab-in-charge', 'duty-doctor'] } }).lean<any[]>().exec();
    const holders = (k: string) => t.find((x) => x.key === k)!.holders.map(String);
    assert.deepEqual(holders('lab-in-charge'), [ids.lab]);
    assert.deepEqual(holders('duty-doctor'), [ids.doctor]);

    assert.deepEqual(LAB_DEMO_ACCOUNTS, [{ email: 'pathologist@medios.ai', name: 'Dr. Meera Nair', department: 'Laboratory', role: 'lab' }]);
    const u = (await m.User.findOne({ email: 'pathologist@medios.ai' }).lean<any>().exec())!;
    assert.equal(u.role, 'lab');
    assert.equal(u.name, 'Dr. Meera Nair');
    // The main seed creates the account from the same list.
    const source = readFileSync(join(__dirname, 'seed.ts'), 'utf8');
    assert.match(source, /\.\.\.LAB_DEMO_ACCOUNTS/);
    assert.match(source, /await seedLab\(/);
    assert.ok(source.indexOf('await seedEr(') < source.indexOf('await seedLab('));
  });

  test('seeded released lines appear in the lab reports for their UHID', async () => {
    const service = new LabReportsService(m.LabTestReport);
    const released = await m.LabLine.find({ status: 'released' }).lean<any[]>().exec();
    assert.ok(released.length >= 15);
    const requests = new Map((await m.LabRequest.find().lean<any[]>().exec()).map((r) => [String(r._id), r]));
    for (const l of released) {
      const uhid = requests.get(String(l.request))!.patientUhid;
      const reports = (await service.findAll({ uhid })) as any[];
      const mine = reports.find((r) => String(r._id) === String(l.reportId));
      assert.ok(mine, `no report for ${uhid} ${l.test}`);
      assert.equal(mine.labLine, String(l._id));
      assert.equal(mine.amended, l.version > 1);
    }
    // The main seed's own fixture reports are untouched: lab reports with no line are never wiped.
    assert.equal(await m.LabTestReport.countDocuments({ labLine: { $exists: true } }).exec(), released.length);
  });

  test('a rerun replaces the lab data and leaves other lab reports alone', async () => {
    await m.LabTestReport.create({ uhid: 'MHK202500321', testName: 'Fixture report', category: 'Blood', status: 'Completed', groups: [] });
    const before = await m.Case.countDocuments().exec();
    await quiet(() => seedLab(DAY));
    assert.equal(await m.Case.countDocuments().exec(), before);
    assert.equal(await m.LabTestReport.countDocuments({ testName: 'Fixture report' }).exec(), 1);
    assert.equal(await m.LabRequest.countDocuments().exec(), (await m.LabRequest.distinct('number').exec()).length);
    assert.equal(await m.TaskAlertItem.countDocuments({ type: 'Lab Alert' }).exec(), 3);
    await m.LabTestReport.deleteMany({ testName: 'Fixture report' });
  });

  test('the sepsis visit has a collected blood culture and its cultures step done', async () => {
    const visit = (await m.ErVisit.find().lean<any[]>().exec()).find((v) => v.status !== 'left' && v.pathways.some((p: any) => p.key === 'sepsis'))!;
    assert.ok(visit);
    const step = visit.steps.find((s: any) => s.key === 'cultures');
    assert.ok(step?.doneAt, 'cultures step done');
    const request = (await m.LabRequest.findOne({ case: visit.case }).lean<any>().exec())!;
    const line = (await m.LabLine.findOne({ request: request._id, test: 'blood-culture' }).lean<any>().exec())!;
    const sample = (await m.LabSample.findOne({ lines: line._id }).lean<any>().exec())!;
    assert.ok(['collected', 'received'].includes(sample.status));
    assert.equal(sample.tube, 'culture');
    assert.equal((await m.LabLocation.findOne({ case: visit.case }).lean<any>().exec())!.area, 'ER');
  });

  test('no patient name in any seeded lab message', async () => {
    const names = (await m.Patient.find().lean<any[]>().exec()).map((p) => p.name);
    const labCases = (await m.LabRequest.find().select('case').lean<any[]>().exec()).map((r) => r.case);
    const msgs = await m.AgentMessage.find({ $or: [{ from: 'lab' }, { case: { $in: labCases }, from: 'coordinator' }] }).lean<any[]>().exec();
    assert.ok(msgs.filter((x) => x.from === 'lab').length > 100);
    for (const msg of msgs) {
      const text = `${msg.summary} ${JSON.stringify(msg.payload)}`;
      for (const n of names) assert.ok(!text.includes(n), `"${n}" in ${msg.type}`);
      assert.ok(msg.summary.length <= 140);
    }
    // Each message names the request.
    for (const msg of msgs.filter((x) => x.from === 'lab')) assert.match(msg.summary, /^LR-\d{4}/);
  });

  test('every seeded lab message carries the payload its type declares, and every lab clock has a detail', async () => {
    const { LAB_CLOCKS } = await import('../modules/lab/lab-coordinator.registration');
    const { validatePayload } = await import('../modules/coordinator/coordinator-types');
    const registry = new AgentRegistry();
    const { LabCoordinatorRegistration } = await import('../modules/lab/lab-coordinator.registration');
    new LabCoordinatorRegistration(registry, null as any, null as any, m.LabRequest, m.LabLine).onModuleInit();
    for (const msg of await m.AgentMessage.find({ from: 'lab' }).lean<any[]>().exec()) {
      const def = registry.messageType(msg.type)!;
      assert.deepEqual(validatePayload(def, msg.payload), [], `${msg.type} ${msg.summary}`);
    }
    const clocks = await m.Clock.find({ def: { $in: LAB_CLOCKS.map((c) => c.key) } }).lean<any[]>().exec();
    assert.ok(clocks.length > 0);
    for (const c of clocks) assert.match(c.detail ?? '', /^LR-\d{4} · /, `${c.def} detail`);
  });

  test('reconcile finds nothing to send after seeding', async () => {
    const sent: unknown[] = [];
    const messages = new MessagesService(m.AgentMessage, new AgentRegistry(), new CoordinatorEvents());
    messages.send = async (x: unknown) => {
      sent.push(x);
      return null;
    };
    const service = new LabOrdersService(m.LabRequest, m.LabLine, m.LabSample, m.LabLocation, m.CoordinatorCounter, null as any, null as any, messages, null as any, m.LabTestReport);
    const requests = await m.LabRequest.find().lean().exec();
    const lines = await m.LabLine.find().lean().exec();
    const reports = await m.LabTestReport.countDocuments().exec();
    assert.deepEqual(await service.reconcile(), { ordered: 0, collectionDone: 0, requestDone: 0, reports: 0 });
    const { LabResultsService } = await import('../modules/lab/lab-results.service');
    const criticals = new LabResultsService(m.LabRequest, m.LabLine, m.LabTestReport, m.TaskAlertItem, service, messages, null as any, null as any, m.Clock);
    assert.deepEqual(await criticals.reconcileCriticals(), { critical: 0, acked: 0 });
    assert.equal(sent.length, 0);
    assert.deepEqual(await m.LabRequest.find().lean().exec(), requests, 'no request changed');
    assert.deepEqual(await m.LabLine.find().lean().exec(), lines, 'no line changed');
    assert.equal(await m.LabTestReport.countDocuments().exec(), reports);
    // Each request has the messages its state implies.
    for (const r of requests as any[]) {
      const types = (await m.AgentMessage.find({ 'payload.requestId': String(r._id) }).lean<any[]>().exec()).map((x) => x.type);
      assert.ok(types.includes('lab.ordered'), `${r.number} ordered`);
      assert.equal(types.includes('lab.request-done'), !!r.doneAt, `${r.number} request-done`);
      if (r.collectionDoneAt) assert.ok(types.includes('lab.collection-done'), `${r.number} collection-done`);
      assert.equal(types.includes('lab.received'), !!r.firstReceivedAt, `${r.number} received`);
    }
  });

  test('nothing seeded is after now at 06:00 or 23:00', async () => {
    for (const [label, hour] of [['06:00', 6], ['23:00', 23]] as const) {
      const day = new Date(2026, 9, 29, hour, 0, 0).getTime();
      const clinic = new Date(2026, 8, 26, hour, 0, 0).getTime();
      // The ER visits are placed against the same moment, so the requests can sit on them.
      await quiet(async () => {
        await seedEr(DAY, day);
        await seedLab(DAY, day);
      });
      const real = (d: Date | undefined | null, what: string) => d && assert.ok(d.getTime() <= day, `${what} ${d.toISOString()} is after now (${label})`);
      const clinicTime = (d: Date | undefined | null, what: string) => d && assert.ok(d.getTime() <= clinic, `${what} ${d.toISOString()} is after the clinic now (${label})`);

      const requests = await m.LabRequest.find().lean<any[]>().exec();
      assert.ok(requests.length >= 28);
      for (const r of requests) {
        const w = r.number;
        for (const k of ['createdAt', 'updatedAt', 'announcedAt', 'collectionDoneAt', 'doneAt', 'firstReceivedAt']) real(r[k], `${w} ${k}`);
        clinicTime(r.orderedAt, `${w} orderedAt`);
      }
      for (const l of await m.LabLine.find().lean<any[]>().exec()) {
        for (const k of ['createdAt', 'updatedAt', 'releasedRealAt', 'lastReleasedRealAt']) real(l[k], `line ${k}`);
        for (const k of ['enteredAt', 'releasedAt']) clinicTime(l[k], `line ${k}`);
        clinicTime(l.critical?.ackAt, 'ackAt');
        clinicTime(l.cancelled?.at, 'cancelled.at');
        for (const h of l.history) {
          clinicTime(h.enteredAt, 'history enteredAt');
          clinicTime(h.releasedAt, 'history releasedAt');
        }
      }
      for (const s of await m.LabSample.find().lean<any[]>().exec()) {
        for (const k of ['createdAt', 'updatedAt', 'collectedRealAt']) real(s[k], `sample ${k}`);
        clinicTime(s.collected?.at, 'collected.at');
        clinicTime(s.received?.at, 'received.at');
        clinicTime(s.rejected?.at, 'rejected.at');
      }
      for (const c of await m.Clock.find({ def: /^lab-/ }).lean<any[]>().exec()) {
        for (const k of ['startedAt', 'stoppedAt', 'createdAt', 'updatedAt']) real(c[k], `${c.def} ${k}`);
        if (c.state === 'running') assert.ok(c.dueAt.getTime() > day, `${c.def} running but due ${c.dueAt.toISOString()}`);
      }
      const labCases = await m.Case.find({ openedBy: 'lab' }).lean<any[]>().exec();
      assert.ok(labCases.length >= 5);
      for (const c of labCases) {
        clinicTime(c.openedAt, `${c.number} openedAt`);
        real(c.createdAt, `${c.number} createdAt`);
        real(c.updatedAt, `${c.number} updatedAt`);
      }
      // ER cases the lab touched keep their ER timestamps.
      for (const c of await m.Case.find({ openedBy: 'er' }).lean<any[]>().exec()) real(c.updatedAt, `${c.number} updatedAt`);
      for (const msg of await m.AgentMessage.find({ $or: [{ from: 'lab' }, { case: { $in: labCases.map((c) => c._id) } }] }).lean<any[]>().exec()) real(msg.createdAt, `${msg.type} createdAt`);
      for (const r of await m.LabTestReport.find({ labLine: { $exists: true } }).lean<any[]>().exec()) {
        real(r.createdAt, 'report createdAt');
        real(r.updatedAt, 'report updatedAt');
      }
      const snaps = await m.LabSnapshot.find().sort({ hour: 1 }).lean<any[]>().exec();
      assert.equal(snaps.length, 168);
      assert.equal(snaps.at(-1)!.hour.getTime(), hourOf(new Date(day)).getTime());
      assert.equal(snaps[0].hour.getTime(), hourOf(new Date(day)).getTime() - 167 * HOUR);
      for (const s of snaps) real(s.at, 'snapshot at');
      // The designed unacknowledged critical is still due about ten minutes after now.
      const running = await m.Clock.findOne({ def: 'lab-critical', state: 'running' }).lean<any>().exec();
      assert.equal(Math.round((running!.dueAt.getTime() - day) / MINUTE), 10);
    }
  });
});
