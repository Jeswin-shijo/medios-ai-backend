import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DEFAULT_OWNER_BY_TYPE,
  DEFAULT_SUPPORT_CONFIG,
  OWNER_LADDER,
  OWNER_TITLE,
  OWNERS,
  SUPPORT_LADDERS,
  TICKET_TYPES,
  TRIGGERS,
  isCardiacDiagnosis,
  questionsFor
} from './support-catalogue';
import { DEFAULT_FAQS, DEFAULT_TEMPLATES } from './support-texts';
import { addWorkingMinutes, floorText, quietUntil, ticketDueAt } from './support-time';

/** A server-local moment. */
const at = (day: number, h: number, m = 0) => new Date(2026, 8, day, h, m, 0, 0);
const hm = (d: Date) => `${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

describe('support time', () => {
  test('addWorkingMinutes: 10:00 + 240 is 14:00; 02:00 + 240 is 12:00; 19:00 + 240 is 11:00 the next day; 20:00 + 60 is 09:00 the next day', () => {
    assert.equal(hm(addWorkingMinutes(at(26, 10), 240, '08:00', '20:00')), '26 14:00');
    assert.equal(hm(addWorkingMinutes(at(26, 2), 240, '08:00', '20:00')), '26 12:00');
    assert.equal(hm(addWorkingMinutes(at(26, 19), 240, '08:00', '20:00')), '27 11:00');
    assert.equal(hm(addWorkingMinutes(at(26, 20), 60, '08:00', '20:00')), '27 09:00');
  });

  test('quietUntil: 22:30 gives 07:00 next day; 03:00 gives 07:00 the same day; 07:00 and 20:59 give null', () => {
    assert.equal(hm(quietUntil(at(26, 22, 30), '21:00', '07:00')!), '27 07:00');
    assert.equal(hm(quietUntil(at(26, 3), '21:00', '07:00')!), '26 07:00');
    assert.equal(quietUntil(at(26, 7), '21:00', '07:00'), null);
    assert.equal(quietUntil(at(26, 20, 59), '21:00', '07:00'), null);
    // A window that does not cross midnight.
    assert.equal(hm(quietUntil(at(26, 13), '12:00', '14:00')!), '26 14:00');
    assert.equal(quietUntil(at(26, 15), '12:00', '14:00'), null);
  });

  test('ticketDueAt: urgent, clinical and complaint add 30 minutes at any hour; a normal billing ticket counts working hours', () => {
    const cfg = DEFAULT_SUPPORT_CONFIG;
    assert.equal(hm(ticketDueAt(at(26, 2), { priority: 'urgent', ticketType: 'billing' }, cfg)), '26 02:30');
    assert.equal(hm(ticketDueAt(at(26, 23), { priority: 'normal', ticketType: 'clinical' }, cfg)), '26 23:30');
    assert.equal(hm(ticketDueAt(at(26, 3), { priority: 'normal', ticketType: 'complaint' }, cfg)), '26 03:30');
    assert.equal(hm(ticketDueAt(at(26, 2), { priority: 'normal', ticketType: 'billing' }, cfg)), '26 12:00');
    assert.equal(hm(ticketDueAt(at(26, 19), { priority: 'normal', ticketType: 'billing' }, cfg)), '27 11:00');
  });

  test('floorText: 0 is ground floor, n is floor n', () => {
    assert.equal(floorText(0), 'ground floor');
    assert.equal(floorText(3), 'floor 3');
    assert.equal(floorText(null), '');
    assert.equal(floorText(undefined), '');
  });
});

describe('support catalogue', () => {
  test('every ticket type has a default owner and every owner a ladder', () => {
    for (const t of TICKET_TYPES) assert.ok((OWNERS as readonly string[]).includes(DEFAULT_OWNER_BY_TYPE[t]), t);
    for (const o of OWNERS) assert.ok(SUPPORT_LADDERS[OWNER_LADDER[o]], o);
    // An owner's own title leads its ladder (the front desk has none and starts at the Patient relations officer).
    for (const o of OWNERS) {
      const first = SUPPORT_LADDERS[OWNER_LADDER[o]][0].title;
      assert.equal(first, OWNER_TITLE[o] ?? 'patient-relations', o);
    }
    assert.deepEqual(DEFAULT_SUPPORT_CONFIG.ownerByType, DEFAULT_OWNER_BY_TYPE);
  });

  test("questionsFor('cardiac') adds antiplatelets and exertion after symptoms", () => {
    assert.deepEqual(
      questionsFor('cardiac').map((q) => q.key),
      ['medicines', 'symptoms', 'antiplatelets', 'exertion', 'followup', 'question', 'rating']
    );
    assert.deepEqual(
      questionsFor('general').map((q) => q.key),
      ['medicines', 'symptoms', 'followup', 'question', 'rating']
    );
  });

  test('isCardiacDiagnosis: "Inferior wall MI", "unstable angina", "post stent" yes; "mild fever" and "Mild illness" no', () => {
    for (const yes of ['Inferior wall MI', 'unstable angina', 'post stent']) assert.equal(isCardiacDiagnosis(yes), true, yes);
    for (const no of ['mild fever', 'Mild illness']) assert.equal(isCardiacDiagnosis(no), false, no);
  });

  test('every default template and FAQ has English and Tamil text, and every trigger has a template', () => {
    for (const t of DEFAULT_TEMPLATES) {
      assert.ok(t.en.length > 0 && t.ta.length > 0, t.key);
      // Tamil keeps every placeholder and the 108 number.
      const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();
      assert.deepEqual(names(t.ta), names(t.en), t.key);
      if (t.en.includes('108')) assert.ok(t.ta.includes('108'), t.key);
    }
    for (const f of DEFAULT_FAQS) {
      assert.ok(f.en.length > 0 && f.ta.length > 0 && f.keywords.length > 0, f.topic);
      const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();
      assert.deepEqual(names(f.ta), names(f.en), f.topic);
    }
    for (const trig of TRIGGERS)
      assert.ok(
        DEFAULT_TEMPLATES.some((t) => t.trigger === trig && t.key === trig),
        trig
      );
    assert.equal(DEFAULT_FAQS.length, 10);
    assert.equal(new Set(DEFAULT_TEMPLATES.map((t) => t.key)).size, DEFAULT_TEMPLATES.length);
    assert.equal(
      DEFAULT_TEMPLATES.find((t) => t.key === 'emergency-line')!.ta,
      'தயவுசெய்து உடனே அவசர சிகிச்சைப் பிரிவுக்கு வாருங்கள், அல்லது ஆம்புலன்சுக்கு 108 ஐ அழைக்கவும்.'
    );
  });
});
