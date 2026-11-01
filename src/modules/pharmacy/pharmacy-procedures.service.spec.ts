import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { DOC, World, aspirin300, buildWorld, clopidogrel300 } from '../../test/pharmacy-fixtures';
import { clinicNow } from '../../common/utils/clinic-time';
import { LineInput } from './pharmacy-orders.service';

const metformin500: LineInput = { medicine: 'metformin', product: 'metformin-tab-500', dose: 500, route: 'oral', frequency: 'BD', durationDays: 30 };

describe('Pharmacy checks around procedures', () => {
  const m = models();
  let w: World;
  let caseId: string;
  let seq = 0;
  // A clinic-clock Date: tomorrow at 14:05.
  const start = (() => {
    const d = clinicNow();
    d.setDate(d.getDate() + 1);
    d.setHours(14, 5, 0, 0);
    return d;
  })();
  const when = `${start.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][start.getMonth()]}, 2:05 PM`;
  const text = (at: string) => `Contrast dye on ${at}: hold metformin on the day and for 48 hours after; check kidney function first`;

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    w = await buildWorld(m);
    const P = { bookingId: 'string', number: 'string', procedure: 'string', priority: 'string', status: 'string' } as const;
    const t = (type: string, payload: Record<string, 'string' | 'date' | 'boolean'>) => ({ type: `scheduling.${type}`, agent: 'scheduling' as const, description: 'x', payload });
    w.registry.register({
      key: 'scheduling',
      messageTypes: [
        t('procedure-booked', { ...P, room: 'string', start: 'date', contrast: 'boolean' }),
        t('procedure-bumped', P),
        t('procedure-cancelled', P),
        t('procedure-done', P),
      ],
      closeChecks: [],
      status: async () => ({ open: 0, capacity: 0, onTimePct: null }),
    });
    caseId = String((await w.openEr()).case._id);
  });

  const send = (type: string, bookingId: string, extra: Record<string, unknown> = {}) =>
    w.messages.send({
      case: caseId, from: 'scheduling', to: ['pharmacy'], type: `scheduling.procedure-${type}`, priority: 'medium', summary: 'x',
      payload: { bookingId, number: 'PR-0001', procedure: 'coronary-angiography', priority: 'routine', status: type, ...extra },
      dedupeKey: `scheduling.procedure-${type}:${bookingId}:${++seq}`,
    });
  const booked = (bookingId = 'b1', extra: Record<string, unknown> = {}) => send('booked', bookingId, { room: 'Cath lab 1', start, contrast: true, ...extra });
  const flagsOf = async (id: string) => ((await w.lineDoc(id)).flags as { key: string; kind: string; severity: string; text: string }[]).filter((f) => f.kind === 'procedure');
  const alerts = (link: string) => m.TaskAlertItem.find({ link }).lean().exec() as Promise<any[]>;

  test('a booked contrast procedure puts the amber contrast flag on the patient\'s metformin line, and a full recheck keeps it', async () => {
    const v = await w.orders.order(DOC, { patientId: w.patientId, priority: 'routine', lines: [metformin500, aspirin300] });
    const [met, asp] = [v.lines.find((l) => l.medicine === 'metformin')!, v.lines.find((l) => l.medicine === 'aspirin')!];
    assert.deepEqual(await flagsOf(met.id), []);

    await booked();
    const flags = await flagsOf(met.id);
    assert.equal(flags.length, 1);
    assert.deepEqual([flags[0].key, flags[0].severity, flags[0].text], ['procedure.contrast', 'amber', text(when)]);
    assert.deepEqual(await flagsOf(asp.id), []);

    const [alert] = await alerts('pharmacy-contrast:b1');
    assert.deepEqual([alert.type, alert.category, alert.priority, alert.status, alert.subtitle], ['Medication Alert', 'System', 'Medium', 'Pending', 'For Dr. Shajin · PR-0001']);
    assert.equal((await alerts('pharmacy-contrast:b1')).length, 1);

    // A later, unrelated full recheck does not drop it.
    await w.orders.recheckPatient(w.patientId, 'order');
    assert.equal((await flagsOf(met.id)).length, 1);
    // Delivering the booking again adds no second alert.
    await booked();
    assert.equal((await alerts('pharmacy-contrast:b1')).length, 1);
  });

  test('cancelling the booking removes the flag and completes the alert; a bump does the same and a re-booking restores it at the new time', async () => {
    const v = await w.orders.order(DOC, { patientId: w.patientId, priority: 'routine', lines: [metformin500] });
    const id = v.lines[0].id;
    await booked();
    assert.equal((await flagsOf(id)).length, 1);
    await send('cancelled', 'b1');
    assert.deepEqual(await flagsOf(id), []);
    assert.equal((await alerts('pharmacy-contrast:b1'))[0].status, 'Completed');

    await booked('b2');
    assert.equal((await flagsOf(id)).length, 1);
    await send('bumped', 'b2');
    assert.deepEqual(await flagsOf(id), []);
    assert.equal((await alerts('pharmacy-contrast:b2'))[0].status, 'Completed');

    const later = new Date(start.getTime() + 2 * 86_400_000);
    await booked('b2', { start: later });
    const flags = await flagsOf(id);
    assert.equal(flags.length, 1);
    assert.ok(flags[0].text.startsWith(`Contrast dye on ${later.getDate()} `));
    assert.equal((await alerts('pharmacy-contrast:b2'))[0].status, 'Pending');
  });

  test('a non-contrast procedure adds nothing', async () => {
    const v = await w.orders.order(DOC, { patientId: w.patientId, priority: 'routine', lines: [metformin500] });
    await booked('b3', { procedure: 'chest-xray', contrast: false });
    assert.deepEqual(await flagsOf(v.lines[0].id), []);
    assert.equal(await m.TaskAlertItem.countDocuments({ link: /^pharmacy-contrast:/ }), 0);
  });

  test('angioplasty done with aspirin and clopidogrel active gives no alert; with aspirin only, one High alert', async () => {
    const both = await w.orders.order(DOC, { patientId: w.patientId, priority: 'stat', lines: [aspirin300, clopidogrel300] });
    await send('done', 'b4', { procedure: 'coronary-angioplasty' });
    assert.equal(await m.TaskAlertItem.countDocuments({ link: 'pharmacy-dapt:b4' }), 0);
    // A done angiography is not a stent.
    await send('done', 'b5', { procedure: 'coronary-angiography' });
    assert.equal(await m.TaskAlertItem.countDocuments({ link: 'pharmacy-dapt:b5' }), 0);

    // The clopidogrel is stopped: aspirin alone is not dual therapy.
    await m.PharmacyLine.updateOne({ _id: both.lines.find((l) => l.medicine === 'clopidogrel')!.id }, { $set: { status: 'stopped' } });
    await send('done', 'b6', { procedure: 'coronary-angioplasty' });
    await send('done', 'b6', { procedure: 'coronary-angioplasty' });
    const found = await alerts('pharmacy-dapt:b6');
    assert.equal(found.length, 1);
    assert.deepEqual(
      [found[0].title, found[0].subtitle, found[0].type, found[0].category, found[0].priority],
      ['No dual antiplatelet medicines after the stent (PR-0001). Please review.', 'PR-0001', 'Medication Alert', 'Critical', 'High'],
    );
  });
});
