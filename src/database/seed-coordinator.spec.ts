import * as assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { hourOf } from '../common/utils/series';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../test/test-db';
import { seedBeds } from './seed-beds';
import { seedCoordinator } from './seed-coordinator';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAY = '2026-09-26';

describe('seedCoordinator', () => {
  const m = models();
  let adminId: string;
  let log: string[] = [];

  before(async () => {
    await connectTestDb();
    await resetTestDb();
    await m.Patient.create([
      { uhid: 'MHK202500325', name: 'David Raj', age: 45, gender: 'Male', phone: '9000000325' },
      { uhid: 'MHK202500327', name: 'James Wilson', age: 62, gender: 'Male', phone: '9000000327' },
      { uhid: 'MHK202500401', name: 'Priya Natarajan', age: 34, gender: 'Female', phone: '9000000401' },
      { uhid: 'MHK202500402', name: 'Suresh Kandasamy', age: 58, gender: 'Male', phone: '9000000402' },
      { uhid: 'MHK202500403', name: 'Meena Bhaskar', age: 29, gender: 'Female', phone: '9000000403' },
      { uhid: 'MHK202500404', name: 'Anwar Hussain', age: 71, gender: 'Male', phone: '9000000404' },
    ]);
    const admin = await m.User.create({ email: 'admin@medios.ai', passwordHash: 'x', name: 'Hospital Admin', role: 'admin' });
    adminId = String(admin._id);
    // An alert that has nothing to do with escalations must survive a reseed.
    await m.TaskAlertItem.create({ title: 'Unrelated alert', type: 'System', category: 'System', link: 'bed-request:abc' });
    await m.TaskAlertItem.create({ title: 'Stale escalation alert', type: 'System', category: 'Critical', link: 'escalation:old' });
    await m.TimelineEvent.create({ uhid: 'MHK202500401', date: '26 Sep 2026', time: '09:00 AM', category: 'Consultation', title: 'Unrelated visit' });
    const real = console.log;
    console.log = (...a: unknown[]) => {
      log.push(a.join(' '));
    };
    try {
      await seedBeds(DAY);
      log = [];
      await seedCoordinator(DAY);
    } finally {
      console.log = real;
    }
  });

  after(async () => {
    await closeTestDb();
  });

  test('the seeded cases match the seeded bed requests and admissions', async () => {
    const requests = await m.BedRequest.find().lean().exec();
    const admissions = await m.Admission.find().lean().exec();
    const cases = await m.Case.find().sort({ number: 1 }).lean().exec();

    const patients = new Set(requests.map((r) => String(r.patient)));
    assert.equal(cases.length, patients.size);
    assert.deepEqual(cases.map((c) => c.number), cases.map((_, i) => `CASE-${String(i + 1).padStart(4, '0')}`));
    assert.equal((await m.CoordinatorCounter.findOne({ key: 'case' }).lean().exec())!.last, cases.length);
    assert.match(log.join('\n'), new RegExp(`✅ ${cases.length} cases, \\d+ messages, 1 approval, 1 escalation, 168 snapshots`));

    const refd = cases.flatMap((c) => c.refs.bedRequestIds);
    assert.equal(refd.length, requests.length);
    for (const r of requests) {
      const c = cases.find((x) => String(x.patient) === String(r.patient))!;
      assert.ok(c.refs.bedRequestIds.includes(String(r._id)));
      assert.equal(c.patientUhid, r.patientUhid);
      const mine = requests.filter((x) => String(x.patient) === String(r.patient));
      const admission = r.admission ? admissions.find((a) => String(a._id) === String(r.admission)) : undefined;
      if (admission) {
        assert.equal(c.refs.admissionId, String(admission._id));
        assert.equal(c.state, admission.status === 'discharged' ? 'closed' : 'open');
      } else {
        assert.equal(c.state, mine.every((x) => !x.open) ? 'closed' : 'open');
      }
    }
    assert.ok(cases.some((c) => c.state === 'open'));
    assert.ok(cases.some((c) => c.state === 'closed' && c.closedAt && c.closedReason));
    // Closed cases got a case.closed message, open ones did not.
    for (const c of cases) {
      const closedMsgs = await m.AgentMessage.countDocuments({ case: c._id, type: 'case.closed' }).exec();
      assert.equal(closedMsgs, c.state === 'closed' ? 1 : 0);
    }
  });

  test('messages read like the bridge: ordered, delivered, resolved, unique', async () => {
    const msgs = await m.AgentMessage.find().sort({ createdAt: 1 }).lean().exec();
    assert.ok(msgs.every((x) => x.state === 'delivered' && x.hop === 0 && x.attempts === 0));
    assert.equal(new Set(msgs.map((x) => x.dedupeKey)).size, msgs.length);
    const cases = await m.Case.find().lean().exec();
    for (const c of cases) {
      const mine = await m.AgentMessage.find({ case: c._id }).sort({ createdAt: 1 }).lean().exec();
      assert.equal(mine[0].type, 'case.opened');
      assert.equal(mine[1].type, 'bed.request');
      assert.equal(mine[1].opensWork, true);
    }
    const assigned = msgs.filter((x) => x.type === 'bed.assigned');
    assert.ok(assigned.length >= 10);
    for (const a of assigned) {
      const opened = msgs.find((x) => String(x._id) === String(a.resolves))!;
      assert.equal(opened.type, 'bed.request');
      assert.ok(opened.resolvedAt);
    }
    // Times use the real clock: the newest message is no later than now, none is in the future.
    assert.ok(msgs.every((x) => x.createdAt.getTime() <= Date.now()));
  });

  test('one open approval, one expired clock with an open escalation and its alert', async () => {
    const approvals = await m.Approval.find().lean().exec();
    assert.equal(approvals.length, 1);
    const ap = approvals[0];
    assert.equal(ap.state, 'open');
    assert.equal(ap.type, 'bed.attention');
    assert.deepEqual(ap.roles, ['admin', 'doctor']);
    const req = await m.BedRequest.findById(ap.source!.id).lean().exec();
    assert.equal(req!.state, 'attention');
    assert.equal(req!.open, true);

    const clocks = await m.Clock.find().lean().exec();
    assert.equal(clocks.length, 1);
    const clock = clocks[0];
    assert.equal(clock.def, 'bed-wait');
    assert.equal(clock.state, 'expired');
    assert.ok(clock.dueAt.getTime() < Date.now());
    assert.ok(Date.now() - clock.startedAt.getTime() > 60 * 60_000);

    const escs = await m.Escalation.find().lean().exec();
    assert.equal(escs.length, 1);
    const e = escs[0];
    assert.equal(e.state, 'open');
    assert.equal(e.ladder, 'bed-wait');
    assert.equal(e.step, 0);
    assert.deepEqual(e.source, { kind: 'clock', id: String(clock._id) });
    assert.equal(String(clock.escalation), String(e._id));

    const alert = await m.TaskAlertItem.findById(e.alert).lean().exec();
    assert.equal(alert!.link, `escalation:${e._id}`);
    assert.equal(alert!.title, 'Escalated to Duty administrator: Bed wait overdue');
    assert.equal(alert!.subtitle, 'On duty: Hospital Admin');
    assert.equal(alert!.escalation!.titleKey, 'duty-administrator');
    assert.deepEqual(alert!.escalation!.holderNames, ['Hospital Admin']);
    assert.equal(alert!.status, 'Pending');
    // The stale escalation alert is gone; the unrelated one and the unrelated timeline entry stay.
    assert.equal(await m.TaskAlertItem.countDocuments({ link: 'escalation:old' }).exec(), 0);
    assert.equal(await m.TaskAlertItem.countDocuments({ title: 'Unrelated alert' }).exec(), 1);
    assert.equal(await m.TimelineEvent.countDocuments({ title: 'Unrelated visit' }).exec(), 1);

    const types = (await m.AgentMessage.find({ case: e.case }).lean().exec()).map((x) => x.type);
    assert.ok(types.includes('clock.expired') && types.includes('escalation.raised') && types.includes('bed.waiting'));
  });

  test('duty titles and ladders are set, the admin holds two titles', async () => {
    const titles = await m.DutyTitle.find().lean().exec();
    assert.equal(titles.length, 6);
    const held = titles.filter((t) => t.holders.length).map((t) => t.key).sort();
    assert.deepEqual(held, ['duty-administrator', 'medical-superintendent']);
    assert.ok(titles.filter((t) => t.holders.length).every((t) => t.holders.map(String).join() === adminId));
    assert.deepEqual((await m.Ladder.find().lean().exec()).map((l) => l.key).sort(), ['bed-wait', 'default']);
  });

  test('history has 168 hourly points', async () => {
    const snaps = await m.CoordinatorSnapshot.find().sort({ hour: 1 }).lean().exec();
    assert.equal(snaps.length, 168);
    const last = hourOf(new Date()).getTime();
    snaps.forEach((s, i) => assert.equal(s.hour.getTime(), last - (167 - i) * HOUR));
    assert.ok(snaps.every((s) => s.activeWorkflows >= 0 && s.agentsOnline === 2 && s.tasksToday >= 1 && s.escalations >= 1), 'no hour is empty, so any hour has a day-ago trend');
    const open = (await m.Approval.countDocuments({ state: 'open' }).exec()) + (await m.Escalation.countDocuments({ state: 'open' }).exec());
    assert.equal(snaps[snaps.length - 1].escalations, open);
    assert.ok(new Set(snaps.map((s) => s.activeWorkflows)).size > 3, 'open cases rise and fall');
    // The day-ago point exists and is non-zero, so the cards have a trend.
    const dayAgo = snaps.find((s) => s.hour.getTime() === last - 24 * HOUR)!;
    assert.ok(dayAgo.activeWorkflows > 0 && dayAgo.tasksToday > 0 && dayAgo.escalations > 0);
  });

  test('no patient name appears in any message, approval or alert', async () => {
    const names = (await m.Patient.find().lean().exec()).map((p) => p.name);
    const sample = (await m.Admission.find({ sample: true }).lean().exec()).map((a) => a.patientName);
    const text = JSON.stringify([
      await m.AgentMessage.find().lean().exec(),
      await m.Approval.find().lean().exec(),
      await m.Escalation.find().lean().exec(),
      await m.TaskAlertItem.find({ link: /^escalation:/ }).lean().exec(),
    ]);
    for (const n of [...names, ...sample]) assert.ok(!text.includes(n), `"${n}" leaked`);
  });

  test('running it again gives the same counts', async () => {
    const before = {
      cases: await m.Case.countDocuments().exec(),
      messages: await m.AgentMessage.countDocuments().exec(),
      alerts: await m.TaskAlertItem.countDocuments().exec(),
      timeline: await m.TimelineEvent.countDocuments().exec(),
    };
    const real = console.log;
    console.log = () => undefined;
    try {
      await seedCoordinator(DAY);
    } finally {
      console.log = real;
    }
    assert.equal(await m.Case.countDocuments().exec(), before.cases);
    assert.equal(await m.AgentMessage.countDocuments().exec(), before.messages);
    assert.equal(await m.TaskAlertItem.countDocuments().exec(), before.alerts);
    assert.equal(await m.TimelineEvent.countDocuments().exec(), before.timeline);
  });

  for (const hour of [6, 23]) {
    test(`seeded messages keep the bridge's order when seeded at ${hour}:00`, async () => {
      const fake = new Date();
      fake.setHours(hour, 0, 0, 0);
      const real = console.log;
      console.log = () => undefined;
      try {
        await seedCoordinator(DAY, fake.getTime());
      } finally {
        console.log = real;
      }
      const msgs = await m.AgentMessage.find().lean().exec();
      assert.ok(msgs.length > 0);
      assert.ok(msgs.every((x) => x.createdAt.getTime() <= fake.getTime()), 'nothing after now');
      for (const c of await m.Case.find().lean().exec()) {
        const mine = msgs.filter((x) => String(x.case) === String(c._id)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || String(a._id).localeCompare(String(b._id)));
        assert.equal(mine[0].type, 'case.opened');
        assert.equal(mine[1].type, 'bed.request');
        assert.ok(mine[1].createdAt.getTime() > mine[0].createdAt.getTime());
        for (const r of mine.filter((x) => x.resolves)) {
          const opened = msgs.find((x) => String(x._id) === String(r.resolves))!;
          assert.ok(r.createdAt.getTime() > opened.createdAt.getTime(), `${r.type} comes after its bed.request`);
          assert.ok(opened.resolvedAt && opened.resolvedAt.getTime() >= opened.createdAt.getTime() && opened.resolvedAt.getTime() <= fake.getTime());
          assert.equal(opened.resolvedAt!.getTime(), r.createdAt.getTime());
        }
        const closed = mine.find((x) => x.type === 'case.closed');
        if (closed) assert.equal(mine[mine.length - 1], closed);
      }
      // The clock and escalation keep their gaps, and the escalation is still the latest-but-recent thing.
      const clock = (await m.Clock.find().lean().exec())[0];
      assert.equal(clock.dueAt.getTime() - clock.startedAt.getTime(), 60 * MINUTE);
      assert.ok(clock.dueAt.getTime() <= fake.getTime());
      assert.ok(Math.abs(clock.dueAt.getTime() - (fake.getTime() - 5 * MINUTE)) < 5000, 'clock expired 5 min before now');
      assert.ok(Math.abs(clock.startedAt.getTime() - (fake.getTime() - 65 * MINUTE)) < 5000, 'clock started 65 min before now');
      const esc = (await m.Escalation.find().lean().exec())[0];
      assert.ok(Math.abs(esc.stepAt.getTime() - (fake.getTime() - 5 * MINUTE)) < 5000, 'stepAt 5 min before now');
      assert.ok(Math.abs(esc.raisedAt.getTime() - (fake.getTime() - 5 * MINUTE)) < 5000);
      // The alert is stored as new (not back-dated), so Tasks & Alerts never buries it on the last page.
      const alert: any = (await m.TaskAlertItem.findById(esc.alert).lean().exec())!;
      const others: any[] = await m.TaskAlertItem.find({ _id: { $ne: alert._id } }).lean().exec();
      assert.ok(others.length > 0);
      assert.ok(others.every((o) => o.createdAt.getTime() <= alert.createdAt.getTime()), 'the escalation alert is the newest task');
      const waitMsg = (await m.AgentMessage.find({ type: 'bed.waiting', case: esc.case }).lean().exec())[0];
      assert.ok(Math.abs(waitMsg.createdAt.getTime() - (fake.getTime() - 65 * MINUTE)) < 5000, 'bed.waiting about 65 min before now');
      const midnight = new Date(fake);
      midnight.setHours(0, 0, 0, 0);
      const snap = (await m.CoordinatorSnapshot.find().sort({ hour: -1 }).limit(1).lean().exec())[0];
      assert.equal(snap.tasksToday, msgs.filter((x) => x.createdAt.getTime() >= midnight.getTime()).length, 'messages today match the stored log');
    });
  }

  test('a seed that cannot run leaves the coordinator data as it was', async () => {
    const before = await m.Case.countDocuments().exec();
    await m.Patient.deleteMany({ uhid: { $nin: ['MHK202500325', 'MHK202500327'] } }).exec();
    const real = console.log;
    console.log = () => undefined;
    try {
      await assert.rejects(seedCoordinator(DAY), /at least two patients/);
    } finally {
      console.log = real;
    }
    assert.equal(await m.Case.countDocuments().exec(), before);
    assert.equal(await m.Approval.countDocuments().exec(), 1);
  });
});
