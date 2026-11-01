import * as assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';
import { clinicNow, isoDate, parseIsoDay } from '../../common/utils/clinic-time';
import { ROOMS, Shift, procedureByKey } from './scheduling-catalogue';
import { DutyRow, PlanInput, planBooking } from './scheduling-planner';
import { defaultSchedulingConfig } from './scheduling-settings.service';
import { shiftWindow } from './scheduling-time';

const D = '2026-10-20';
const addDays = (day: string, n: number) => {
  const d = parseIsoDay(day);
  d.setDate(d.getDate() + n);
  return isoDate(d);
};
/** A local clinic-clock moment: at('2026-10-20', '08:15'). */
const at = (day: string, hhmm: string) => {
  const d = parseIsoDay(day);
  const [h, m] = hhmm.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d;
};
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const ANGIO = procedureByKey('coronary-angiography')!;

/** A duty row of on-site shifts (or on-call ones with onCall: true). */
const row = (staffId: string, skills: string[], shifts: [string, Shift][], extra: Partial<DutyRow> = {}): DutyRow => ({
  staffId,
  name: staffId,
  skills,
  shiftWindows: shifts.map(([day, s]) => shiftWindow(day, s)),
  onCall: false,
  opdBusy: [],
  ...extra,
});
const morning = (day = D): [string, Shift][] => [[day, 'morning']];
const team = (day = D) => [
  row('Arun', ['cardiologist'], morning(day)),
  row('Anitha', ['cath-nurse'], morning(day)),
  row('Ravi', ['cath-technician'], morning(day)),
];
const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  procedure: ANGIO,
  priority: 'routine',
  earliest: at(D, '06:00'),
  now: at(D, '06:00'),
  roomHours: defaultSchedulingConfig().roomHours,
  rooms: ROOMS,
  blocks: [],
  bookings: [],
  duty: team(),
  load: {},
  ...over,
});

describe('planBooking (pure)', () => {
  test('routine angiography takes the earliest start in elective hours where the cath lab and a cardiologist, cath nurse and technician on shift are free', () => {
    const plan = planBooking(input())!;
    assert.ok(plan);
    assert.equal(plan.room, 'cath-lab');
    assert.equal(plan.start.getTime(), at(D, '08:00').getTime(), 'the cath lab opens at 08:00, after now + 30 min');
    assert.equal(plan.end.getTime(), at(D, '08:45').getTime());
    assert.deepEqual(plan.team, [
      { role: 'cardiologist', staffId: 'Arun' },
      { role: 'cath-nurse', staffId: 'Anitha' },
      { role: 'cath-technician', staffId: 'Ravi' },
    ]);

    // The technician only works the evening: the whole team is first free at 14:00.
    const evening = [row('Arun', ['cardiologist'], [[D, 'morning'], [D, 'evening']]), row('Anitha', ['cath-nurse'], [[D, 'morning'], [D, 'evening']]), row('Ravi', ['cath-technician'], [[D, 'evening']])];
    assert.equal(hhmm(planBooking(input({ duty: evening }))!.start), '14:00');

    // A start whose end passes the elective close (18:00) waits for the next morning.
    const twoDays = [D, addDays(D, 1)].flatMap((day) => [[day, 'morning'], [day, 'evening']] as [string, Shift][]);
    const late = planBooking(input({ now: at(D, '17:00'), earliest: at(D, '17:00'), duty: ['cardiologist', 'cath-nurse', 'cath-technician'].map((s) => row(s, [s], twoDays)) }))!;
    assert.equal(late.start.getTime(), at(addDays(D, 1), '08:00').getTime(), '17:30 + 45 min would end after 18:00');

    // No shift may be stitched to the next: a procedure must sit inside one window.
    const split = planBooking(input({ now: at(D, '13:00'), earliest: at(D, '13:00'), duty: ['cardiologist', 'cath-nurse', 'cath-technician'].map((s) => row(s, [s], [[D, 'morning'], [D, 'evening']])) }))!;
    assert.equal(hhmm(split.start), '14:00', '13:30 to 14:15 crosses from morning into evening');

    // A ward nurse is not a cath nurse; an on-call cardiologist is not used for a planned case.
    const wrong = [row('Bala', ['cardiologist'], [[D, 'on-call']], { onCall: true }), row('Wendy', ['ward-nurse'], morning()), ...team().slice(1)];
    assert.equal(planBooking(input({ duty: wrong })), null);
    // The earliest date is honoured when it is later than now.
    assert.equal(hhmm(planBooking(input({ earliest: at(D, '10:10') }))!.start), '10:15');
  });

  test('turnover is kept between cases', () => {
    const other = (start: string, end: string) => ({ room: 'cath-lab', start: at(D, start), end: at(D, end), team: ['someone-else'] });
    // 08:00-08:45 then 15 min clean-up: 09:00 is the first start.
    assert.equal(hhmm(planBooking(input({ bookings: [other('08:00', '08:45')] }))!.start), '09:00');
    // A case at 09:45 needs its own clean-up before it too: 09:00-09:45 + 15 would run into it, so after 10:30 + 15.
    assert.equal(hhmm(planBooking(input({ bookings: [other('08:00', '08:45'), other('09:45', '10:30')] }))!.start), '10:45');
    // An admin's longer turnover is used.
    const hours = { ...defaultSchedulingConfig().roomHours, 'cath-lab': { open: '08:00', close: '18:00', turnover: 30 } };
    assert.equal(hhmm(planBooking(input({ roomHours: hours, bookings: [other('08:00', '08:45')] }))!.start), '09:15');
    // A booking in another room does not hold the cath lab.
    assert.equal(hhmm(planBooking(input({ bookings: [{ room: 'ot-1', start: at(D, '08:00'), end: at(D, '09:30'), team: ['x'] }] }))!.start), '08:00');
  });

  test('a block over the room moves the start', () => {
    const block = (room: string, from: string, to: string) => ({ room, from: at(D, from), to: at(D, to) });
    assert.equal(hhmm(planBooking(input({ blocks: [block('cath-lab', '07:00', '10:00')] }))!.start), '10:00');
    assert.equal(hhmm(planBooking(input({ blocks: [block('cath-lab', '08:30', '09:00')] }))!.start), '09:00', '08:00-08:45 would run into the block');
    assert.equal(hhmm(planBooking(input({ blocks: [block('ot-1', '07:00', '12:00')] }))!.start), '08:00');
    // An OT procedure takes the other theatre when OT 1 is blocked.
    const hernia = procedureByKey('hernia-repair')!;
    const otTeam = [row('Sam', ['surgeon'], morning()), row('Ann', ['anaesthetist'], morning()), row('Oli', ['ot-nurse'], morning())];
    const plan = planBooking(input({ procedure: hernia, duty: otTeam, blocks: [block('ot-1', '07:00', '12:00')] }))!;
    assert.deepEqual([plan.room, hhmm(plan.start)], ['ot-2', '08:00']);
  });

  test('a doctor inside their OPD session with bookings is not picked for a non-STAT case', () => {
    const clinic = [{ start: at(D, '08:00'), end: at(D, '12:00') }];
    const arun = row('Arun', ['cardiologist'], morning(), { opdBusy: clinic });
    const bala = row('Bala', ['cardiologist'], morning());
    const load = { [D]: { Bala: 120 } };
    const both = planBooking(input({ duty: [arun, bala, ...team().slice(1)], load }))!;
    assert.deepEqual([hhmm(both.start), both.team[0].staffId], ['08:00', 'Bala'], 'Arun is less loaded but in clinic');
    const only = planBooking(input({ duty: [arun, ...team().slice(1)] }))!;
    assert.deepEqual([hhmm(only.start), only.team[0].staffId], ['12:00', 'Arun'], 'after the session ends');

    // A member busy on another procedure (any room) is not free either.
    const busy = planBooking(input({ bookings: [{ room: 'ot-1', start: at(D, '08:00'), end: at(D, '09:10'), team: ['Anitha'] }] }))!;
    assert.equal(hhmm(busy.start), '09:15');
  });

  test('least-loaded staff wins, ties by name', () => {
    const nurses = (load: PlanInput['load']) =>
      planBooking(input({ duty: [team()[0], row('Divya', ['cath-nurse'], morning()), row('Beena', ['cath-nurse'], morning()), team()[2]], load }))!.team[1].staffId;
    assert.equal(nurses({ [D]: { Divya: 30, Beena: 90 } }), 'Divya');
    assert.equal(nurses({}), 'Beena', 'equal load: by name');
    assert.equal(nurses({ [addDays(D, 1)]: { Beena: 500 } }), 'Beena', "another day's minutes do not count");

    // One person fills one role: a nurse who is also a technician is kept for the technician role.
    const asha = row('Asha', ['cath-nurse', 'cath-technician'], morning());
    const zara = row('Zara', ['cath-nurse'], morning());
    const plan = planBooking(input({ duty: [team()[0], asha, zara] }))!;
    assert.deepEqual(plan.team.map((t) => t.staffId), ['Arun', 'Zara', 'Asha']);
    assert.equal(planBooking(input({ duty: [team()[0], asha] })), null, 'one person cannot be both nurse and technician');
  });

  test('nothing fits within 14 days → null', () => {
    assert.equal(planBooking(input({ duty: team(addDays(D, 15)) })), null);
    assert.equal(planBooking(input({ duty: team(addDays(D, 14)) })), null, 'day 14 at 08:00 is past now + 30 min + 14 days');
    const late = planBooking(input({ duty: team(addDays(D, 13)) }))!;
    assert.equal(late.start.getTime(), at(addDays(D, 13), '08:00').getTime());
    // Urgent looks only 24 hours ahead.
    assert.equal(planBooking(input({ priority: 'urgent', duty: team(addDays(D, 1)) })), null);
    assert.equal(hhmm(planBooking(input({ priority: 'urgent', now: at(D, '09:00'), earliest: at(D, '09:00'), duty: team(addDays(D, 1)) }))!.start), '08:00');
  });

  test('no start before clinic now + 30 min on the pinned day', () => {
    const saved = process.env.CLINIC_DATE;
    process.env.CLINIC_DATE = '2026-09-26';
    // The real date is weeks later; the clinic day stays pinned to 26 Sep.
    mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 1, 10, 7, 0, 0) });
    try {
      const now = clinicNow();
      const plan = planBooking(input({ now, earliest: now, duty: team('2026-09-26') }))!;
      assert.ok(plan, 'the pinned day has a team');
      assert.equal(isoDate(plan.start), '2026-09-26');
      assert.ok(plan.start.getTime() >= now.getTime() + 30 * 60_000, 'never before now + 30 min');
      assert.equal(hhmm(plan.start), '10:45', '10:07 + 30 min = 10:37, then the next 15-minute mark');
      // An earlier "earliest" does not pull the start before now + 30 min.
      assert.equal(hhmm(planBooking(input({ now, earliest: at('2026-09-26', '08:00'), duty: team('2026-09-26') }))!.start), '10:45');
    } finally {
      mock.timers.reset();
      if (saved === undefined) delete process.env.CLINIC_DATE;
      else process.env.CLINIC_DATE = saved;
    }
  });

  test('STAT (until the emergency rules): no lead, any hour, and on-call staff may fill a role, on-site first', () => {
    const onCall = (id: string, skill: string) => row(id, [skill], [[D, 'on-call']], { onCall: true });
    const night = planBooking(input({ priority: 'stat', now: at(D, '22:05'), earliest: at(D, '22:05'), duty: [onCall('Arun', 'cardiologist'), onCall('Anitha', 'cath-nurse'), onCall('Ravi', 'cath-technician')] }))!;
    assert.equal(night.start.getTime(), at(D, '22:15').getTime(), 'no 30-minute lead, outside elective hours');
    const mixed = planBooking(input({ priority: 'stat', now: at(D, '09:05'), earliest: at(D, '09:05'), duty: [onCall('Aaron', 'cardiologist'), row('Zed', ['cardiologist'], morning()), ...team().slice(1)] }))!;
    assert.deepEqual([hhmm(mixed.start), mixed.team[0].staffId], ['09:15', 'Zed'], 'an on-site cardiologist before an on-call one');
    // Still null when nobody can fill a role within 24 hours (the emergency rules come later).
    assert.equal(planBooking(input({ priority: 'stat', duty: team().slice(0, 2) })), null);
  });
});
