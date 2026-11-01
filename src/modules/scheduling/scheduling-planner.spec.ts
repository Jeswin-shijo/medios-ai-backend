import * as assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';
import { clinicNow, isoDate, parseIsoDay } from '../../common/utils/clinic-time';
import { ROOMS, Shift, procedureByKey } from './scheduling-catalogue';
import { DutyRow, HeldBooking, PlanInput, planBooking } from './scheduling-planner';
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

  test('a case may end exactly at the elective close (17:15 to 18:00 in the cath lab)', () => {
    const late = ['cardiologist', 'cath-nurse', 'cath-technician'].map((s) => row(s, [s], [[D, 'evening'], [addDays(D, 1), 'morning']]));
    const plan = planBooking(input({ now: at(D, '16:45'), earliest: at(D, '16:45'), duty: late }))!;
    assert.equal(plan.start.getTime(), at(D, '17:15').getTime(), '16:45 + 30 min; ending at 18:00 is inside the hours');
    assert.equal(plan.end.getTime(), at(D, '18:00').getTime());
  });

  test('the window runs from the first allowed start, not from now', () => {
    // Urgent at 07:45: the first start is 08:15, so the 24 hours run to 08:15 tomorrow, and tomorrow 08:00 is inside.
    const plan = planBooking(input({ priority: 'urgent', now: at(D, '07:45'), earliest: at(D, '07:45'), duty: team(addDays(D, 1)) }));
    assert.ok(plan, 'tomorrow 08:00 is within the window');
    assert.equal(plan.start.getTime(), at(addDays(D, 1), '08:00').getTime());
  });

  test("the booked minutes that count are those of the start's day, not today's", () => {
    const D1 = addDays(D, 1);
    const duty = [row('Arun', ['cardiologist'], morning(D1)), row('Beena', ['cath-nurse'], morning(D1)), row('Divya', ['cath-nurse'], morning(D1)), row('Ravi', ['cath-technician'], morning(D1))];
    const plan = planBooking(input({ duty, load: { [D]: { Divya: 500 }, [D1]: { Beena: 90, Divya: 30 } } }))!;
    assert.equal(plan.start.getTime(), at(D1, '08:00').getTime());
    assert.equal(plan.team[1].staffId, 'Divya', 'Beena has more minutes booked on the day of the start');
  });

  // ---------- STAT (spec 4.4, Ruling Z22) ----------

  const onCall = (id: string, skill: string, day = D) => row(id, [skill], [[day, 'on-call']], { onCall: true });
  const onCallTeam = () => [onCall('Arun', 'cardiologist'), onCall('Anitha', 'cath-nurse'), onCall('Ravi', 'cath-technician')];
  const stat = (over: Partial<PlanInput>) => planBooking(input({ priority: 'stat', ...over }))!;
  const secs = (day: string, t: string, s: number) => new Date(at(day, t).getTime() + s * 1000);
  const held = (id: string, room: string, start: string, end: string, extra: Partial<HeldBooking> = {}): HeldBooking => ({
    id, room, start: at(D, start), end: at(D, end), team: [], status: 'booked', priority: 'routine', ...extra,
  });
  const hernia = procedureByKey('hernia-repair')!;
  const otTeam = () => [row('Sam', ['surgeon'], morning()), row('Ann', ['anaesthetist'], morning()), row('Oli', ['ot-nurse'], morning())];

  test('STAT starts now, to the whole minute, in any hour, with no lead and no 15-minute grid', () => {
    const p = stat({ now: secs(D, '22:05', 30), earliest: secs(D, '22:05', 30), duty: onCallTeam() });
    assert.deepEqual([p.room, p.start.getTime(), p.end.getTime()], ['cath-lab', at(D, '22:06').getTime(), at(D, '22:51').getTime()]);
    assert.deepEqual(p.team, [
      { role: 'cardiologist', staffId: 'Arun' },
      { role: 'cath-nurse', staffId: 'Anitha' },
      { role: 'cath-technician', staffId: 'Ravi' },
    ]);
    assert.deepEqual(p.bump, []);
    assert.equal(stat({ now: at(D, '22:05'), earliest: at(D, '22:05'), duty: onCallTeam() }).start.getTime(), at(D, '22:05').getTime(), 'a whole minute stays');
    assert.equal(hhmm(stat({ now: at(D, '22:05'), earliest: at(D, '23:00'), duty: onCallTeam() }).start), '23:00', 'a later earliest is kept');
    // A planned case never gets these: its plan bumps nothing.
    assert.deepEqual(planBooking(input())!.bump, []);
  });

  test('STAT: a case in progress frees the room at its end (or now, once overrun) plus turnover; blocks and booked STATs hold it too', () => {
    const now = at(D, '22:05');
    const running = (end: string) => [held('ip', 'cath-lab', '21:30', end, { status: 'in-progress' })];
    const p = stat({ now, earliest: now, duty: onCallTeam(), bookings: running('22:30') });
    assert.deepEqual([hhmm(p.start), p.bump], ['22:45', []], '22:30 + 15 min turnover; a case in progress is never bumped');
    const overrun = stat({ now: secs(D, '22:05', 30), earliest: now, duty: onCallTeam(), bookings: running('21:50') });
    assert.equal(overrun.start.getTime(), at(D, '22:21').getTime(), 'planned to end 21:50 and still going: now (22:05:30) + 15 min, to the whole minute');
    const booked = stat({ now, earliest: now, duty: onCallTeam(), bookings: [held('s1', 'cath-lab', '22:00', '22:45', { priority: 'stat' })] });
    assert.deepEqual([hhmm(booked.start), booked.bump], ['23:00', []], 'a booked STAT is never bumped');
    const blocked = stat({ now, earliest: now, duty: onCallTeam(), blocks: [{ room: 'cath-lab', from: at(D, '21:00'), to: at(D, '23:10') }] });
    assert.equal(hhmm(blocked.start), '23:10');
  });

  test('STAT bumps the planned cases overlapping [start, end + turnover) in its room, and only those', () => {
    const now = at(D, '08:00');
    const p = stat({
      now,
      earliest: now,
      bookings: [
        held('a', 'cath-lab', '08:00', '08:45'),
        held('u', 'cath-lab', '08:50', '09:35', { priority: 'urgent' }),
        held('c', 'cath-lab', '09:00', '09:45'),
        held('x', 'ot-1', '08:00', '09:30'),
      ],
    });
    assert.deepEqual([p.room, hhmm(p.start), hhmm(p.end)], ['cath-lab', '08:00', '08:45']);
    assert.deepEqual(p.bump, ['a', 'u'], '09:00 starts right after the STAT and its 15-minute turnover; OT 1 is another room');
    assert.equal(p.team.filter((t) => t.staffId).length, 3);

    // Room choice: the earliest start, then the room that bumps fewer cases, then the order of the rooms.
    const ot = stat({ procedure: hernia, now, earliest: now, duty: otTeam(), bookings: [held('o1', 'ot-1', '08:00', '09:30')] });
    assert.deepEqual([ot.room, hhmm(ot.start), ot.bump], ['ot-2', '08:00', []], 'OT 2 is free: nobody is bumped needlessly');
    assert.equal(stat({ procedure: hernia, now, earliest: now, duty: otTeam() }).room, 'ot-1');
    const both = stat({
      procedure: hernia,
      now,
      earliest: now,
      duty: otTeam(),
      bookings: [held('ip', 'ot-1', '07:30', '09:00', { status: 'in-progress' }), held('o2', 'ot-2', '08:30', '10:00')],
    });
    assert.deepEqual([both.room, hhmm(both.start), both.bump], ['ot-2', '08:00', ['o2']], 'starting now beats waiting for the case in progress');
  });

  test('STAT fills each role in order: free on shift, free on call, a doctor in clinic, then a member of a planned case (bumped)', () => {
    const now = at(D, '09:00');
    const rest = team().slice(1);
    const clinic = { opdBusy: [{ start: at(D, '08:00'), end: at(D, '12:00') }] };
    const planned = held('p1', 'ot-1', '08:30', '10:00', { team: ['Abel'] });
    const zed = row('Zed', ['cardiologist'], morning());
    const yan = onCall('Yan', 'cardiologist');
    const xavi = row('Xavi', ['cardiologist'], morning(), clinic);
    const abel = row('Abel', ['cardiologist'], morning());
    const pick = (duty: DutyRow[], load: PlanInput['load'] = {}) => stat({ now, earliest: now, duty: [...duty, ...rest], bookings: [planned], load });
    // The names run against the steps, so only the steps decide.
    assert.deepEqual([pick([zed, yan, xavi, abel]).team[0].staffId, pick([zed, yan, xavi, abel]).bump], ['Zed', []]);
    assert.deepEqual([pick([yan, xavi, abel]).team[0].staffId, pick([yan, xavi, abel]).bump], ['Yan', []]);
    assert.deepEqual([pick([xavi, abel]).team[0].staffId, pick([xavi, abel]).bump], ['Xavi', []], 'the outpatients wait');
    assert.deepEqual([pick([abel]).team[0].staffId, pick([abel]).bump], ['Abel', ['p1']], "Abel's planned case is bumped");
    // Within a step: fewest booked minutes that day, then name.
    const zack = row('Zack', ['cardiologist'], morning());
    assert.equal(pick([zed, zack]).team[0].staffId, 'Zack');
    assert.equal(pick([zed, zack], { [D]: { Zack: 60, Zed: 30 } }).team[0].staffId, 'Zed');
  });

  test('STAT never takes anyone from a case in progress or a booked STAT, and books with the roles it cannot fill', () => {
    const now = at(D, '09:00');
    const ip = (end: string) => held('ip', 'ot-1', '08:00', end, { status: 'in-progress', team: ['Anitha'] });
    const busy = stat({ now, earliest: now, bookings: [ip('10:00')] });
    assert.deepEqual(busy.team, [{ role: 'cardiologist', staffId: 'Arun' }, { role: 'cath-nurse', unfilled: true }, { role: 'cath-technician', staffId: 'Ravi' }]);
    assert.deepEqual([hhmm(busy.start), busy.bump], ['09:00', []], 'an unfilled role never delays a STAT');
    assert.equal(stat({ now, earliest: now, bookings: [ip('08:45')] }).team[1].unfilled, true, 'planned to end 08:45 and still going at 09:00');
    assert.equal(stat({ now, earliest: now, bookings: [held('s', 'ot-1', '08:50', '09:30', { priority: 'stat', team: ['Anitha'] })] }).team[1].unfilled, true);
    // A short STAT is still kept off a case in progress that began before its planned start.
    const xray = procedureByKey('chest-xray')!;
    const early = stat({ procedure: xray, now, earliest: now, duty: [row('Suresh', ['radiographer'], morning())], bookings: [held('ct', 'ct', '09:30', '09:50', { status: 'in-progress', team: ['Suresh'] })] });
    assert.deepEqual(early.team, [{ role: 'radiographer', unfilled: true }]);
    // Nobody on duty at all: still a plan, every role unfilled.
    assert.deepEqual(stat({ now, earliest: now, duty: [] }).team.map((t) => t.unfilled), [true, true, true]);
    // One person per role, filling as many roles as possible.
    const asha = row('Asha', ['cath-nurse', 'cath-technician'], morning());
    const zara = row('Zara', ['cath-nurse'], morning());
    assert.deepEqual(stat({ now, earliest: now, duty: [team()[0], asha, zara] }).team.map((t) => t.staffId), ['Arun', 'Zara', 'Asha']);
    assert.deepEqual(stat({ now, earliest: now, duty: [team()[0], asha] }).team, [{ role: 'cardiologist', staffId: 'Arun' }, { role: 'cath-nurse', staffId: 'Asha' }, { role: 'cath-technician', unfilled: true }]);
  });

  test('STAT with emergency-bump off: the first gap in any hour, nothing bumped, nobody taken from a planned case, a doctor in clinic still taken', () => {
    const now = at(D, '08:00');
    const off = (over: Partial<PlanInput>) => stat({ emergencyBump: false, now, earliest: now, ...over });
    const fits = off({ bookings: [held('a', 'cath-lab', '08:00', '08:45'), held('b', 'cath-lab', '10:00', '10:45')] });
    assert.deepEqual([hhmm(fits.start), fits.bump], ['09:00', []], '09:00 + 45 + 15 just reaches 10:00');
    const tight = off({ bookings: [held('a', 'cath-lab', '08:00', '08:45'), held('b', 'cath-lab', '09:55', '10:40')] });
    assert.deepEqual([hhmm(tight.start), tight.bump], ['10:55', []], 'the gap before 09:55 is too short');
    const night = off({ now: at(D, '19:40'), earliest: at(D, '19:40'), duty: onCallTeam(), bookings: [held('e', 'cath-lab', '17:00', '19:30')] });
    assert.equal(hhmm(night.start), '19:45', 'after the elective close');

    const member = off({ bookings: [held('ot', 'ot-1', '08:30', '10:00', { team: ['Anitha'] })] });
    assert.deepEqual([member.team[1], member.bump], [{ role: 'cath-nurse', unfilled: true }, []]);
    const clinic = off({ duty: [row('Arun', ['cardiologist'], morning(), { opdBusy: [{ start: at(D, '08:00'), end: at(D, '12:00') }] }), ...team().slice(1)] });
    assert.equal(clinic.team[0].staffId, 'Arun');

    // Nothing within 24 hours: after the last booking of the kind's first room.
    const D1 = addDays(D, 1);
    const long = (id: string, room: string, endDay: string, end: string): HeldBooking => ({ id, room, start: at(D, '08:00'), end: at(endDay, end), team: [], status: 'booked', priority: 'routine' });
    const full = off({ procedure: hernia, duty: otTeam(), bookings: [long('o1', 'ot-1', D1, '10:00'), long('o2', 'ot-2', D1, '09:00')] });
    assert.deepEqual([full.room, full.start.getTime(), full.bump], ['ot-1', at(D1, '10:30').getTime(), []], 'OT 1 at 10:00 + 30 min turnover');
    // With bumping on, the same emergency starts now in OT 1.
    const on = stat({ procedure: hernia, now, earliest: now, duty: otTeam(), bookings: [long('o1', 'ot-1', D1, '10:00'), long('o2', 'ot-2', D1, '09:00')] });
    assert.deepEqual([on.room, hhmm(on.start), on.bump], ['ot-1', '08:00', ['o1']]);
  });
});
