import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildBedSeed } from './bed-layout';

test('layout has 138 beds in 11 wards with the spec counts', () => {
  const { wards, beds } = buildBedSeed();
  assert.equal(wards.length, 11);
  assert.equal(beds.length, 138);
  const count = (c: string) => beds.filter((b) => b.wardCode === c).length;
  assert.deepEqual(['ER','ICU','HDU','ISO','GWA','GWB','PED','MAT','TWN','PVT','DLX'].map(count), [6,8,6,4,30,30,12,12,16,10,4]);
});
test('starting states: 32 free, 5 cleaning, 1 blocked, 100 occupied', () => {
  const { beds } = buildBedSeed();
  const n = (s: string) => beds.filter((b) => b.state === s).length;
  assert.deepEqual([n('free'), n('cleaning'), n('blocked'), n('occupied')], [32, 5, 1, 100]);
});
test('GWA-4 is free with nearNurses and oxygen; GWA-17 blocked with reason', () => {
  const { beds } = buildBedSeed();
  const g4 = beds.find((b) => b.wardCode === 'GWA' && b.number === 4)!;
  assert.equal(g4.state, 'free');
  assert.ok(g4.features.includes('nearNurses') && g4.features.includes('oxygen'));
  const g17 = beds.find((b) => b.wardCode === 'GWA' && b.number === 17)!;
  assert.equal(g17.blockedReason, 'Repairs: oxygen point');
});
test('named patients and ventilators', () => {
  const { beds } = buildBedSeed();
  assert.equal(beds.find((b) => b.namedPatientUhid === 'MHK202500325')!.label, 'Ward A • Bed 12');
  assert.equal(beds.find((b) => b.namedPatientUhid === 'MHK202500327')!.label, 'HDU • Bed 1');
  assert.deepEqual(beds.filter((b) => b.features.includes('ventilator')).map((b) => b.label), ['ICU • Bed 1','ICU • Bed 2','ICU • Bed 3']);
});
test('twin labels and roommate genders', () => {
  const { beds } = buildBedSeed();
  const t = (n: number) => beds.find((b) => b.wardCode === 'TWN' && b.number === n)!;
  assert.equal(t(2).label, 'Twin 1 • Bed B');
  assert.equal(t(1).occupantGender, 'Male');
  assert.equal(t(8).occupantGender, 'Female');
});
