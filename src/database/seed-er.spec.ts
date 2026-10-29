import * as assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { clinicNow } from '../common/utils/clinic-time';
import { hourOf } from '../common/utils/series';
import { ErVisitsService } from '../modules/er/er-visits.service';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../test/test-db';
import { seedBeds } from './seed-beds';
import { seedCoordinator } from './seed-coordinator';
import { seedEr } from './seed-er';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAY = '2026-09-26';
const OPEN = ['waiting-triage', 'waiting-doctor', 'in-treatment', 'waiting-bed'];

describe('seedEr', () => {
  const m = models();
  let log: string[] = [];
  let seededAt = 0;

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
    // Fewer demo patients than ER visits: the seed makes up the rest.
    await m.Patient.create([
      { uhid: 'MHK202500325', name: 'David Raj', age: 45, gender: 'Male', phone: '9000000325' },
      { uhid: 'MHK202500327', name: 'James Wilson', age: 62, gender: 'Male', phone: '9000000327' },
      { uhid: 'MHK202500401', name: 'Priya Natarajan', age: 34, gender: 'Female', phone: '9000000401' },
      { uhid: 'MHK202500402', name: 'Suresh Kandasamy', age: 58, gender: 'Male', phone: '9000000402' },
      { uhid: 'MHK202500403', name: 'Meena Bhaskar', age: 29, gender: 'Female', phone: '9000000403' },
      { uhid: 'MHK202500404', name: 'Anwar Hussain', age: 71, gender: 'Male', phone: '9000000404' },
    ]);
    await m.User.create({ email: 'admin@medios.ai', passwordHash: 'x', name: 'Hospital Admin', role: 'admin' });
    await quiet(async () => {
      await seedBeds(DAY);
      await seedCoordinator(DAY);
    });
    seededAt = Date.now();
    log = await quiet(() => seedEr(DAY));
  });

  after(async () => {
    await closeTestDb();
  });

  test('seeded visits cover all four colours and every open status', async () => {
    const visits = await m.ErVisit.find().lean().exec();
    assert.ok(visits.length >= 24 && visits.length <= 26);
    const statuses = new Set(visits.map((v) => v.status));
    for (const s of [...OPEN, 'left']) assert.ok(statuses.has(s as any), `no ${s} visit`);
    const colours = new Set(visits.map((v) => v.triage?.colour));
    for (const c of ['red', 'orange', 'yellow', 'green']) assert.ok(colours.has(c), `no ${c} visit`);

    const open = visits.filter((v) => OPEN.includes(v.status));
    assert.match(log.join('\n'), new RegExp(`✅ ${visits.length} ER visits, ${open.length} in the ER, 1 expected, 168 snapshots`));
    assert.equal((await m.CoordinatorCounter.findOne({ key: 'er' }).lean().exec())!.last, visits.length);
    // First triage entry kept, pathways started by the rules.
    for (const v of visits.filter((x) => x.triage)) {
      assert.equal(v.triage!.history[0].kind, 'triage');
      assert.equal(v.triage!.history.at(-1)!.colour, v.triage!.colour);
    }
    for (const v of visits) for (const p of v.pathways) assert.equal(p.startedBy, 'rules');

    // One chest-pain pathway running with its ECG done.
    const chest = visits.find((v) => v.status === 'waiting-doctor' && v.pathways.some((p) => p.key === 'chest-pain') && v.steps.some((s) => s.key === 'ecg' && s.doneAt));
    assert.ok(chest);

    // Bays: in-treatment visits hold one, and each bay points back at its visit.
    const bays = await m.ErBay.find().lean().exec();
    assert.equal(bays.length, 20);
    const held = bays.filter((b) => b.visit);
    assert.ok(held.length >= 6);
    for (const b of held) {
      const v = visits.find((x) => String(x._id) === String(b.visit))!;
      assert.ok(OPEN.includes(v.status));
      assert.equal(String(v.bay), String(b._id));
      assert.equal(v.bayName, b.name);
    }
    for (const v of visits.filter((x) => x.bay)) assert.equal(String(held.find((b) => String(b._id) === String(v.bay))?.visit), String(v._id));
    for (const v of visits.filter((x) => x.status === 'in-treatment')) assert.ok(v.bay);
    assert.ok(visits.some((v) => v.status === 'waiting-doctor' && v.bay));
    assert.ok(visits.filter((v) => v.status === 'left').every((v) => !v.bay));
    assert.equal(new Set(visits.filter((v) => OPEN.includes(v.status)).map((v) => String(v.patient))).size, open.length);

    // The placeholder is a real Patient with its details pending.
    const placeholder = visits.find((v) => v.patientName.startsWith('Unknown '))!;
    const pp = (await m.Patient.findById(placeholder.patient).lean().exec())!;
    assert.equal(pp.detailsPending, true);
    assert.equal(pp.phone, '');
    assert.equal(pp.name, `Unknown male, ${placeholder.number}`);

    // The expected arrival is one waiting card a few minutes after the clinic now.
    const expected = await m.ErExpected.find().lean().exec();
    assert.equal(expected.length, 1);
    assert.equal(expected[0].state, 'waiting');
    const inMin = (expected[0].expectedAt.getTime() - clinicNow(DAY).getTime()) / MINUTE;
    assert.ok(inMin > 1 && inMin < 15, `expected in ${inMin} min`);

    // The waiting-bed visit's case is open with a Bed Agent request on it.
    const wb = visits.find((v) => v.status === 'waiting-bed')!;
    const wbCase = (await m.Case.findById(wb.case).lean().exec())!;
    assert.equal(wbCase.state, 'open');
    const request = (await m.BedRequest.findOne({ patient: wb.patient, open: true }).lean().exec())!;
    assert.ok(request);
    assert.ok(wbCase.refs.bedRequestIds.includes(String(request._id)));
    assert.equal(request.state, 'waiting');
    assert.equal(wb.disposition!.kind, 'admit');

    // Visits that went home have closed cases, with the passing check's label as the reason.
    const home = visits.filter((v) => v.disposition?.kind === 'home');
    assert.ok(home.length >= 5);
    for (const v of home) {
      const c = (await m.Case.findById(v.case).lean().exec())!;
      assert.equal(c.state, 'closed');
      assert.equal(c.closedReason, 'ER visit finished');
    }
    // Open visits' cases are open; left visits may reuse a patient.
    for (const v of open) assert.equal((await m.Case.findById(v.case).lean().exec())!.state, 'open');
    assert.ok(new Set(visits.map((v) => String(v.patient))).size < visits.length);
  });

  test('the overdue review has an expired clock and an open escalation', async () => {
    const expired = await m.Clock.find({ def: /^er-/, state: 'expired' }).lean().exec();
    assert.equal(expired.length, 1);
    const clock = expired[0];
    assert.equal(clock.def, 'er-doctor');
    const visit = (await m.ErVisit.findOne({ case: clock.case }).lean().exec())!;
    assert.equal(visit.status, 'waiting-doctor');
    assert.equal(visit.doctorSeenAt, undefined);
    const escalation = (await m.Escalation.findOne({ ladder: 'er' }).lean().exec())!;
    assert.equal(await m.Escalation.countDocuments({ ladder: 'er' }).exec(), 1);
    assert.equal(escalation.state, 'open');
    assert.equal(escalation.step, 0);
    assert.deepEqual(escalation.source, { kind: 'clock', id: String(clock._id) });
    assert.equal(String(clock.escalation), String(escalation._id));
    assert.equal(String(escalation.case), String(clock.case));
    // Anchored to now: it ran out about five minutes before the seed.
    assert.ok(Math.abs(seededAt - escalation.raisedAt.getTime() - 5 * MINUTE) < MINUTE);
    assert.equal(escalation.raisedAt.getTime(), clock.dueAt.getTime());
    const alert = (await m.TaskAlertItem.findById(escalation.alert).lean().exec())!;
    assert.equal(alert.link, `escalation:${escalation._id}`);
    assert.equal((alert as any).escalation.titleKey, 'er-nurse-in-charge');
    assert.ok(await m.AgentMessage.exists({ case: clock.case, type: 'clock.expired' }));
    assert.ok(await m.AgentMessage.exists({ case: clock.case, type: 'escalation.raised' }));
  });

  test('every open visit\'s expected clock is running', async () => {
    const visits = await m.ErVisit.find({ status: { $in: OPEN } }).lean().exec();
    const expiredCase = String((await m.Clock.findOne({ def: 'er-doctor', state: 'expired' }).lean().exec())!.case);
    for (const v of visits) {
      const mine = await m.Clock.find({ case: v.case, def: /^er-/ }).lean().exec();
      const running = new Set(mine.filter((c) => c.state === 'running').map((c) => c.def));
      const expected = new Set<string>();
      if (!v.triage) expected.add('er-triage');
      else if (!v.doctorSeenAt && String(v.case) !== expiredCase) expected.add('er-doctor');
      for (const p of v.pathways.filter((x) => !x.cancelled)) {
        for (const s of v.steps) if (s.key !== 'doctor' && !s.doneAt && ((p.key === 'chest-pain' && s.key === 'ecg') || (p.key === 'stroke' && ['ct', 'last-known-well'].includes(s.key)) || (p.key === 'sepsis' && ['cultures', 'antibiotics'].includes(s.key)))) {
          expected.add(`er-step-${s.key}`);
        }
      }
      assert.deepEqual([...running].sort(), [...expected].sort(), `${v.number} clocks`);
      for (const c of mine.filter((x) => x.state === 'running')) assert.ok(c.dueAt.getTime() > seededAt, `${v.number} ${c.def} is overdue`);
    }
    // Both kinds of waiting and a step clock exist somewhere.
    const defs = new Set((await m.Clock.find({ state: 'running', def: /^er-/ }).lean().exec()).map((c) => c.def));
    for (const d of ['er-triage', 'er-doctor', 'er-step-ecg']) assert.ok(defs.has(d), d);
    // Left visits' clocks are stopped.
    for (const v of await m.ErVisit.find({ status: 'left' }).lean().exec()) {
      const mine = await m.Clock.find({ case: v.case, def: /^er-/ }).lean().exec();
      assert.ok(mine.length > 0);
      assert.ok(mine.every((c) => c.state === 'met' && c.stoppedAt), `${v.number} has a clock still running`);
    }
  });

  test('reannounce() finds nothing to resend after seeding', async () => {
    const sent: unknown[] = [];
    const stub = { send: async (x: unknown) => void sent.push(x) } as any;
    const service = new ErVisitsService(m.ErVisit as any, m.ErExpected as any, m.CoordinatorCounter as any, m.Patient as any, null as any, null as any, null as any, stub, null as any);
    assert.deepEqual(await service.reannounce(), { arrived: 0, left: 0 });
    assert.equal(sent.length, 0);
    // Each visit has the messages its state implies.
    for (const v of await m.ErVisit.find().lean().exec()) {
      const types = new Set((await m.AgentMessage.find({ case: v.case, 'payload.visitId': String(v._id) }).lean().exec()).map((x) => x.type));
      assert.ok(types.has('er.arrived'), `${v.number} arrived`);
      assert.equal(types.has('er.triaged'), !!v.triage);
      assert.equal(types.has('er.doctor-seen'), !!v.doctorSeenAt);
      assert.equal(types.has('er.disposition'), !!v.disposition);
      assert.equal(types.has('er.left'), v.status === 'left');
      assert.equal(types.has('er.pathway-started'), v.pathways.length > 0);
      assert.equal(types.has('er.step-done'), v.steps.some((s) => s.key !== 'doctor' && s.doneAt));
    }
  });

  test('no patient name in any seeded ER message', async () => {
    const names = (await m.Patient.find().lean().exec()).map((p) => p.name);
    assert.ok(names.some((n) => n.startsWith('Unknown ')));
    const ers = await m.ErVisit.find().select('case').lean().exec();
    const msgs = await m.AgentMessage.find({ $or: [{ from: 'er' }, { case: { $in: ers.map((v) => v.case) } }] }).lean().exec();
    assert.ok(msgs.length > 100);
    for (const msg of msgs) {
      const text = `${msg.summary} ${JSON.stringify(msg.payload)}`;
      for (const n of names) assert.ok(!text.includes(n), `"${n}" in ${msg.type}`);
      assert.ok(!/Unknown (male|female|person)/.test(text));
    }
    // Every visit message carries the visit number.
    for (const msg of msgs.filter((x) => /^er\.(arrived|triaged|step-done|doctor-seen|disposition|left)$/.test(x.type))) assert.match(msg.summary, /^ER-\d{4}/);
  });

  test('nothing seeded is after now at 06:00 or 23:00', async () => {
    for (const [label, hour] of [['06:00', 6], ['23:00', 23]] as const) {
      const day = new Date(2026, 9, 29, hour, 0, 0).getTime();
      const clinic = new Date(2026, 8, 26, hour, 0, 0).getTime();
      await quiet(() => seedEr(DAY, day));
      const real = (d: Date | undefined, what: string) => d && assert.ok(d.getTime() <= day, `${what} ${d.toISOString()} is after now (${label})`);
      const clinicTime = (d: Date | undefined, what: string) => d && assert.ok(d.getTime() <= clinic, `${what} ${d.toISOString()} is after the clinic now (${label})`);

      const visits = await m.ErVisit.find().lean<any[]>().exec();
      assert.ok(visits.length >= 24);
      for (const v of visits) {
        const w = v.number;
        real(v.createdAt, `${w} createdAt`);
        real(v.updatedAt, `${w} updatedAt`);
        real(v.announcedAt, `${w} announcedAt`);
        real(v.leftAnnouncedAt, `${w} leftAnnouncedAt`);
        clinicTime(v.arrivedAt, `${w} arrivedAt`);
        clinicTime(v.triage?.at, `${w} triage.at`);
        for (const h of v.triage?.history ?? []) clinicTime(h.at, `${w} history`);
        for (const s of v.steps) clinicTime(s.doneAt, `${w} step`);
        clinicTime(v.doctorSeenAt, `${w} doctorSeenAt`);
        clinicTime(v.disposition?.at, `${w} disposition`);
        clinicTime(v.leftAt, `${w} leftAt`);
      }
      for (const c of await m.Clock.find({ def: /^er-/ }).lean<any[]>().exec()) {
        real(c.startedAt, `${c.def} startedAt`);
        real(c.stoppedAt, `${c.def} stoppedAt`);
        real(c.createdAt, `${c.def} createdAt`);
        real(c.updatedAt, `${c.def} updatedAt`);
        if (c.state === 'running') assert.ok(c.dueAt.getTime() > day, `${c.def} running but due ${c.dueAt.toISOString()}`);
      }
      const cases = await m.Case.find({ openedBy: 'er' }).lean<any[]>().exec();
      assert.equal(cases.length, visits.length);
      for (const c of cases) {
        clinicTime(c.openedAt, `${c.number} openedAt`);
        clinicTime(c.closedAt, `${c.number} closedAt`);
        real(c.createdAt, `${c.number} createdAt`);
        real(c.updatedAt, `${c.number} updatedAt`);
      }
      const ids = cases.map((c) => c._id);
      for (const msg of await m.AgentMessage.find({ case: { $in: ids } }).lean<any[]>().exec()) {
        real(msg.createdAt, `${msg.type} createdAt`);
        real(msg.resolvedAt, `${msg.type} resolvedAt`);
      }
      for (const e of await m.Escalation.find({ ladder: 'er' }).lean<any[]>().exec()) {
        real(e.raisedAt, 'escalation raisedAt');
        real(e.stepAt, 'escalation stepAt');
        real((e as any).createdAt, 'escalation createdAt');
        real((e as any).updatedAt, 'escalation updatedAt');
      }
      const snaps = await m.ErSnapshot.find().sort({ hour: 1 }).lean<any[]>().exec();
      assert.equal(snaps.length, 168);
      assert.equal(snaps.at(-1)!.hour.getTime(), hourOf(new Date(day)).getTime());
      assert.equal(snaps[0].hour.getTime(), hourOf(new Date(day)).getTime() - 167 * HOUR);
      for (const s of snaps) real(s.at, 'snapshot at');
      for (const x of await m.ErExpected.find().lean<any[]>().exec()) real((x as any).createdAt, 'expected createdAt');
      for (const b of await m.ErBay.find().lean<any[]>().exec()) real((b as any).updatedAt, 'bay updatedAt');
      const request = await m.BedRequest.findOne({ requestedBy: 'ER Seed' }).lean<any>().exec();
      clinicTime(request!.requestedAt, 'bed request requestedAt');
      clinicTime(request!.stateSince, 'bed request stateSince');
    }
  });
});
