import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  COMPLETION_KINDS,
  CONDITIONS,
  DEFAULT_DISCHARGE_CONFIG,
  DEFAULT_WARNING_SIGNS,
  DISCHARGE_KINDS,
  KIND_LABEL,
  LINE_KEYS,
  LINE_LABEL,
  LINE_OWNER,
  LINE_RULE,
  SUMMARY_SECTIONS,
  SUMMARY_TITLE,
  type DischargeKind,
} from './discharge-catalogue';

// The line table from Values, as written there. Owners name the doctor, a nurse, or the agent (by its key).
// The rule columns are home, transfer, against-advice and died.
const TABLE = `
order             | Discharge order            | doctor     | R R R R
summary           | Summary signed             | doctor     | R R R R
lab               | Lab results                | lab        | R R - -
take-home         | Take-home medicines        | pharmacy   | R R O -
follow-up         | Follow-up                  | scheduling | R - O -
ama-form          | Against-advice form signed | nurse      | - - R -
teaching          | Teaching and documents     | nurse      | R R R -
death-certificate | Cause-of-death certificate | doctor     | - - - R
body-handover     | Body handed over           | nurse      | - - - R
bill              | Nothing due on the bill    | revenue    | R S R S
`
  .trim()
  .split('\n')
  .map((row) => {
    const [key, label, owner, rules] = row.split('|').map((cell) => cell.trim());
    return { key, label, owner, rules: rules.split(' ') };
  });
const COLUMNS: DischargeKind[] = ['home', 'transfer', 'against-advice', 'died'];

describe('discharge catalogue', () => {
  test('LINE_RULE matches the table for every kind', () => {
    assert.deepEqual([...LINE_KEYS], TABLE.map((r) => r.key), 'the keys, in the table order');
    for (const [i, kind] of COLUMNS.entries()) {
      assert.deepEqual(Object.keys(LINE_RULE[kind]).sort(), [...LINE_KEYS].sort(), `${kind} has a rule for every line and no other`);
      for (const row of TABLE) assert.equal(LINE_RULE[kind][row.key as never], row.rules[i], `${row.key} for ${kind}`);
    }
    assert.deepEqual(Object.keys(LINE_RULE).sort(), [...DISCHARGE_KINDS].sort());
  });

  test('line labels and owners are as in Values, and teaching reads "Documents handed over" for transfer and against advice', () => {
    for (const row of TABLE) {
      assert.equal(LINE_LABEL(row.key as never, 'home'), row.label, row.key);
      assert.equal(LINE_OWNER[row.key as never], row.owner, `${row.key} owner`);
    }
    assert.equal(LINE_LABEL('teaching', 'transfer'), 'Documents handed over');
    assert.equal(LINE_LABEL('teaching', 'against-advice'), 'Documents handed over');
    for (const row of TABLE.filter((r) => r.key !== 'teaching')) {
      for (const kind of COLUMNS) assert.equal(LINE_LABEL(row.key as never, kind), row.label, `${row.key} for ${kind}`);
    }
  });

  test('kinds, conditions and the summary kinds are as in Values', () => {
    assert.deepEqual([...DISCHARGE_KINDS], ['home', 'transfer', 'against-advice', 'died']);
    assert.deepEqual([...COMPLETION_KINDS], ['home', 'transfer', 'against-advice', 'died', 'left-without-discharge']);
    assert.deepEqual(KIND_LABEL, {
      home: 'Home',
      transfer: 'Transfer',
      'against-advice': 'Against advice',
      died: 'Died',
      'left-without-discharge': 'Left without discharge',
    });
    assert.deepEqual([...CONDITIONS], ['improved', 'stable', 'unchanged', 'deteriorated']);
    assert.deepEqual(SUMMARY_TITLE, {
      home: 'Discharge summary',
      transfer: 'Transfer letter',
      'against-advice': 'Against-advice note',
      died: 'Death summary',
    });

    const base = ['details', 'reason', 'diagnosis', 'course', 'procedures', 'results', 'condition', 'medicines', 'followUp', 'warningSigns'];
    const kept = (kind: DischargeKind) => SUMMARY_SECTIONS(kind).filter((s) => base.includes(s));
    const added = (kind: DischargeKind) => SUMMARY_SECTIONS(kind).filter((s) => !base.includes(s));
    assert.deepEqual(SUMMARY_SECTIONS('home'), base);
    assert.deepEqual(SUMMARY_SECTIONS('against-advice'), base);
    assert.deepEqual(kept('transfer'), base.filter((s) => s !== 'followUp'), 'a transfer letter has no follow-up');
    assert.deepEqual(added('transfer'), ['receivingHospital', 'transferReason']);
    assert.deepEqual(kept('died'), base.filter((s) => !['medicines', 'followUp', 'warningSigns', 'condition'].includes(s)), 'a death summary has no medicines, follow-up, warning signs or condition');
    assert.deepEqual(added('died'), ['timeOfDeath', 'causeOfDeath']);
    assert.equal(SUMMARY_SECTIONS('home')[0], 'details');
  });

  test('the default settings carry the exact warning signs', () => {
    assert.equal(
      DEFAULT_WARNING_SIGNS,
      'Come back to the hospital at once, or call us, if you have: chest pain or breathlessness; fever above 101°F (38.3°C); bleeding, or a wound that is red, swollen or leaking; severe pain not eased by your medicines; vomiting that stops you keeping medicines down; fainting, confusion, or new weakness of the face, arm or leg.',
    );
    assert.deepEqual(DEFAULT_DISCHARGE_CONFIG, {
      leaveMinutes: 120,
      summaryMinutes: 60,
      reminderTime: '09:00',
      warningSigns: DEFAULT_WARNING_SIGNS,
      gatePassHeader: '',
    });
  });
});
