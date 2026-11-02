import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Types } from 'mongoose';
import { clinicNow, isoDate } from '../../common/utils/clinic-time';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { EscalationsService } from '../coordinator/escalations.service';
import { MessagesService } from '../coordinator/messages.service';
import { AgentRegistry } from '../coordinator/agent-registry';
import { SettingsService } from '../settings/settings.service';
import { UserRole } from '../users/schemas/user.schema';
import { SchedulingRosterService } from './scheduling-roster.service';
import { SchedulingSettingsService } from './scheduling-settings.service';

const ADMIN = { id: 'a1', name: 'Admin', role: UserRole.ADMIN };
const at = (iso: string) => new Date(iso); // local time, no zone suffix

describe('SchedulingRosterService', () => {
  const m = models();
  let roster: SchedulingRosterService;
  let escalations: EscalationsService;
  let settings: SchedulingSettingsService;

  const user = (name: string, email: string) => m.User.create({ email, passwordHash: 'x', name, role: 'nurse' });
  const staff = (name: string, skills: string[], departmentCode: string, userId?: string) =>
    roster.upsertStaff(ADMIN, { name, skills, departmentCode, userId });
  const entry = (date: string, shift: any, staffId: unknown, extra: Record<string, unknown> = {}) =>
    roster.setEntry(ADMIN, { date, shift, staffId: String(staffId), ...extra });

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    settings = new SchedulingSettingsService(new SettingsService(m.HospitalSettings));
    const events = new CoordinatorEvents();
    const messages = new MessagesService(m.AgentMessage, new AgentRegistry(), events);
    escalations = new EscalationsService(m.Escalation, m.DutyTitle, m.Ladder, m.TaskAlertItem, m.User, messages, events);
    await escalations.ensureDefaults();
    roster = new SchedulingRosterService(m.StaffMember, m.RosterEntry, settings, escalations, m.User);
  });

  test('the roster finds who is on duty at 02:00 from a night entry of the day before', async () => {
    const nurse = await staff('Anu', ['ward-nurse'], 'GM');
    const early = await staff('Bina', ['ward-nurse'], 'GM');
    await entry('2026-09-26', 'night', nurse._id);
    await entry('2026-09-27', 'morning', early._id);

    const two = await roster.onDuty(at('2026-09-27T02:00:00'));
    assert.deepEqual(two.map((d) => d.name), ['Anu']);
    assert.equal(two[0].shift, 'night');
    assert.deepEqual(two[0].window, { start: at('2026-09-26T20:00:00'), end: at('2026-09-27T08:00:00') });
    // The window is half-open: 08:00 belongs to the morning shift, not to the night one.
    assert.deepEqual((await roster.onDuty(at('2026-09-27T08:00:00'))).map((d) => d.name), ['Bina']);
    assert.deepEqual((await roster.onDuty(at('2026-09-26T21:00:00'))).map((d) => d.name), ['Anu']);
    assert.deepEqual(await roster.onDuty(at('2026-09-27T14:00:00')), []);
  });

  test('onDuty reads the edited shift times, leaves on-call out unless asked, and skips inactive staff', async () => {
    const a = await staff('Anu', ['ward-nurse'], 'GM');
    const b = await staff('Bina', ['ward-nurse'], 'GM');
    const c = await staff('Chitra', ['ward-nurse'], 'GM');
    await entry('2026-09-26', 'night', a._id);
    await entry('2026-09-27', 'on-call', b._id);
    await entry('2026-09-27', 'morning', c._id);
    await settings.save(ADMIN, { shifts: { night: { start: '22:00', end: '06:00' } } });
    assert.deepEqual(await roster.onDuty(at('2026-09-27T06:30:00')), [], 'the edited night shift ends at 06:00');
    assert.deepEqual((await roster.onDuty(at('2026-09-27T05:00:00'))).map((d) => d.name), ['Anu']);
    assert.deepEqual((await roster.onDuty(at('2026-09-27T09:00:00'))).map((d) => d.name), ['Chitra']);
    assert.deepEqual((await roster.onDuty(at('2026-09-27T09:00:00'), { onCall: true })).map((d) => d.name), ['Bina', 'Chitra']);
    await roster.upsertStaff(ADMIN, { id: String(c._id), name: 'Chitra', skills: ['ward-nurse'], departmentCode: 'GM', active: false });
    assert.deepEqual((await roster.onDuty(at('2026-09-27T09:00:00'))).map((d) => d.name), []);
  });

  test('a title held on a roster entry becomes the escalation holder while the entry covers now, and the fixed holders return after it ends', async () => {
    roster.onModuleInit();
    const fixed = await user('Fixed Fiona', 'fiona@x.test');
    const rostered = await user('Rostered Ravi', 'ravi@x.test');
    await m.DutyTitle.updateOne({ key: 'ot-in-charge' }, { holders: [fixed._id] });
    assert.deepEqual((await escalations.holders('ot-in-charge')).names, ['Fixed Fiona']);

    const person = await staff('Ravi', ['ot-nurse'], 'OT', String(rostered._id));
    const day = isoDate(clinicNow());
    const yesterday = isoDate(new Date(clinicNow().getTime() - 86_400_000));
    // Two on-call entries cover the whole of today whatever the time.
    const e1 = await entry(yesterday, 'on-call', person._id, { titles: ['ot-in-charge'] });
    const e2 = await entry(day, 'on-call', person._id, { titles: ['ot-in-charge'] });
    assert.deepEqual((await escalations.holders('ot-in-charge')).names, ['Rostered Ravi']);
    assert.deepEqual((await escalations.holders('duty-doctor')).names.includes('Rostered Ravi'), false);

    await roster.removeEntry(ADMIN, String(e1._id));
    await roster.removeEntry(ADMIN, String(e2._id));
    assert.deepEqual((await escalations.holders('ot-in-charge')).names, ['Fixed Fiona']);
    // An entry three days old no longer covers now.
    await entry(isoDate(new Date(clinicNow().getTime() - 3 * 86_400_000)), 'on-call', person._id, { titles: ['ot-in-charge'] });
    assert.deepEqual((await escalations.holders('ot-in-charge')).names, ['Fixed Fiona']);
  });

  test('titleHolders returns login ids covering the moment, or null; a title needs a login', async () => {
    const u = await user('Uma', 'uma@x.test');
    const withLogin = await staff('Uma', ['physician'], 'GM', String(u._id));
    const noLogin = await staff('Nolan', ['physician'], 'GM');
    await entry('2026-09-26', 'morning', withLogin._id, { titles: ['duty-doctor'] });
    await assert.rejects(() => entry('2026-09-26', 'morning', noLogin._id, { titles: ['duty-doctor'] }), /login/);
    await entry('2026-09-26', 'morning', noLogin._id);
    assert.deepEqual(await roster.titleHolders('duty-doctor', at('2026-09-26T09:00:00')), [String(u._id)]);
    assert.equal(await roster.titleHolders('duty-doctor', at('2026-09-26T15:00:00')), null);
    assert.equal(await roster.titleHolders('ot-in-charge', at('2026-09-26T09:00:00')), null);
  });

  test('onCall falls back from an on-call entry to a department doctor on shift, then null', async () => {
    const cardio = await user('Dr Cara', 'cara@x.test');
    const cardio2 = await user('Dr Dev', 'dev@x.test');
    const nurseU = await user('Nia', 'nia@x.test');
    const dayDoc = await staff('Dr Cara', ['cardiologist'], 'CARD', String(cardio._id));
    const onCallDoc = await staff('Dr Dev', ['cardiologist'], 'CARD', String(cardio2._id));
    const nurse = await staff('Nia', ['ward-nurse'], 'CARD', String(nurseU._id));
    const noLogin = await staff('Dr Eli', ['cardiologist'], 'CARD');
    const day = '2026-09-26';
    const t = at('2026-09-26T10:00:00');

    assert.equal(await roster.onCall('CARD', t), null);
    await entry(day, 'morning', nurse._id);
    await entry(day, 'morning', noLogin._id);
    assert.equal(await roster.onCall('CARD', t), null, 'a nurse and a doctor without a login cannot be paged');
    await entry(day, 'morning', dayDoc._id);
    assert.equal((await roster.onCall('CARD', t))!.name, 'Dr Cara');
    assert.equal(await roster.onCall('NEURO', t), null);
    await entry(day, 'on-call', onCallDoc._id, { departmentCode: 'CARD' });
    const picked = (await roster.onCall('CARD', t))!;
    assert.equal(picked.name, 'Dr Dev');
    assert.equal(picked.userId, String(cardio2._id));
    assert.equal(picked.shift, 'on-call');
    assert.equal((await roster.onCall('CARD', at('2026-09-26T15:00:00')))!.name, 'Dr Dev', 'on call runs 24 hours');
  });

  test('copyWeek copies seven days of entries and skips ones that already exist', async () => {
    const a = await staff('Anu', ['ward-nurse'], 'GM');
    const b = await staff('Bina', ['ward-nurse'], 'GM');
    await entry('2026-09-21', 'morning', a._id, { note: 'first' });
    await entry('2026-09-27', 'night', b._id, { departmentCode: 'GM' });
    await entry('2026-09-29', 'evening', b._id, { note: 'outside the seven days' });
    // Already in the target week: the copy of 09-21 would land on it.
    await entry('2026-09-28', 'morning', a._id, { note: 'keep me' });
    const res = await roster.copyWeek(ADMIN, '2026-09-21', '2026-09-28');
    assert.deepEqual(res, { copied: 1, skipped: 1 });
    assert.deepEqual(await roster.copyWeek(ADMIN, '2026-09-21', '2026-09-28'), { copied: 0, skipped: 2 });
    const week = await roster.week('2026-09-28');
    assert.equal(week.days.length, 7);
    const copied = week.entries.find((e) => e.date === '2026-10-04' && e.shift === 'night')!;
    assert.equal(copied.staffName, 'Bina');
    assert.equal(copied.departmentCode, 'GM');
    assert.equal(week.entries.find((e) => e.date === '2026-09-28')!.note, 'keep me');
    assert.equal(week.entries.length, 3);
  });

  test('admin only, validated dates and shifts, and one login per staff member', async () => {
    const u = await user('Uma', 'uma2@x.test');
    const s = await staff('Uma', ['physician'], 'GM', String(u._id));
    await assert.rejects(() => staff('Uma Two', ['physician'], 'GM', String(u._id)), /already belongs/);
    await assert.rejects(() => staff('Bad', ['wizard'], 'GM'), /Unknown skill/);
    await assert.rejects(() => roster.upsertStaff({ id: 'x', name: 'X', role: UserRole.DOCTOR }, { name: 'X' }), /Only an admin/);
    await assert.rejects(() => entry('2026-02-30', 'morning', s._id), /YYYY-MM-DD/);
    await assert.rejects(() => entry('2026-09-26', 'dawn', s._id), /shift/);
    await assert.rejects(() => entry('2026-09-26', 'morning', new Types.ObjectId()), /not found/);
    await assert.rejects(() => roster.removeEntry(ADMIN, String(new Types.ObjectId())), /not found/);
    const again = await entry('2026-09-26', 'morning', s._id, { titles: ['duty-doctor'] });
    const changed = await entry('2026-09-26', 'morning', s._id, { titles: [] });
    assert.equal(String(again._id), String(changed._id), 'the same shift is updated, not duplicated');
  });

  test('logins lists active users not linked to a staff member (plus the one asked for), admin only, with no secrets (I7)', async () => {
    const free = await user('Free Nurse', 'free@x.in');
    const taken = await user('Taken Nurse', 'taken@x.in');
    const mine = await user('My Nurse', 'mine@x.in');
    await m.User.create({ email: 'off@x.in', passwordHash: 'x', name: 'Off', role: 'nurse', isActive: false });
    await staff('Linked', ['ward-nurse'], 'GM', String(taken._id));
    const own = await staff('Mine', ['ward-nurse'], 'GM', String(mine._id));
    const list = await roster.logins(ADMIN);
    assert.deepEqual(list.map((u) => u.email).sort(), ['free@x.in']);
    assert.deepEqual(Object.keys(list[0]).sort(), ['email', 'id', 'name', 'role']);
    const withOwn = await roster.logins(ADMIN, String(own._id));
    assert.deepEqual(withOwn.map((u) => u.email).sort(), ['free@x.in', 'mine@x.in']);
    assert.equal(withOwn.find((u) => u.email === 'free@x.in')!.id, String(free._id));
    await assert.rejects(() => roster.logins({ id: 'n1', name: 'N', role: UserRole.NURSE }), /admin/i);
  });
});
