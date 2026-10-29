import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { UserRole } from '../users/schemas/user.schema';
import { AgentRegistry } from './agent-registry';
import { ApprovalsService } from './approvals.service';
import { CoordinatorEvents } from './coordinator-events';
import { MessagesService } from './messages.service';

const status = async () => ({ open: 0, capacity: 0, onTimePct: null });
const actor = (name: string, role: UserRole) => ({ id: `${name}-id`, name, role });

describe('ApprovalsService', () => {
  const { AgentMessage, Approval, DutyTitle } = models();
  let registry: AgentRegistry;
  let service: ApprovalsService;
  let decisions: string[];
  let failDecision: boolean;

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
    decisions = [];
    failDecision = false;
    registry = new AgentRegistry();
    registry.register({
      key: 'bed',
      messageTypes: [],
      approvalTypes: [
        {
          type: 'bed.needs-attention',
          agent: 'bed',
          roles: [UserRole.DOCTOR, UserRole.ADMIN],
          primary: { kind: 'approve', label: 'Confirm' },
          onDecision: async (id, decision) => {
            if (failDecision) throw new Error('boom');
            decisions.push(`${id}:${decision}`);
          },
        },
        { type: 'bed.screen', agent: 'bed', roles: [UserRole.DOCTOR], primary: { kind: 'open', label: 'Open request' } },
      ],
      status,
    });
    const messages = new MessagesService(AgentMessage, registry, new CoordinatorEvents());
    service = new ApprovalsService(Approval, DutyTitle, registry, messages);
  });

  const sent = (type: string) => AgentMessage.find({ type }).lean();

  test('request is idempotent for an open source and sends approval.requested', async () => {
    const a = await service.request({ type: 'bed.needs-attention', summary: 'Needs isolation', source: { kind: 'bed-request', id: 'r1' } });
    const b = await service.request({ type: 'bed.needs-attention', summary: 'Needs isolation', source: { kind: 'bed-request', id: 'r1' } });
    assert.equal(String(a._id), String(b._id));
    assert.equal(await Approval.countDocuments(), 1);
    assert.deepEqual(a.roles, [UserRole.DOCTOR, UserRole.ADMIN]);
    assert.equal(a.primary.kind, 'approve');
    const msgs: any[] = await sent('approval.requested');
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].priority, 'high');
    assert.deepEqual(msgs[0].to, ['bed']);
    assert.equal(msgs[0].payload.approvalType, 'bed.needs-attention');
    // No source: always a new one. Unknown type: refused.
    await service.request({ type: 'bed.needs-attention', summary: 'x' });
    await service.request({ type: 'bed.needs-attention', summary: 'x' });
    assert.equal(await Approval.countDocuments(), 3);
    await assert.rejects(() => service.request({ type: 'nope', summary: 'x' }), BadRequestException);
    // After it is decided, the same source may ask again.
    await service.markDone({ kind: 'bed-request', id: 'r1' }, 'Dr A');
    const c = await service.request({ type: 'bed.needs-attention', summary: 'again', source: { kind: 'bed-request', id: 'r1' } });
    assert.notEqual(String(c._id), String(a._id));
  });

  test("only the type's roles can approve; reassign changes who is asked, not who may act", async () => {
    await DutyTitle.create({ key: 'duty-administrator', label: 'Duty administrator', holders: [] });
    const doctor = actor('Dr Shajin', UserRole.DOCTOR);
    const nurse = actor('Nina', UserRole.NURSE);
    const admin = actor('Asha', UserRole.ADMIN);
    const a = await service.request({ type: 'bed.needs-attention', summary: 's' });
    const id = String(a._id);

    await assert.rejects(() => service.act(nurse, id, 'approved'), ForbiddenException);
    await assert.rejects(() => service.reassign(nurse, id, { kind: 'role', key: 'doctor' }, 'please'), ForbiddenException);
    await assert.rejects(() => service.reassign(doctor, id, { kind: 'role', key: 'doctor' }, '  '), BadRequestException);
    await assert.rejects(() => service.reassign(doctor, id, { kind: 'title', key: 'nope' }, 'n'), BadRequestException);
    await assert.rejects(() => service.reassign(doctor, id, { kind: 'role', key: 'wizard' }, 'n'), BadRequestException);

    await service.reassign(admin, id, { kind: 'title', key: 'duty-administrator' }, 'Over to the duty admin');
    let doc: any = await Approval.findById(id).lean();
    assert.deepEqual(doc.assignedTo, { kind: 'title', key: 'duty-administrator', label: 'Duty administrator' });
    assert.equal(doc.notes[0].text, 'Over to the duty admin');
    assert.equal(doc.notes[0].byName, 'Asha');
    await service.reassign(doctor, id, { kind: 'role', key: 'nurse' }, 'nurse to check');
    doc = await Approval.findById(id).lean();
    assert.equal(doc.assignedTo.label, 'Nurse');
    assert.deepEqual(doc.roles, [UserRole.DOCTOR, UserRole.ADMIN]);
    // The nurse was asked but still may not act.
    await assert.rejects(() => service.act(nurse, id, 'approved'), ForbiddenException);

    // A failing onDecision puts it back open.
    failDecision = true;
    await assert.rejects(() => service.act(doctor, id, 'approved'), /boom/);
    doc = await Approval.findById(id).lean();
    assert.equal(doc.state, 'open');
    assert.equal(doc.decidedByName, undefined);
    assert.equal((await sent('approval.decided')).length, 0);
    failDecision = false;

    await service.act(doctor, id, 'approved');
    doc = await Approval.findById(id).lean();
    assert.equal(doc.state, 'approved');
    assert.equal(doc.decidedByName, 'Dr Shajin');
    assert.deepEqual(decisions, [`${id}:approved`]);
    const decided: any[] = await sent('approval.decided');
    assert.equal(decided[0].payload.decision, 'approved');
    await assert.rejects(() => service.act(doctor, id, 'rejected'), ConflictException);
    await assert.rejects(() => service.reassign(doctor, id, { kind: 'role', key: 'nurse' }, 'late'), ConflictException);

    // An "open on its own screen" type cannot be decided here.
    const s = await service.request({ type: 'bed.screen', summary: 's' });
    await assert.rejects(() => service.act(doctor, String(s._id), 'approved'), ConflictException);
  });

  test('markDone closes an approval the owning agent decided on its screen', async () => {
    const a = await service.request({ type: 'bed.screen', summary: 's', source: { kind: 'bed-request', id: 'r9' } });
    assert.equal(await service.countOpen(), 1);
    assert.equal(await service.markDone({ kind: 'bed-request', id: 'nothing' }, 'X'), null);
    const done = await service.markDone({ kind: 'bed-request', id: 'r9' }, 'Dr Shajin');
    assert.equal(String(done!._id), String(a._id));
    const doc: any = await Approval.findById(a._id).lean();
    assert.equal(doc.state, 'done');
    assert.equal(doc.decidedByName, 'Dr Shajin');
    assert.ok(doc.decidedAt);
    assert.equal(await service.countOpen(), 0);
    assert.equal(await service.markDone({ kind: 'bed-request', id: 'r9' }, 'Dr Shajin'), null);
    const list = await service.list({ state: 'done' });
    assert.equal(list.length, 1);
    assert.equal(typeof list[0].id, 'string');
  });

  test('an approval whose type is no longer registered cannot be decided', async () => {
    const doc = await Approval.create({ type: 'gone.type', agent: 'bed', summary: 's', roles: [UserRole.DOCTOR], primary: { kind: 'approve', label: 'OK' }, state: 'open' });
    await assert.rejects(() => service.act(actor('Dr', UserRole.DOCTOR), String(doc._id), 'approved'), (e: unknown) => e instanceof ConflictException && e.message === 'This approval type is no longer available.');
    assert.equal(((await Approval.findById(doc._id).lean()) as any).state, 'open');
  });
});
