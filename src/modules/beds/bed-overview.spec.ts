import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  OverviewAdmission,
  SuggestionInput,
  TypeRow,
  agentSuggestions,
  dischargePlan,
  expectedAdmissions,
  hourlySeries,
  movements,
  trendPct,
} from './bed-overview';

const HOUR = 3_600_000;
const NOW = new Date('2026-09-26T12:30:00.000Z');

const adm = (over: Partial<OverviewAdmission> = {}): OverviewAdmission => ({
  id: 'a1',
  patientName: 'Asha',
  sample: false,
  department: 'General Medicine',
  wardName: 'Ward A',
  bedLabel: 'Ward A • Bed 1',
  expectedStayDays: 2,
  status: 'active',
  admittedAt: new Date(NOW.getTime() - 24 * HOUR),
  transfers: [],
  ...over,
});

const row = (type: TypeRow['type'], total: number, occupied: number, free: number): TypeRow => ({
  type,
  label: type.toUpperCase(),
  total,
  occupied,
  free,
  cleaning: 0,
  blocked: 0,
  percentFull: total ? Math.round((occupied / total) * 100) : 0,
});

const calm = (over: Partial<SuggestionInput> = {}): SuggestionInput => ({
  byType: [row('icu', 10, 5, 5), row('general', 20, 10, 10)],
  dischargesToday: 0,
  lateCleaning: 0,
  requestsNeedingAttention: 0,
  freeVentilatorBeds: 3,
  ...over,
});

describe('bed overview maths', () => {
  test('trendPct compares with a day ago and is null without history', () => {
    assert.equal(trendPct(110, 100), 10);
    assert.equal(trendPct(90, 100), -10);
    assert.equal(trendPct(2, 3), -33);
    assert.equal(trendPct(5, 5), 0);
    assert.equal(trendPct(5, null), null);
    assert.equal(trendPct(5, 0), null);
  });

  test('hourlySeries leaves missing hours as null', () => {
    const at = (h: number) => new Date(Date.UTC(2026, 8, 26, h));
    // The host slept at 10:00: no snapshot for that hour.
    const snaps = [
      { hour: at(9), value: 4 },
      { hour: at(11), value: 6 },
      { hour: at(12), value: 7 },
    ];
    assert.deepEqual(hourlySeries(snaps, 4, NOW), [4, null, 6, 7]);
    assert.deepEqual(hourlySeries([], 2, NOW), [null, null]);
    assert.equal(hourlySeries(snaps, 24, NOW).length, 24);
  });

  test('dischargePlan includes overdue and due-within-24h stays only', () => {
    const due = (h: number) => adm({ id: `a${h}`, admittedAt: new Date(NOW.getTime() - 2 * 24 * HOUR + h * HOUR) });
    const plan = dischargePlan(
      [
        due(5), // due in 5 h
        due(-3), // overdue by 3 h
        due(30), // due in 30 h: not yet
        adm({ id: 'gone', status: 'discharged', dischargedAt: NOW, admittedAt: new Date(NOW.getTime() - 5 * 24 * HOUR) }),
      ],
      NOW,
    );
    assert.deepEqual(plan.map((p) => p.admissionId), ['a-3', 'a5']);
    assert.equal(plan[0].overdue, true);
    assert.equal(plan[1].overdue, false);
    assert.equal(plan[1].dueAt, new Date(NOW.getTime() + 5 * HOUR).toISOString());
    assert.equal(plan[1].bedLabel, 'Ward A • Bed 1');
    assert.equal(plan[1].wardName, 'Ward A');
  });

  test('expectedAdmissions adds open requests to the 7-day average', () => {
    const days = (d: number) => new Date(NOW.getTime() - d * 24 * HOUR);
    // 8 admissions in the 7 days: 8 / 7 rounds up to 2. The one 8 days ago does not count.
    const stamps = [0.5, 1, 2, 3, 4, 5, 6, 6.5, 8].map(days);
    assert.deepEqual(expectedAdmissions(3, stamps, NOW), { value: 5, avgPerDay: 2 });
    assert.deepEqual(expectedAdmissions(0, [], NOW), { value: 0, avgPerDay: 0 });
  });

  test('movements lists admissions, transfers and discharges newest first', () => {
    const t = (h: number) => new Date(NOW.getTime() - h * HOUR);
    const list = movements([
      adm({
        id: 'x',
        patientName: 'Ravi',
        bedLabel: 'ICU • Bed 2',
        admittedAt: t(10),
        transfers: [{ fromLabel: 'Ward A • Bed 1', toLabel: 'ICU • Bed 2', at: t(4) }],
      }),
      adm({ id: 'y', patientName: 'Meena', bedLabel: 'Ward B • Bed 3', admittedAt: t(20), status: 'discharged', dischargedAt: t(1) }),
    ]);
    assert.deepEqual(
      list.map((m) => [m.kind, m.patientName, m.from, m.to]),
      [
        ['discharge', 'Meena', 'Ward B • Bed 3', '—'],
        ['transfer', 'Ravi', 'Ward A • Bed 1', 'ICU • Bed 2'],
        ['admission', 'Ravi', 'General Medicine', 'Ward A • Bed 1'],
        ['admission', 'Meena', 'General Medicine', 'Ward B • Bed 3'],
      ],
    );
    assert.equal(list[0].at, t(1).toISOString());
    assert.equal(movements([adm(), adm({ id: 'b' })], 1).length, 1);
  });

  test('agentSuggestions flags a unit at 85% and the last free ICU bed', () => {
    const out = agentSuggestions(
      calm({
        byType: [row('icu', 10, 9, 1), row('general', 20, 10, 10)],
        dischargesToday: 4,
        lateCleaning: 2,
        requestsNeedingAttention: 1,
      }),
    );
    const titles = out.map((s) => s.title);
    assert.ok(titles.includes('ICU is 90% full'));
    assert.ok(titles.includes("Prepare 4 beds for today's discharges"));
    assert.ok(titles.includes('2 beds waiting over 30 min for cleaning'));
    assert.ok(titles.includes('Last free ICU bed'));
    const full = out.find((s) => s.title === 'ICU is 90% full');
    assert.equal(full?.tone, 'warn');
    assert.equal(full?.action.target, 'utilization');
    assert.equal(out.find((s) => s.title === "Prepare 4 beds for today's discharges")?.tone, 'info');
    assert.equal(out.find((s) => s.title === 'Last free ICU bed')?.action.target, 'bed-map');
    assert.ok(out.some((s) => s.action.target === 'requests' && s.tone === 'warn'));
    assert.ok(!titles.includes('All units are within normal levels'));
  });

  test('agentSuggestions says all is normal when nothing applies', () => {
    const out = agentSuggestions(calm());
    assert.equal(out.length, 1);
    assert.equal(out[0].tone, 'ok');
    assert.equal(out[0].title, 'All units are within normal levels');
  });

  test('agentSuggestions uses singular wording and flags a last ventilator bed', () => {
    const out = agentSuggestions(calm({ lateCleaning: 1, dischargesToday: 1, freeVentilatorBeds: 1 }));
    const titles = out.map((s) => s.title);
    assert.ok(titles.includes('1 bed waiting over 30 min for cleaning'));
    assert.ok(titles.includes("Prepare 1 bed for today's discharges"));
    assert.ok(titles.includes('Last free ventilator bed'));
  });
});
