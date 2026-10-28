import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importRefusal, parseBedCsv } from './bed-csv';

const HEADER =
  'ward_code,ward_name,ward_short_name,floor,ward_type,gender,rate_per_day,near_departments,bed_number,bed_label,room,features';
const WARD = 'A,Ward A,Ward A,1,general,any,1500,General Medicine';

describe('parseBedCsv', () => {
  test('the template parses to 2 wards and 3 beds', () => {
    const text = readFileSync(join(__dirname, '../../../docs/beds-import-template.csv'), 'utf8');
    const { wards, beds, errors } = parseBedCsv(text);
    assert.deepEqual(errors, []);
    assert.equal(wards.length, 2);
    assert.equal(beds.length, 3);
    assert.deepEqual(wards.map((w) => w.sortOrder), [0, 1]);
    assert.ok(beds.every((b) => b.state === 'free' && b.sample === false));
  });

  test('a quoted department with a comma stays one value', () => {
    const { wards, errors } = parseBedCsv(`${HEADER}\nA,Ward A,Ward A,1,general,any,1500,"Emergency, Trauma;Cardiology",1,A 1,,oxygen`);
    assert.deepEqual(errors, []);
    assert.deepEqual(wards[0].nearDepartments, ['Emergency, Trauma', 'Cardiology']);
  });

  test('doubled quotes parse to one quote', () => {
    const { wards, errors } = parseBedCsv(`${HEADER}\nA,"The ""Big"" Ward",Ward A,1,general,any,1500,,1,A 1,,`);
    assert.deepEqual(errors, []);
    assert.equal(wards[0].name, 'The "Big" Ward');
  });

  test('an unknown feature is reported with its row', () => {
    const { errors } = parseBedCsv(`${HEADER}\n${WARD},1,A 1,,oxygen\n${WARD},2,A 2,,wifi`);
    assert.deepEqual(errors, ['Row 2: unknown feature "wifi"']);
  });

  test('unknown ward_type and gender are reported', () => {
    const { errors } = parseBedCsv(`${HEADER}\nA,Ward A,Ward A,1,villa,robot,1500,,1,A 1,,`);
    assert.deepEqual(errors, ['Row 1: unknown ward_type "villa"', 'Row 1: unknown gender "robot"']);
  });

  test('a duplicate bed is reported', () => {
    const { errors } = parseBedCsv(`${HEADER}\n${WARD},1,A 1,,\n${WARD},1,A 1 again,,`);
    assert.deepEqual(errors, ['Row 2: duplicate bed A 1']);
  });

  test('a missing column is reported without a row prefix', () => {
    const header = HEADER.replace(',features', '');
    const { errors } = parseBedCsv(`${header}\n${WARD},1,A 1,`);
    assert.deepEqual(errors, ['Missing column: features']);
  });

  test('a ward whose details change between rows is reported', () => {
    const { errors } = parseBedCsv(`${HEADER}\n${WARD},1,A 1,,\nA,Ward A,Ward A,2,general,any,1500,General Medicine,2,A 2,,`);
    assert.deepEqual(errors, ['Row 2: ward A details differ from an earlier row']);
  });

  test('bad numbers are reported', () => {
    const { errors } = parseBedCsv(`${HEADER}\nA,Ward A,Ward A,1.5,general,any,0,,x,A 1,,`);
    assert.deepEqual(errors, ['Row 1: floor must be a number', 'Row 1: rate_per_day must be a number', 'Row 1: bed_number must be a number']);
  });

  test('CRLF line endings, a BOM and blank lines are tolerated', () => {
    const { beds, errors } = parseBedCsv(`﻿${HEADER}\r\n${WARD},1,A 1,,\r\n\r\n${WARD},2,A 2,,\r\n`);
    assert.deepEqual(errors, []);
    assert.equal(beds.length, 2);
  });
});

describe('importRefusal', () => {
  const none = { inUse: 0, admissions: 0, suggestions: 0, requests: 0, snapshots: 0 };

  test('no beds in use and no history proceeds', () => {
    assert.equal(importRefusal(none, false), null);
  });

  test('history without --force is refused with the counts, bed requests and snapshots included', () => {
    assert.equal(
      importRefusal({ ...none, admissions: 4, suggestions: 2, requests: 10, snapshots: 168 }, false),
      'Admission history exists. Importing replaces all beds and would delete 4 admissions, 2 bed suggestions, 10 bed requests and 168 hourly snapshots. Re-run with --force to replace them anyway.',
    );
  });

  test('bed requests alone are history; one of each reads in the singular', () => {
    assert.equal(
      importRefusal({ ...none, requests: 1, snapshots: 1 }, false),
      'Admission history exists. Importing replaces all beds and would delete 1 bed request and 1 hourly snapshot. Re-run with --force to replace them anyway.',
    );
  });

  test('hourly snapshots alone do not stop an import', () => {
    // The API takes one at every start, so a fresh database has some.
    assert.equal(importRefusal({ ...none, snapshots: 3 }, false), null);
  });

  test('--force proceeds', () => {
    assert.equal(importRefusal({ inUse: 3, admissions: 4, suggestions: 2, requests: 10, snapshots: 168 }, true), null);
  });

  test('beds in use are reported first', () => {
    assert.equal(
      importRefusal({ ...none, inUse: 3, admissions: 4, suggestions: 2 }, false),
      'Beds are in use (3 occupied or held). Re-run with --force to replace them anyway.',
    );
  });
});
