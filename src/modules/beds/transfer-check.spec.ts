import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { assertSuggestionFitsBed } from './transfer-check';

const MESSAGE = 'This suggestion was made for a different patient or bed.';
const suggestion = { request: { currentBedId: 'bed-1' } };

describe('assertSuggestionFitsBed', () => {
  test('passes when the suggestion patient is in the source bed', () => {
    assert.doesNotThrow(() => assertSuggestionFitsBed(suggestion, 'bed-1', { bed: 'bed-1' }));
  });

  test('rejects a suggestion made for a patient in another bed', () => {
    assert.throws(
      () => assertSuggestionFitsBed(suggestion, 'bed-1', { bed: 'bed-2' }),
      (err: unknown) => err instanceof BadRequestException && err.message === MESSAGE,
    );
  });

  test('rejects a suggestion whose patient is not admitted', () => {
    assert.throws(() => assertSuggestionFitsBed(suggestion, 'bed-1', null), BadRequestException);
  });

  test('rejects a suggestion whose currentBedId differs', () => {
    assert.throws(() => assertSuggestionFitsBed({ request: { currentBedId: 'bed-9' } }, 'bed-1', { bed: 'bed-1' }), BadRequestException);
    assert.throws(() => assertSuggestionFitsBed({ request: {} }, 'bed-1', { bed: 'bed-1' }), BadRequestException);
  });
});
