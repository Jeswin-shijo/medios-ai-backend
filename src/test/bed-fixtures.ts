import { buildBedSeed } from '../modules/beds/bed-layout';
import { BedInfo, BedState, WardInfo } from '../modules/beds/bed-types';

/** The demo hospital as plain inventory: ward id is its code, bed id is `${code}-${number}`. */
export function inventoryFromSeed(now: Date = new Date()): { wards: WardInfo[]; beds: BedInfo[] } {
  const seed = buildBedSeed();
  const wards: WardInfo[] = seed.wards.map(({ sortOrder: _sortOrder, ...ward }) => ({ ...ward, id: ward.code }));
  const beds: BedInfo[] = seed.beds.map((b) => {
    const bed: BedInfo = {
      id: `${b.wardCode}-${b.number}`,
      wardId: b.wardCode,
      label: b.label,
      number: b.number,
      features: [...b.features],
      state: b.state,
    };
    if (b.room) bed.room = b.room;
    if (b.occupantGender) bed.occupantGender = b.occupantGender;
    if (b.state === 'free') bed.freeSince = now;
    return bed;
  });
  return { wards, beds };
}

export function setState(beds: BedInfo[], ids: string[], state: BedState): BedInfo[] {
  return beds.map((b) => (ids.includes(b.id) ? { ...b, state } : b));
}
