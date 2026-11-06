import { Model } from 'mongoose';
import { PatientCardDocument } from '../modules/queue/schemas/patient-card.schema';
import { cardIdCandidates } from '../modules/queue/patient-cards.service';

/** Demo cards for patients not checked in yet, so the kiosk can be tried without real cards. */
export const DEMO_CARDS = [
  { cardId: '04A1B2C3', uhid: 'MHK202500324' }, // Rekha S
  { cardId: '0004567890', uhid: 'MHK202500325' }, // David Raj
  { cardId: '04C8D9E0F1A2B3', uhid: 'MHK202500326' }, // Selvi A
];

/**
 * Makes each demo card its patient's one active card, so the demo cards always work
 * after a reseed, even when a new card was written for a demo patient (that card is
 * kept, marked replaced). Cards linked by hand to other patients are left alone.
 */
export async function seedDemoCards(cards: Model<PatientCardDocument>, now = new Date()) {
  for (const card of DEMO_CARDS) {
    // The demo card linked in another reader's format is the same card, not an older one.
    await cards.updateMany(
      { uhid: card.uhid, cardId: { $nin: cardIdCandidates(card.cardId) }, status: { $ne: 'replaced' } },
      { $set: { status: 'replaced', replacedAt: now } },
    );
    await cards.updateOne(
      { cardId: card.cardId },
      { $set: { ...card, linkedBy: 'Seed', status: 'active', linkedAt: now }, $unset: { replacedAt: '', writtenAt: '' } },
      { upsert: true },
    );
  }
}
