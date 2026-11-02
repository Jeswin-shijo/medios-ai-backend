import type { Model } from 'mongoose';

/** `doctorId|date|time` while an appointment holds its slot. The partial unique index on it stops a double booking. */
export const slotKeyOf = (doctorId: string, date: string, time: string) => `${doctorId}|${date}|${time}`;

export const isDuplicateKey = (e: any) => e?.code === 11000;

/** A canceled appointment may still hold its key (an old cancel path kept it): release it before the slot is booked again. */
export async function releaseStaleSlot(appointments: Model<any>, key: string): Promise<void> {
  await appointments.updateOne({ slotKey: key, status: 'Canceled' }, { $unset: { slotKey: 1 } }).exec();
}
