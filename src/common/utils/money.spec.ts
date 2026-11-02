import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { formatRupees } from './money';

describe('formatRupees', () => {
  test('formatRupees(123456) is ₹1,23,456 and formatRupees(0) is ₹0', () => {
    assert.equal(formatRupees(123456), '₹1,23,456');
    assert.equal(formatRupees(0), '₹0');
  });

  test('negative amounts show a minus sign, fractions are rounded', () => {
    assert.equal(formatRupees(-1234), '-₹1,234');
    assert.equal(formatRupees(1234.6), '₹1,235');
    assert.equal(formatRupees(-0.2), '₹0');
  });
});
