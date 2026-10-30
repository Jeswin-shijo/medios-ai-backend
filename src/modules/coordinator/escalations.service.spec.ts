import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { TasksAlertsService } from '../tasks-alerts/tasks-alerts.service';
import { UserRole } from '../users/schemas/user.schema';
import { AgentRegistry } from './agent-registry';
import { CoordinatorEvent, CoordinatorEvents } from './coordinator-events';
import { EscalationsService } from './escalations.service';
import { MessagesService } from './messages.service';

const status = async () => ({ open: 0, capacity: 0, onTimePct: null });
const MIN = 60_000;

describe('EscalationsService', () => {
  const { AgentMessage, DutyTitle, Escalation, Ladder, TaskAlertItem, User } = models();
  let registry: AgentRegistry;
  let messages: MessagesService;
  let service: EscalationsService;
  let admin: { id: string; name: string; role: UserRole };
  let dutyAdmin: { id: string; name: string; role: UserRole };
  let superintendent: { id: string; name: string; role: UserRole };
  let nurse: { id: string; name: string; role: UserRole };
  let events: CoordinatorEvents;
  let seen: CoordinatorEvent[];

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });

  const makeService = () => new EscalationsService(Escalation, DutyTitle, Ladder, TaskAlertItem, User, messages, events);
  const makeUser = async (name: string, role: UserRole, extra: object = {}) => {
    const u = await User.create({ email: `${name.replace(/\s/g, '').toLowerCase()}@x.test`, passwordHash: 'x', name, role, ...extra });
    return { id: String(u._id), name, role };
  };
  const hold = (key: string, ...ids: string[]) =>
    DutyTitle.updateOne({ key }, { $set: { holders: ids.map((i) => new Types.ObjectId(i)) } });

  beforeEach(async () => {
    await resetTestDb();
    registry = new AgentRegistry();
    messages = new MessagesService(AgentMessage, registry, new CoordinatorEvents());
    events = new CoordinatorEvents();
    seen = [];
    events.events$.subscribe((e) => seen.push(e));
    service = makeService();
    await service.ensureDefaults();
    admin = await makeUser('Asha Admin', UserRole.ADMIN);
    dutyAdmin = await makeUser('Dev Duty', UserRole.STAFF);
    superintendent = await makeUser('Sam Super', UserRole.DOCTOR);
    nurse = await makeUser('Nina Nurse', UserRole.NURSE);
  });

  const raise = (reason = 'ECG is late') => service.raise({ ladder: 'default', reason, source: { kind: 'manual' } });

  test('raise creates one alert naming the title holders, or admins when nobody holds it', async () => {
    const empty = await raise();
    let alert: any = await TaskAlertItem.findById(empty.alert).lean();
    assert.equal(alert.title, 'Escalated to Duty administrator: ECG is late');
    assert.equal(alert.subtitle, 'Admins (no one holds this title yet)');
    assert.deepEqual(alert.escalation.holderNames, ['Asha Admin']);
    assert.equal(alert.escalation.titleKey, 'duty-administrator');
    assert.equal(alert.escalation.step, 0);
    assert.equal(alert.type, 'System');
    assert.equal(alert.category, 'Critical');
    assert.equal(alert.priority, 'High');
    assert.equal(alert.link, `escalation:${empty._id}`);

    await hold('duty-administrator', dutyAdmin.id);
    const held = await raise('Bed wait');
    alert = await TaskAlertItem.findById(held.alert).lean();
    assert.equal(alert.subtitle, 'On duty: Dev Duty');
    assert.deepEqual(alert.escalation.holderNames, ['Dev Duty']);
    assert.equal(await TaskAlertItem.countDocuments(), 2);

    const sent = await messages.list({ type: 'escalation.raised' });
    assert.equal(sent.length, 2);
    assert.equal(sent[0].priority, 'high');
  });

  test('raise twice for the same clock source gives one escalation and one alert', async () => {
    const source = { kind: 'clock' as const, id: 'clock-1' };
    const a = await service.raise({ ladder: 'default', reason: 'Late', source });
    const b = await service.raise({ ladder: 'default', reason: 'Late', source });
    assert.equal(String(a._id), String(b._id));
    assert.equal(await Escalation.countDocuments(), 1);
    assert.equal(await TaskAlertItem.countDocuments(), 1);
    assert.equal((await messages.list({ type: 'escalation.raised' })).length, 1);
  });

  test('advanceDue moves to the next step after its wait and stays at the last step', async () => {
    await hold('medical-superintendent', superintendent.id);
    const e = await raise();
    const t0 = new Date(e.stepAt).getTime();
    assert.equal(await service.advanceDue(new Date(t0 + 14 * MIN)), 0);
    assert.equal(await service.advanceDue(new Date(t0 + 15 * MIN)), 1);
    const moved = await Escalation.findById(e._id).lean();
    assert.equal(moved!.step, 1);
    assert.equal(new Date(moved!.stepAt).getTime(), t0 + 15 * MIN);
    const alert: any = await TaskAlertItem.findById(e.alert).lean();
    assert.equal(alert.title, 'Escalated to Medical superintendent: ECG is late');
    assert.equal(alert.subtitle, 'On duty: Sam Super');
    assert.equal(alert.escalation.step, 1);
    assert.equal(alert.escalation.titleKey, 'medical-superintendent');
    assert.deepEqual(alert.escalation.holderNames, ['Sam Super']);
    assert.equal(await TaskAlertItem.countDocuments(), 1);
    assert.equal(await messages.list({ type: 'escalation.raised' }).then((l) => l.length), 1);

    assert.equal(await service.advanceDue(new Date(t0 + 24 * 60 * MIN)), 0);
    assert.equal((await Escalation.findById(e._id).lean())!.step, 1);
  });

  test('a holder of the current step or a later step, or an admin, can acknowledge', async () => {
    await hold('duty-administrator', dutyAdmin.id);
    await hold('medical-superintendent', superintendent.id);
    const ids: string[] = [];
    for (const who of [dutyAdmin, superintendent, admin]) {
      const e = await raise(`r-${who.name}`);
      ids.push(String(e._id));
      await service.acknowledge(who, String(e._id));
      const stored = await Escalation.findById(e._id).lean();
      assert.equal(stored!.state, 'acknowledged');
      assert.equal(stored!.ackBy, who.id);
      assert.equal(stored!.ackByName, who.name);
      assert.ok(stored!.ackAt);
      const alert = await TaskAlertItem.findById(e.alert).lean();
      assert.equal(alert!.status, 'Completed');
    }
    await assert.rejects(service.acknowledge(admin, ids[0]), /Already acknowledged/);
    // A holder of an earlier step cannot acknowledge once the escalation moved up.
    const e = await raise('moved');
    await service.advanceDue(new Date(Date.now() + 20 * MIN));
    await assert.rejects(service.acknowledge(dutyAdmin, String(e._id)), /Only the person on duty/);
    await service.acknowledge(superintendent, String(e._id));
  });

  test('anyone else is refused and the ladder carries on', async () => {
    await hold('duty-administrator', dutyAdmin.id);
    const e = await raise();
    await assert.rejects(service.acknowledge(nurse, String(e._id)), {
      message: 'Only the person on duty for this step, someone further up, or an admin can acknowledge.',
    });
    const stored = await Escalation.findById(e._id).lean();
    assert.equal(stored!.state, 'open');
    assert.equal((await TaskAlertItem.findById(e.alert).lean())!.status, 'Pending');
    assert.equal(await service.advanceDue(new Date(Date.now() + 20 * MIN)), 1);
    // Acknowledged escalations are never advanced.
    const e2 = await raise('second');
    await service.acknowledge(admin, String(e2._id));
    await service.advanceDue(new Date(Date.now() + 60 * MIN));
    assert.equal((await Escalation.findById(e2._id).lean())!.step, 0);
  });

  test('the old toggle cannot complete an escalation alert', async () => {
    const e = await raise();
    const tasks = new TasksAlertsService(TaskAlertItem);
    await assert.rejects(tasks.toggleStatus(String(e.alert)), { status: 409, message: 'Use Acknowledge for escalation alerts.' });
    await assert.rejects(tasks.updateStatus(String(e.alert), 'Completed'), { status: 409 });
    assert.equal((await TaskAlertItem.findById(e.alert).lean())!.status, 'Pending');
  });

  test('a task created through the API cannot carry an escalation or a link', async () => {
    const e = await raise();
    const tasks = new TasksAlertsService(TaskAlertItem);
    const forged = await tasks.create({
      title: 'Forged',
      type: 'System',
      category: 'Critical',
      escalation: { id: String(e._id), ladder: 'default', step: 0, titleKey: 'x', titleLabel: 'x', holderNames: [] },
      link: `bed-request:${new Types.ObjectId()}`,
    } as any);
    const stored: any = await TaskAlertItem.findById(forged._id).lean();
    assert.equal(stored.title, 'Forged');
    assert.equal(stored.escalation, undefined);
    assert.equal(stored.link, undefined);
    // So the toggle works on it as on any task.
    assert.equal((await tasks.toggleStatus(String(forged._id))).status, 'Completed');
  });

  test('a failed message and a loop each raise one default escalation', async () => {
    registry.register({
      key: 'er',
      messageTypes: [{ type: 'er.bounce', agent: 'er', description: 'b', payload: { n: 'number' } }],
      handles: [
        { type: 'case.opened', handler: async () => { throw new Error('er is down'); } },
        {
          type: 'lab.pong',
          handler: async (id) => {
            const m = await messages.get(id);
            await messages.send({ from: 'er', to: ['lab'], type: 'er.bounce', priority: 'low', summary: 'b', payload: { n: m!.hop }, causedBy: m!.id });
          },
        },
      ],
      status,
    });
    registry.register({
      key: 'lab',
      messageTypes: [{ type: 'lab.pong', agent: 'lab', description: 'p', payload: { n: 'number' } }],
      handles: [
        {
          type: 'er.bounce',
          handler: async (id) => {
            const m = await messages.get(id);
            await messages.send({ from: 'lab', to: ['er'], type: 'lab.pong', priority: 'low', summary: 'p', payload: { n: m!.hop }, causedBy: m!.id });
          },
        },
      ],
      status,
    });

    await messages.send({ from: 'coordinator', to: ['er'], type: 'case.opened', priority: 'low', summary: 'x' });
    let list = await Escalation.find().lean();
    assert.equal(list.length, 1);
    assert.equal(list[0].ladder, 'default');
    assert.equal(list[0].source.kind, 'failed');
    // The handler's own error stays in the server log, out of everything staff see.
    assert.equal(list[0].reason, 'Agent error: case.opened not delivered after 3 tries');
    const failedAlert: any = await TaskAlertItem.findById(list[0].alert).lean();
    assert.equal(failedAlert.title, 'Escalated to Duty administrator: Agent error: case.opened not delivered after 3 tries');
    const raised = await messages.list({ type: 'escalation.raised' });
    assert.ok(raised.every((m) => !m.summary.includes('er is down')));

    await messages.send({ from: 'er', to: ['lab'], type: 'er.bounce', priority: 'low', summary: 'b', payload: { n: 0 } });
    list = await Escalation.find().sort({ raisedAt: 1 }).lean();
    assert.equal(list.length, 2);
    assert.equal(list[1].source.kind, 'loop');
    assert.ok(list[1].reason.startsWith('Agent loop: '));
  });

  test('acknowledge and each step move tell open screens with an escalation event', async () => {
    const caseId = String(new Types.ObjectId());
    const e = await service.raise({ ladder: 'default', case: caseId, reason: 'Late', source: { kind: 'manual' } });
    const id = String(e._id);
    assert.equal(seen.length, 0);
    await service.advanceDue(new Date(new Date(e.stepAt).getTime() + 15 * MIN));
    assert.deepEqual(seen, [{ kind: 'escalation', id, caseId }]);
    await assert.rejects(service.acknowledge(nurse, id), { status: 403 });
    assert.equal(seen.length, 1);
    await service.acknowledge(admin, id);
    assert.deepEqual(seen[1], { kind: 'escalation', id, caseId });
    const noCase = await raise('no case');
    await service.acknowledge(admin, String(noCase._id));
    assert.deepEqual(seen[2], { kind: 'escalation', id: String(noCase._id) });
  });

  test('one escalation that fails to move does not stop the others in the same pass', async () => {
    await hold('medical-superintendent', superintendent.id);
    const bad = await raise('first');
    const good = await raise('second');
    const writeAlert = (service as any).writeAlert.bind(service);
    (service as any).writeAlert = async (e: any, titleKey: string, create: boolean) => {
      if (String(e._id) === String(bad._id)) throw new Error('alert store down');
      return writeAlert(e, titleKey, create);
    };
    assert.equal(await service.advanceDue(new Date(Date.now() + 20 * MIN)), 1);
    assert.equal((await Escalation.findById(good._id).lean())!.step, 1);
    const alert: any = await TaskAlertItem.findById(good.alert).lean();
    assert.equal(alert.escalation.titleKey, 'medical-superintendent');
  });

  test('advanceDue after a restart continues from the stored step', async () => {
    await hold('medical-superintendent', superintendent.id);
    const e = await raise();
    const t0 = new Date(e.stepAt).getTime();
    await service.advanceDue(new Date(t0 + 16 * MIN));
    const restarted = makeService();
    assert.equal(await restarted.advanceDue(new Date(t0 + 17 * MIN)), 0);
    assert.equal((await Escalation.findById(e._id).lean())!.step, 1);
    assert.equal(await restarted.advanceDue(new Date(t0 + 5 * 60 * MIN)), 0);
    const alert: any = await TaskAlertItem.findById(e.alert).lean();
    assert.equal(alert.escalation.step, 1);
  });

  test('titles and ladders: defaults are never overwritten, saves are admin only and validated', async () => {
    await service.saveTitle(admin, { key: 'er-consultant', label: 'ER consultant', holders: [nurse.id] });
    await service.ensureDefaults();
    await service.ensureDefaults();
    const titles = await service.titles();
    assert.equal(titles.length, 9);
    assert.deepEqual(titles.find((t) => t.key === 'er-consultant')!.holders, [nurse.id]);
    assert.equal((await service.ladders()).length, 7);

    await assert.rejects(service.saveTitle(nurse, { key: 'x', label: 'x', holders: [] }), { status: 403 });
    await assert.rejects(service.saveTitle(admin, { key: 'x', label: 'x', holders: [String(new Types.ObjectId())] }), { status: 400 });
    await assert.rejects(service.saveLadder(nurse, { key: 'l', label: 'l', steps: [{ title: 'er-consultant', waitMinutes: 5 }] }), { status: 403 });
    await assert.rejects(service.saveLadder(admin, { key: 'l', label: 'l', steps: [] }), { status: 400 });
    await assert.rejects(service.saveLadder(admin, { key: 'l', label: 'l', steps: [{ title: 'nope', waitMinutes: 5 }] }), { status: 400 });
    await assert.rejects(
      service.saveLadder(admin, { key: 'l', label: 'l', steps: [{ title: 'er-consultant', waitMinutes: 0 }, { title: 'er-consultant', waitMinutes: 0 }] }),
      { status: 400 },
    );
    await service.saveLadder(admin, { key: 'l', label: 'l', steps: [{ title: 'er-consultant', waitMinutes: 5 }, { title: 'er-consultant', waitMinutes: 0 }] });
    assert.equal((await service.ladders()).length, 8);
  });

  test('the lab and lab-critical ladders and the two titles exist after seeding defaults', async () => {
    const titles = await service.titles();
    assert.equal(titles.find((t) => t.key === 'lab-in-charge')!.label, 'Lab in charge');
    assert.equal(titles.find((t) => t.key === 'duty-doctor')!.label, 'Duty doctor');
    const ladders = await service.ladders();
    assert.deepEqual(ladders.find((l) => l.key === 'lab')!.steps, [
      { title: 'lab-in-charge', waitMinutes: 15 },
      { title: 'duty-administrator', waitMinutes: 15 },
      { title: 'medical-superintendent', waitMinutes: 0 },
    ]);
    assert.deepEqual(ladders.find((l) => l.key === 'lab-critical')!.steps, [
      { title: 'duty-doctor', waitMinutes: 10 },
      { title: 'medical-superintendent', waitMinutes: 0 },
    ]);
  });

  test('the pharmacy and pharmacy-query ladders and the chief pharmacist title exist after ensureDefaults', async () => {
    await service.ensureDefaults();
    const titles = await service.titles();
    assert.equal(titles.find((t) => t.key === 'chief-pharmacist')!.label, 'Chief pharmacist');
    const ladders = await service.ladders();
    assert.deepEqual(ladders.find((l) => l.key === 'pharmacy')!.steps, [
      { title: 'pharmacist-on-duty', waitMinutes: 15 },
      { title: 'chief-pharmacist', waitMinutes: 15 },
      { title: 'medical-superintendent', waitMinutes: 0 },
    ]);
    assert.deepEqual(ladders.find((l) => l.key === 'pharmacy-query')!.steps, [
      { title: 'duty-doctor', waitMinutes: 10 },
      { title: 'medical-superintendent', waitMinutes: 0 },
    ]);
  });

  test('a closes-on-stop escalation refuses Acknowledge with the wording of its page: Pharmacy for pharmacy-line, Lab for lab-line', async () => {
    const ph = await service.raise({ ladder: 'default', reason: 'Query late', source: { kind: 'clock', id: 'c1' }, alertLink: 'pharmacy-line:l1', closesOnStop: true });
    await assert.rejects(() => service.acknowledge(admin, String(ph._id)), {
      status: 409,
      message: 'Answer the query on the Pharmacy Agent page; this alert closes when it is answered.',
    });
    const lab = await service.raise({ ladder: 'default', reason: 'Result late', source: { kind: 'clock', id: 'c2' }, alertLink: 'lab-line:l2', closesOnStop: true });
    await assert.rejects(() => service.acknowledge(admin, String(lab._id)), {
      status: 409,
      message: 'Acknowledge the result on the Lab page; this alert closes when it is acknowledged.',
    });
  });

  test('holders leave out inactive users', async () => {
    const off = await makeUser('Off Duty', UserRole.STAFF, { isActive: false });
    await hold('duty-administrator', dutyAdmin.id, off.id);
    const h = await service.holders('duty-administrator');
    assert.deepEqual(h.names, ['Dev Duty']);
  });

  test('titles carry the names of their active holders only', async () => {
    const off = await makeUser('Off Duty', UserRole.STAFF, { isActive: false });
    await hold('duty-administrator', dutyAdmin.id, off.id);
    const titles = await service.titles();
    const t = titles.find((x) => x.key === 'duty-administrator')!;
    assert.deepEqual(t.holders, [dutyAdmin.id, off.id]);
    assert.deepEqual(t.holderNames, ['Dev Duty']);
    const empty = titles.find((x) => x.holders.length === 0)!;
    assert.deepEqual(empty.holderNames, []);
  });
});
