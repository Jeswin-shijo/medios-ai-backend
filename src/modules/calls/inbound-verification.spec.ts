import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { nameMatches, parseBirthDate } from './inbound.service';

describe('nameMatches', () => {
  test('the full name is required, in any order and case', () => {
    assert.equal(nameMatches('Rekha Suresh', 'Rekha Suresh'), true);
    assert.equal(nameMatches('Rekha Suresh', 'suresh REKHA.'), true);
    assert.equal(nameMatches('Rekha Suresh', 'Rekha'), false, 'the first name alone is not enough');
    assert.equal(nameMatches('Rekha Suresh', 'Suresh'), false);
  });

  test('a list of names does not match: at most 2 extra words', () => {
    assert.equal(nameMatches('Arun Kumar', 'Arun Kumar Ravi Selva'), true, '2 extra words');
    assert.equal(nameMatches('Arun Kumar', 'Arun Kumar Ravi Selva Priya'), false, '3 extra words');
    assert.equal(nameMatches('Arun Kumar', 'Ravi Arun Selvi Kumar Priya Murugan Lakshmi Anand Devi Raja'), false);
  });

  test('honorifics are ignored on both sides', () => {
    assert.equal(nameMatches('Mr Arun Kumar', 'Mr'), false, 'an honorific alone never matches');
    assert.equal(nameMatches('Mr. Arun Kumar', 'Arun Kumar'), true);
    assert.equal(nameMatches('Arun Kumar', 'Dr Arun Kumar'), true);
    assert.equal(nameMatches('Smt Lakshmi Devi', 'Mrs. Lakshmi Devi'), true);
    assert.equal(nameMatches('Baby Anu', 'Anu'), true);
    assert.equal(nameMatches('Thiru Selvam', 'Shri Sri Thiru Selvam'), true, 'spoken honorifics are not extra words');
    assert.equal(nameMatches('Dr', 'Dr'), false, 'a record with no real name never matches');
  });

  test('initials on record are optional', () => {
    assert.equal(nameMatches('Suresh P', 'Suresh'), true);
    assert.equal(nameMatches('Suresh P', 'Suresh P'), true);
    assert.equal(nameMatches('S. Rekha', 'Rekha'), true);
    assert.equal(nameMatches('Suresh P', 'P'), false);
  });

  test('a name with no Latin letters never matches', () => {
    assert.equal(nameMatches('Rekha Suresh', 'ரேகா சுரேஷ்'), false);
  });
});

describe('parseBirthDate', () => {
  test('written and spoken forms, with ordinals', () => {
    assert.equal(parseBirthDate('14 Mar 1992'), '1992-03-14');
    assert.equal(parseBirthDate('14th March 1992'), '1992-03-14');
    assert.equal(parseBirthDate('14th of March, 1992'), '1992-03-14');
    assert.equal(parseBirthDate('March 14th, 1992'), '1992-03-14');
    assert.equal(parseBirthDate('2nd Aug 1966'), '1966-08-02');
  });

  test('D/M/Y and Y-M-D', () => {
    assert.equal(parseBirthDate('14/03/1992'), '1992-03-14');
    assert.equal(parseBirthDate('14-3-1992'), '1992-03-14');
    assert.equal(parseBirthDate('14.3.1992'), '1992-03-14');
    assert.equal(parseBirthDate('1992-03-14'), '1992-03-14');
    assert.equal(parseBirthDate('1992/3/14'), '1992-03-14');
  });

  test('an imported ISO timestamp is read as its day', () => {
    assert.equal(parseBirthDate('1992-03-14T00:00:00.000Z'), '1992-03-14');
  });

  test('impossible dates are refused', () => {
    assert.equal(parseBirthDate('31 Feb 1992'), null);
    assert.equal(parseBirthDate('29 Feb 1993'), null);
    assert.equal(parseBirthDate('29 Feb 1992'), '1992-02-29');
    assert.equal(parseBirthDate('32/01/1992'), null);
    assert.equal(parseBirthDate('14/13/1992'), null);
    assert.equal(parseBirthDate('14 Foo 1992'), null);
    assert.equal(parseBirthDate('01/01/1850'), null);
  });

  test('two-digit years: this century when not in the future, else the last', () => {
    assert.equal(parseBirthDate('14/3/92'), '1992-03-14');
    assert.equal(parseBirthDate('15/1/14'), '2014-01-15');
    assert.equal(parseBirthDate('14 Mar 92'), '1992-03-14');
    assert.equal(parseBirthDate('1/1/45'), '1945-01-01');
  });

  test('anything else is unreadable', () => {
    assert.equal(parseBirthDate(''), null);
    assert.equal(parseBirthDate(undefined), null);
    assert.equal(parseBirthDate('sometime in 92'), null);
    assert.equal(parseBirthDate({ day: 14 }), null);
  });
});
