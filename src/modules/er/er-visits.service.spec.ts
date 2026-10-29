import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { Actor } from '../beds/actor';
import { AgentRegistry } from '../coordinator/agent-registry';
import { CasesService } from '../coordinator/cases.service';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { MessagesService } from '../coordinator/messages.service';
import { PatientsService } from '../patients/patients.service';
import { PatientCardsService } from '../queue/patient-cards.service';
import { QueueService } from '../queue/queue.service';
import { TimelineService } from '../timeline/timeline.service';
import { UserRole } from '../users/schemas/user.schema';
import { ErCoordinatorRegistration } from './er-coordinator.registration';
import { ErVisitsService } from './er-visits.service';
import { PATHWAYS } from './er-rules';

const NURSE: Actor = { id: 'user-nurse', name: 'Nurse Anita', role: UserRole.NURSE };
const HOUR = 3_600_000;

describe('ErVisitsService', () => {
  const m = models();
  let registry: AgentRegistry;
  let messages: MessagesService;
  let service: ErVisitsService;
  let patientCount: number;

  const patient = async (name = 'Ravi Kumar') => {
    patientCount++;
    const phone = `9100000${String(patientCount).padStart(3, '0')}`;
    const p = await m.Patient.create({ uhid: `MHK2026009${String(patientCount).padStart(2, '0')}`, name, age: 52, gender: 'Male', phone });
    return { id: String(p._id), uhid: p.uhid, name, phone };
  };
  const sent = (type: string) => m.AgentMessage.find({ type }).lean().exec() as Promise<any[]>;

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
    patientCount = 0;
    registry = new AgentRegistry();
    new ErCoordinatorRegistration(registry).onModuleInit();
    messages = new MessagesService(m.AgentMessage, registry, new CoordinatorEvents());
    const cases = new CasesService(m.Case, m.CoordinatorCounter, messages, registry, new TimelineService(m.TimelineEvent));
    const patients = new PatientsService(m.Patient);
    // A card lookup never issues a queue token, so the queue service is not needed here.
    const cards = new PatientCardsService(m.PatientCard, m.Patient, null as unknown as QueueService);
    service = new ErVisitsService(m.ErVisit, m.ErExpected, m.CoordinatorCounter, m.Patient, patients, cards, cases, messages);
  });

  test('the ER agent registers its message types, clocks and rule', () => {
    const types = ['expected', 'arrived', 'triaged', 'retriaged', 'pathway-started', 'pathway-cancelled', 'step-done', 'doctor-seen', 'disposition', 'left'];
    for (const t of types) assert.equal(registry.messageType(`er.${t}`)?.agent, 'er', t);
    for (const k of ['er-triage', 'er-doctor', 'er-step-ecg', 'er-step-ct', 'er-step-last-known-well', 'er-step-cultures', 'er-step-antibiotics']) {
      assert.ok(registry.clock(k), k);
    }
    assert.equal(registry.clock('er-step-doctor'), undefined);
    assert.ok(registry.rules().some((r) => r.key === 'er-auto-pathways'));
    // Step clocks only react to their own pathway and step.
    const ct = registry.clock('er-step-ct')!;
    assert.equal(ct.match!('er.pathway-started', { pathway: 'stroke' }), true);
    assert.equal(ct.match!('er.pathway-started', { pathway: 'sepsis' }), false);
    assert.equal(ct.match!('er.step-done', { step: 'ecg' }), false);
    assert.equal(ct.label, PATHWAYS.stroke.steps.find((s) => s.key === 'ct')!.label);
    const due = new Date(Date.now() + HOUR);
    assert.equal(ct.dueFrom!({ stepDue: { ct: due.toISOString() } })!.getTime(), due.getTime());
    assert.deepEqual(registry.clock('er-doctor')!.updateOn, ['er.retriaged', 'er.pathway-started', 'er.pathway-cancelled']);
  });

  test('arrival by UHID opens a visit and a case and sends er.arrived', async () => {
    const p = await patient();
    const view = await service.arrive(NURSE, { uhid: p.uhid, mode: 'walk-in', complaint: 'chest-pain' });

    assert.equal(view.number, 'ER-0001');
    assert.equal(view.status, 'waiting-triage');
    assert.equal(view.patientUhid, p.uhid);
    assert.equal(view.bayName, null);
    assert.equal(view.colour, null);
    assert.equal(typeof view.arrivedAt, 'string');

    const c: any = await m.Case.findOne().lean();
    assert.equal(c.kind, 'er');
    assert.equal(c.priority, 'medium');
    assert.equal(c.openedBy, 'er');
    assert.equal(String(c._id), view.caseId);

    const arrived = await sent('er.arrived');
    assert.equal(arrived.length, 1);
    assert.equal(String(arrived[0].case), String(c._id));
    assert.equal(arrived[0].payload.visitNumber, 'ER-0001');
    assert.ok(arrived[0].summary.includes('ER-0001') && arrived[0].summary.includes('Chest pain'));
    assert.ok(!JSON.stringify(arrived).includes(p.name), 'the name must not be in the message');

    const other = await patient('Latha Devi');
    assert.equal((await service.arrive(NURSE, { patientId: other.id, mode: 'ambulance', complaint: 'fever' })).number, 'ER-0002');
  });

  test('an emergency arrival creates a details-pending placeholder patient', async () => {
    const view = await service.arrive(NURSE, {
      emergency: { gender: 'Female', approxAge: 40, description: 'Red sari, found near the bus stand' },
      mode: 'ambulance',
      complaint: 'unresponsive',
    });
    assert.equal(view.patientName, 'Unknown female, ER-0001');
    const p: any = await m.Patient.findOne({ uhid: view.patientUhid }).lean();
    assert.equal(p.name, 'Unknown female, ER-0001');
    assert.equal(p.detailsPending, true);
    assert.equal(p.phone, '');
    assert.equal(p.age, 40);
    assert.equal(p.gender, 'Female');
    assert.match(p.uhid, /^MHK\d{9}$/);
    // The Patient schema has no free-text field, so the description lands on the visit.
    assert.equal(view.complaintText, 'Red sari, found near the bus stand');

    const male = await service.arrive(NURSE, { emergency: { gender: 'Male', approxAge: 30, description: 'x' }, mode: 'walk-in', complaint: 'seizure' });
    assert.equal(male.patientName, 'Unknown male, ER-0002');
    const other = await service.arrive(NURSE, { emergency: { gender: 'Other', approxAge: 30, description: 'x' }, mode: 'walk-in', complaint: 'seizure', complaintText: 'Fitting' });
    assert.equal(other.patientName, 'Unknown person, ER-0003');
    assert.equal(other.complaintText, 'Fitting');

    // Normal patients still need a phone.
    await assert.rejects(m.Patient.create({ uhid: 'MHK2026000999', name: 'No Phone', age: 30, gender: 'Male' }), /phone/);
  });

  test('arrival needs exactly one way to identify the patient', async () => {
    const p = await patient();
    await assert.rejects(service.arrive(NURSE, { mode: 'walk-in', complaint: 'fever' }), /exactly one/i);
    await assert.rejects(service.arrive(NURSE, { uhid: p.uhid, patientId: p.id, mode: 'walk-in', complaint: 'fever' }), /exactly one/i);
    await assert.rejects(service.arrive(NURSE, { uhid: 'MHK0000', mode: 'walk-in', complaint: 'fever' }), /not found/i);
    assert.equal(await m.ErVisit.countDocuments(), 0);
  });

  test('two arrivals for the same patient at once give one visit and one case', async () => {
    const p = await patient();
    const [a, b] = await Promise.all([
      service.arrive(NURSE, { uhid: p.uhid, mode: 'walk-in', complaint: 'chest-pain' }),
      service.arrive(NURSE, { patientId: p.id, mode: 'walk-in', complaint: 'chest-pain' }),
    ]);
    assert.equal(a.id, b.id);
    assert.equal(await m.ErVisit.countDocuments(), 1);
    assert.equal(await m.Case.countDocuments(), 1);
    assert.equal((await sent('er.arrived')).length, 1);
    assert.equal((await service.arrive(NURSE, { uhid: p.uhid, mode: 'walk-in', complaint: 'fever' })).id, a.id);
    assert.equal((await sent('er.arrived')).length, 1);
  });

  test('a card tap finds the patient without issuing a queue token', async () => {
    const p = await patient();
    await m.PatientCard.create({ cardId: '04A1B2C3', uhid: p.uhid, linkedBy: 'test' });
    const view = await service.arrive(NURSE, { cardId: '04:a1:b2:c3', mode: 'walk-in', complaint: 'fever' });
    assert.equal(view.patientUhid, p.uhid);
    const card: any = await m.PatientCard.findOne().lean();
    assert.equal(card.lastUsedAt, undefined);
    await assert.rejects(service.arrive(NURSE, { cardId: 'FFFFFFFF', mode: 'walk-in', complaint: 'fever' }), /not registered/);
    assert.equal(await m.ErVisit.countDocuments(), 1);
  });

  test('an expected arrival is marked arrived when picked and expires after 2 hours', async () => {
    const p = await patient();
    const picked = await service.addExpected(NURSE, { complaint: 'Road accident, 30M', ageSex: '30 M', mode: 'ambulance', etaMinutes: 10, phone: p.phone });
    assert.equal(picked.state, 'waiting');
    assert.equal(picked.patientId, p.id, 'a phone matching exactly one patient links them');
    const stale = await service.addExpected(NURSE, { complaint: 'Fever', ageSex: '5 F', mode: 'referred', etaMinutes: 30 });
    assert.equal(stale.patientId, null);
    assert.equal((await service.board()).expected.length, 2);

    await service.arrive(NURSE, { patientId: p.id, mode: 'ambulance', complaint: 'major-trauma', expectedId: picked.id });
    assert.equal(((await m.ErExpected.findById(picked.id).lean()) as any).state, 'arrived');
    assert.deepEqual((await service.board()).expected.map((e) => e.id), [stale.id]);

    const expectedAt = new Date(stale.expectedAt).getTime();
    assert.equal(await service.expireExpected(new Date(expectedAt + 2 * HOUR)), 0, 'exactly 2 hours is not yet expired');
    assert.equal(await service.expireExpected(new Date(expectedAt + 2 * HOUR + 1000)), 1);
    assert.equal(((await m.ErExpected.findById(stale.id).lean()) as any).state, 'expired');
    assert.equal((await service.board()).expected.length, 0);
    const exp = await sent('er.expected');
    assert.equal(exp.length, 2);
    assert.equal(exp[0].case, null);
  });

  test('the board lists open visits, untriaged first, then by colour and arrival', async () => {
    const [a, b, c, d] = [await patient('A One'), await patient('B Two'), await patient('C Three'), await patient('D Four')];
    const va = await service.arrive(NURSE, { patientId: a.id, mode: 'walk-in', complaint: 'fever' });
    const vb = await service.arrive(NURSE, { patientId: b.id, mode: 'walk-in', complaint: 'fever' });
    const vc = await service.arrive(NURSE, { patientId: c.id, mode: 'walk-in', complaint: 'fever' });
    const at = (colour: string) => ({ suggested: colour, reasons: [], colour, byName: 'x', at: new Date() });
    await m.ErVisit.updateOne({ _id: va.id }, { triage: at('green'), status: 'waiting-doctor' });
    await m.ErVisit.updateOne({ _id: vb.id }, { triage: at('red'), status: 'waiting-doctor' });
    await m.ErVisit.updateOne({ _id: vc.id }, { status: 'left' });
    const board = await service.board();
    assert.deepEqual(board.visits.map((v) => v.id), [vb.id, va.id]);
    assert.equal(board.visits[0].colour, 'red');
    const vd = await service.arrive(NURSE, { patientId: d.id, mode: 'walk-in', complaint: 'fever' });
    assert.equal((await service.board()).visits[0].id, vd.id, 'untriaged first');
    assert.equal((await service.get(vd.id)).id, vd.id);
  });
});
