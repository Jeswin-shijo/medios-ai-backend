import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Logger } from '@nestjs/common';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { SettingsService } from '../settings/settings.service';
import { UserRole } from '../users/schemas/user.schema';
import { DEFAULT_FAQS, DEFAULT_TEMPLATES } from './support-texts';
import { SupportSettingsService } from './support-settings.service';
import { createMessageSender, SampleMessageSender } from './support-sender';
import { SupportTextsService } from './support-texts.service';

const ADMIN = { id: 'a1', name: 'Admin', role: UserRole.ADMIN };
const NURSE = { id: 'n1', name: 'Nurse', role: UserRole.NURSE };
const status = (code: number) => (e: any) => e?.status === code;

describe('SupportTextsService', () => {
  const m = models();
  let svc: SupportTextsService;

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    const settings = new SettingsService(m.HospitalSettings);
    await m.HospitalSettings.deleteMany({});
    await settings.getSettings();
    await m.HospitalSettings.updateOne({}, { $set: { 'hospital.name': "St. Mary's", 'hospital.phone': '04652 123456', 'hospital.address': 'Nagercoil' } });
    svc = new SupportTextsService(m.SupportTemplate, m.SupportFaq, settings, new SupportSettingsService(settings));
    await svc.ensureDefaults();
  });

  test('ensureDefaults twice keeps one of each and never overwrites an edit', async () => {
    await svc.saveTemplate(ADMIN, 'procedure-done', { en: 'Edited text.' });
    await svc.saveFaq(ADMIN, 'parking', { en: 'Edited parking.' });
    await svc.ensureDefaults();
    assert.equal(await m.SupportTemplate.countDocuments(), DEFAULT_TEMPLATES.length);
    assert.equal(await m.SupportFaq.countDocuments(), DEFAULT_FAQS.length);
    assert.equal((await m.SupportTemplate.findOne({ key: 'procedure-done' }))?.en, 'Edited text.');
    assert.equal((await m.SupportFaq.findOne({ topic: 'parking' }))?.en, 'Edited parking.');
  });

  test('render fills placeholders and reports the missing ones', async () => {
    const ok = await svc.render('transferred', 'en', {
      patient: 'A B',
      ward: 'HDU',
      bed: 'HDU-1',
      floor: 'floor 2',
      visiting: '4-6 PM',
      hospital: "St. Mary's"
    });
    assert.ok(ok);
    assert.deepEqual(ok.missing, []);
    assert.match(ok.text, /^A B has moved to HDU \(HDU-1, floor 2\)\. Visiting hours: 4-6 PM\./);
    const bad = await svc.render('transferred', 'en', { patient: 'A B', ward: '' });
    assert.ok(bad);
    assert.deepEqual(bad.missing.sort(), ['bed', 'floor', 'hospital', 'visiting', 'ward']);
    assert.equal(await svc.render('nope', 'en', {}), null);
  });

  test('instructions may be empty without holding', async () => {
    const r = await svc.render(
      'procedure-booked',
      'en',
      { patient: 'A B', procedure: 'Angiography', date: 'Monday', time: '8:30 AM', hospital: 'SM', instructions: '' },
      ['instructions']
    );
    assert.ok(r);
    assert.deepEqual(r.missing, []);
    assert.ok(!r.text.includes('  '));
    assert.ok(!r.text.includes('{'));
    assert.match(r.text, /8:30 AM\. – SM$/);
  });

  test('Tamil falls back to English when empty', async () => {
    await m.SupportTemplate.updateOne({ key: 'procedure-done' }, { $set: { ta: '' } });
    const r = await svc.render('procedure-done', 'ta', { patient: 'A B', procedure: 'Angiography', hospital: 'SM' });
    assert.ok(r);
    assert.equal(r.language, 'en');
    const t = await svc.render('admitted', 'ta', { patient: 'A', ward: 'W', bed: 'B', floor: 'f', visiting: 'v', hospital: 'h' });
    assert.equal(t?.language, 'ta');
  });

  test('an unapproved template renders null', async () => {
    await svc.saveTemplate(ADMIN, 'procedure-done', { approved: false });
    assert.equal(await svc.render('procedure-done', 'en', { patient: 'A', procedure: 'p', hospital: 'h' }), null);
  });

  test('findFaq by key, by keyword ("when can I visit"), and not found', async () => {
    const byKey = await svc.findFaq('parking', 'en');
    assert.equal(byKey.found, true);
    assert.equal(byKey.topic, 'parking');
    const visit = await svc.findFaq('when can I visit', 'en');
    assert.equal(visit.topic, 'visiting-hours');
    assert.ok(visit.text.includes((await new SupportSettingsService(new SettingsService(m.HospitalSettings)).get()).visitingHours));
    assert.ok(!visit.text.includes('{'));
    const dir = await svc.findFaq('Where is it', 'en');
    assert.ok(dir.text.includes("St. Mary's") && dir.text.includes('Nagercoil'));
    const nf = await svc.findFaq('quantum physics', 'en');
    assert.deepEqual(nf, { found: false, text: "I don't have that information. Offer to arrange a call back." });
    await svc.saveFaq(ADMIN, 'parking', { approved: false });
    assert.equal((await svc.findFaq('parking', 'en')).found, false);
    assert.equal((await svc.searchFaqs('visit')).length, 1);
  });

  test('a nurse cannot save a template', async () => {
    await assert.rejects(() => svc.saveTemplate(NURSE, 'procedure-done', { en: 'x' }), status(403));
    await assert.rejects(() => svc.saveFaq(NURSE, 'parking', { en: 'x' }), status(403));
    await assert.rejects(() => svc.addFaq(NURSE, { topic: 'lifts', title: 'Lifts', en: 'x' }), status(403));
    await assert.rejects(() => svc.saveTemplate(ADMIN, 'procedure-done', { en: 'x'.repeat(1001) }), status(400));
    await assert.rejects(() => svc.addFaq(ADMIN, { topic: 'Bad Topic', title: 'T', en: 'x' }), status(400));
    await svc.addFaq(ADMIN, { topic: 'lifts', title: 'Lifts', keywords: ['lift'], en: 'Lifts are near the entrance.' });
    assert.equal((await svc.findFaq('lift', 'en')).topic, 'lifts');
  });

  test('emergencyLine reads the row and falls back to the default', async () => {
    assert.match(await svc.emergencyLine('en'), /108/);
    await m.SupportTemplate.deleteOne({ key: 'emergency-line' });
    assert.match(await svc.emergencyLine('en'), /108/);
  });
});

describe('message sender', () => {
  test('the sample sender logs a masked number and the none sender is null', async () => {
    assert.equal(createMessageSender('none'), null);
    const s = createMessageSender('sample');
    assert.ok(s instanceof SampleMessageSender);
    const lines: string[] = [];
    const orig = Logger.prototype.log;
    Logger.prototype.log = function (msg: any) {
      lines.push(String(msg));
    };
    try {
      assert.deepEqual(await s!.send('+919876543210', 'x'.repeat(200)), { ok: true });
    } finally {
      Logger.prototype.log = orig;
    }
    assert.equal(lines.length, 1);
    assert.ok(lines[0].startsWith('SAMPLE MESSAGE to +91•••••43210: '));
    assert.ok(!lines[0].includes('9876543210'));
    assert.equal(lines[0].length, 'SAMPLE MESSAGE to +91•••••43210: '.length + 80);
  });
});
