import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { TasksAlertsService } from '../tasks-alerts/tasks-alerts.service';
import { UserRole } from '../users/schemas/user.schema';
import { AgentRegistry } from './agent-registry';
import { CoordinatorEvents } from './coordinator-events';
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

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });

  const makeService = () => new EscalationsService(Escalation, DutyTitle, Ladder, TaskAlertItem, User, messages);
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
    assert.ok(list[0].reason.startsWith('Agent error: '));

    await messages.send({ from: 'er', to: ['lab'], type: 'er.bounce', priority: 'low', summary: 'b', payload: { n: 0 } });
    list = await Escalation.find().sort({ raisedAt: 1 }).lean();
    assert.equal(list.length, 2);
    assert.equal(list[1].source.kind, 'loop');
    assert.ok(list[1].reason.startsWith('Agent loop: '));
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
    assert.equal(titles.length, 6);
    assert.deepEqual(titles.find((t) => t.key === 'er-consultant')!.holders, [nurse.id]);
    assert.equal((await service.ladders()).length, 2);

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
    assert.equal((await service.ladders()).length, 3);
  });

  test('holders leave out inactive users', async () => {
    const off = await makeUser('Off Duty', UserRole.STAFF, { isActive: false });
    await hold('duty-administrator', dutyAdmin.id, off.id);
    const h = await service.holders('duty-administrator');
    assert.deepEqual(h.names, ['Dev Duty']);
  });
});
