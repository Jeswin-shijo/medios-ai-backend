import { Model } from 'mongoose';
import { PatientCardDocument } from '../modules/queue/schemas/patient-card.schema';
import { DEMO_CARDS } from './seed-opd';
import { cardIdCandidates } from '../modules/queue/patient-cards.service';

// The demo card list lives in seed-opd (the Discharge seed keeps these patients out of its stories).
export { DEMO_CARDS };

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
