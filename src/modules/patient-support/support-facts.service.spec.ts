import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { TimelineService } from '../timeline/timeline.service';
import { UserRole } from '../users/schemas/user.schema';
import { SupportFactsService } from './support-facts.service';

const NURSE = { id: 'n1', name: 'Front Desk', role: UserRole.STAFF };
const PHARMA = { id: 'p1', name: 'Pharm', role: UserRole.PHARMACIST };
const status = (code: number) => (e: any) => e?.status === code;
const oid = () => new Types.ObjectId();
/** Inserts a record without validation: the specs only need the fields the service reads. */
const raw = async (model: any, doc: Record<string, unknown>) => (await model.insertMany([doc], { lean: true }))[0];

describe('SupportFactsService', () => {
  const m = models();
  let svc: SupportFactsService;
  let patientId: string;
  let patient: any;

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    svc = new SupportFactsService(
      m.Patient,
      m.Admission,
      m.Bed,
      m.Ward,
      m.ProcedureBooking,
      m.ErVisit,
      m.DischargeOrder,
      m.DischargePlan,
      m.Case,
      new TimelineService(m.TimelineEvent)
    );
    patient = await m.Patient.create({ uhid: 'MHK1', name: 'Asha K', age: 40, gender: 'Female', phone: '9876543210' });
    patientId = String(patient._id);
  });

  test('saveContact records consent with who and when, and writes one Communication timeline line', async () => {
    const view = await svc.saveContact(NURSE, patientId, {
      contacts: [{ name: 'Ravi', relation: 'Son', phone: '+91 98765-43211' }],
      updatesToIndex: 0,
      consent: { messages: true, calls: false },
      via: 'ward'
    });
    assert.equal(view.consent.messages, true);
    assert.equal(view.consent.calls, false);
    assert.equal(view.consent.recordedByName, 'Front Desk');
    assert.equal(view.consent.via, 'ward');
    assert.ok(view.consent.recordedAt instanceof Date);
    assert.equal(view.updatesTo, view.contacts[0].id);
    const lines = await m.TimelineEvent.find({ uhid: 'MHK1' }).lean();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].category, 'Communication');
    assert.equal(lines[0].status, 'Completed');
    assert.equal(lines[0].title, 'Contact and consent updated by Front Desk');

    // Nothing changed: no new line, and the stamp stays.
    const again = await svc.saveContact(NURSE, patientId, { consent: { messages: true, calls: false }, via: 'desk' });
    assert.equal(await m.TimelineEvent.countDocuments({ uhid: 'MHK1' }), 1);
    assert.equal(again.consent.via, 'ward');
    // Only a language change: a line, but the consent stamp is not touched.
    const lang = await svc.saveContact(NURSE, patientId, { preferredLanguage: 'ta' });
    assert.equal(lang.preferredLanguage, 'ta');
    assert.equal(await m.TimelineEvent.countDocuments({ uhid: 'MHK1' }), 2);
    assert.equal(lang.consent.via, 'ward');
  });

  test('a patient saved before consent existed reads as no consent', async () => {
    await m.Patient.collection.updateOne({ _id: patient._id }, { $unset: { consent: '', contacts: '', updatesTo: '', preferredLanguage: '' } });
    const v = await svc.contactOf(patientId);
    assert.deepEqual([v.consent.messages, v.consent.calls, v.contacts, v.updatesTo, v.preferredLanguage], [false, false, [], 'self', 'en']);
  });

  test('updatesTo must name an existing contact', async () => {
    await assert.rejects(svc.saveContact(NURSE, patientId, { updatesTo: String(oid()) }), status(400));
    await assert.rejects(
      svc.saveContact(NURSE, patientId, { contacts: [{ name: 'Ravi', relation: 'Son', phone: '9876543211' }], updatesTo: 'self', updatesToIndex: 0 }),
      status(400)
    );
    const v = await svc.saveContact(NURSE, patientId, { contacts: [{ name: 'Ravi', relation: 'Son', phone: '9876543211' }] });
    await svc.saveContact(NURSE, patientId, { updatesTo: v.contacts[0].id });
    assert.equal((await svc.contactOf(patientId)).updatesTo, v.contacts[0].id);
    // Removing that contact puts updates back to the patient.
    assert.equal((await svc.saveContact(NURSE, patientId, { contacts: [] })).updatesTo, 'self');
    await assert.rejects(svc.saveContact(PHARMA, patientId, { preferredLanguage: 'en' }), status(403));
  });

  test('a bad contact phone is refused', async () => {
    for (const phone of ['12345', '5876543210', '98765 4321', 'abcdefghij']) {
      await assert.rejects(
        svc.saveContact(NURSE, patientId, { contacts: [{ name: 'Ravi', relation: 'Son', phone }] }),
        (e: any) => e.status === 400 && /Enter a 10-digit mobile number for Ravi\./.test(e.message)
      );
    }
    await svc.saveContact(NURSE, patientId, { contacts: [{ name: 'Ravi', relation: 'Son', phone: '919876543211' }] });
    assert.equal(await m.TimelineEvent.countDocuments({ uhid: 'MHK1' }), 1);
  });

  test('recipientOf: self, a contact, and a removed contact', async () => {
    assert.deepEqual(svc.recipientOf((await m.Patient.findById(patientId)) as any), { to: '+919876543210', label: 'Self' });
    const v = await svc.saveContact(NURSE, patientId, { contacts: [{ name: 'Ravi', relation: 'Son', phone: '98765 43211' }], updatesToIndex: 0 });
    assert.deepEqual(svc.recipientOf((await m.Patient.findById(patientId)) as any), { to: '+919876543211', label: 'Son (Ravi)' });
    await m.Patient.updateOne({ _id: patient._id }, { $set: { contacts: [] } });
    assert.equal(v.updatesTo.length, 24);
    const r = svc.recipientOf((await m.Patient.findById(patientId)) as any);
    assert.equal(r.to, null);
    await m.Patient.updateOne({ _id: patient._id }, { $set: { updatesTo: 'self', phone: '123' } });
    assert.equal(svc.recipientOf((await m.Patient.findById(patientId)) as any).to, null);
  });

  test('isDeceased: by status, by an ER died disposition, by a died discharge order, and false for a cancelled one', async () => {
    assert.equal(await svc.isDeceased(patientId), false);
    const order = await raw(m.DischargeOrder, { patient: patient._id, kind: 'died', state: 'cancelled' });
    assert.equal(await svc.isDeceased(patientId), false);
    await m.DischargeOrder.updateOne({ _id: order._id }, { $set: { state: 'ordered' } });
    assert.equal(await svc.isDeceased(patientId), true);
    await m.DischargeOrder.deleteMany({});
    assert.equal(await svc.isDeceased(patientId), false);
    await raw(m.ErVisit, { patient: patient._id, disposition: { kind: 'died' } });
    assert.equal(await svc.isDeceased(patientId), true);
    await m.ErVisit.deleteMany({});
    await raw(m.DischargePlan, { patient: patient._id, completedKind: 'died' });
    assert.equal(await svc.isDeceased(patientId), true);
    await m.DischargePlan.deleteMany({});
    await m.Patient.updateOne({ _id: patient._id }, { $set: { status: 'Deceased' } });
    assert.equal(await svc.isDeceased(patientId), true);
    assert.equal(await svc.isDeceased(String(oid())), false);
  });

  test('careGroup: an angiography booking, the chest-pain pathway, a Cardiology admission, an MI diagnosis, and otherwise general', async () => {
    const caseId = oid();
    const other = oid();
    assert.equal(await svc.careGroup(patientId, String(caseId)), 'general');
    assert.equal(await svc.careGroup(patientId, null), 'general');

    const b = await raw(m.ProcedureBooking, { patient: patient._id, case: caseId, procedure: 'coronary-angiography', status: 'cancelled' });
    assert.equal(await svc.careGroup(patientId, String(caseId)), 'general');
    await m.ProcedureBooking.updateOne({ _id: b._id }, { $set: { status: 'booked' } });
    assert.equal(await svc.careGroup(patientId, String(caseId)), 'cardiac');
    assert.equal(await svc.careGroup(patientId, String(other)), 'general');
    assert.equal(await svc.careGroup(patientId, null), 'cardiac');
    await m.ProcedureBooking.deleteMany({});

    const v = await raw(m.ErVisit, { patient: patient._id, case: caseId, pathways: [{ key: 'chest-pain', cancelled: { reason: 'x' } }] });
    assert.equal(await svc.careGroup(patientId, String(caseId)), 'general');
    await m.ErVisit.updateOne({ _id: v._id }, { $set: { pathways: [{ key: 'chest-pain' }] } });
    assert.equal(await svc.careGroup(patientId, String(caseId)), 'cardiac');
    await m.ErVisit.deleteMany({});

    const adm = await raw(m.Admission, { patient: patient._id, department: 'Cardiology', status: 'active' });
    await raw(m.Case, { patient: patient._id, refs: { admissionId: String(adm._id) } });
    const c = await m.Case.findOne().lean();
    assert.equal(await svc.careGroup(patientId, String(c!._id)), 'cardiac');
    assert.equal(await svc.careGroup(patientId, null), 'cardiac');
    await m.Admission.deleteMany({});
    await m.Case.deleteMany({});

    const o = await raw(m.DischargeOrder, { patient: patient._id, case: caseId, diagnosis: 'Fracture of femur' });
    assert.equal(await svc.careGroup(patientId, String(caseId)), 'general');
    await m.DischargeOrder.updateOne({ _id: o._id }, { $set: { diagnosis: 'Acute MI, stable' } });
    assert.equal(await svc.careGroup(patientId, String(caseId)), 'cardiac');
  });

  test('bedFacts reads ward, bed, floor and sample; the timeline helper never throws', async () => {
    const ward = await raw(m.Ward, { name: 'HDU', floor: 0 });
    const bed = await raw(m.Bed, { ward: ward._id, label: 'HDU-1' });
    const adm = await raw(m.Admission, { patient: patient._id, bed: bed._id, sample: true });
    assert.deepEqual(await svc.bedFacts(String(adm._id)), { ward: 'HDU', bed: 'HDU-1', floor: 'ground floor', sample: true });
    assert.equal(await svc.bedFacts(String(oid())), null);
    await svc.timeline({ patientUhid: 'MHK1' }, 'Ticket SP-0001 opened: Billing', 'x');
    assert.equal(await m.TimelineEvent.countDocuments({ uhid: 'MHK1', category: 'Communication' }), 1);
    await svc.timeline({ patientUhid: '' }, '', ''); // invalid: logged, not thrown
  });
});
