import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, mongo } from 'mongoose';
import { PatientCard, PatientCardDocument } from './schemas/patient-card.schema';
import { Patient, PatientDocument } from '../patients/schemas/patient.schema';
import { QueueService } from './queue.service';

/**
 * A card number as the reader typed it, in one canonical form: readers differ in
 * separators and letter case ("04:A1:B2:C3", "04a1b2c3"), never in the digits.
 */
export function normalizeCardId(raw: string): string {
  const id = String(raw ?? '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '');
  if (id.length < 4 || id.length > 32) throw new BadRequestException('That is not a card number. Tap the card on the reader again.');
  return id;
}

/**
 * Every form another reader may have typed for the same card. A desk USB reader
 * types the UID as a decimal number (often zero-padded to 10 digits, in either
 * byte order); an NFC tablet reads it as hex. Original first, no duplicates.
 */
export function cardIdCandidates(raw: string): string[] {
  const id = normalizeCardId(raw);
  const out = [id];
  if (/^[0-9A-F]+$/.test(id) && id.length % 2 === 0 && id.length >= 8 && id.length <= 14) {
    const bytes = id.match(/../g)!;
    const reversed = [...bytes].reverse().join('');
    out.push(reversed);
    for (const hex of [id, reversed]) {
      const dec = BigInt(`0x${hex}`).toString();
      out.push(dec, dec.padStart(10, '0'));
    }
  }
  return [...new Set(out)];
}

/** "…B2C3": enough to tell cards apart on screen. */
export const cardHint = (cardId: string) => `…${cardId.slice(-4)}`;

@Injectable()
export class PatientCardsService {
  constructor(
    @InjectModel(PatientCard.name) private readonly cards: Model<PatientCardDocument>,
    @InjectModel(Patient.name) private readonly patients: Model<PatientDocument>,
    private readonly queue: QueueService,
  ) {}

  list(uhid: string) {
    return this.cards.find({ uhid: uhid.trim() }).sort({ createdAt: -1 }).exec();
  }

  /**
   * Links a card to a registered patient. A card already linked to someone else is
   * refused unless `reassign` (a card handed on, or linked by mistake).
   */
  async link(rawCardId: string, uhid: string, actor: string, reassign = false) {
    const cardId = normalizeCardId(rawCardId);
    const patient = await this.patients.findOne({ uhid: uhid.trim() }).exec();
    if (!patient) throw new NotFoundException(`${uhid} is not a registered patient`);

    // The same card may have been linked in another reader's format.
    const candidates = cardIdCandidates(cardId);
    const found = await this.cards.find({ cardId: { $in: candidates } }).exec();
    const sameOwner = found.find((c) => c.uhid === patient.uhid);
    if (sameOwner) return sameOwner;
    const existing = candidates.map((id) => found.find((c) => c.cardId === id)).find(Boolean);
    if (existing && !reassign) {
      const owner = await this.patients.findOne({ uhid: existing.uhid }).exec();
      throw new ConflictException(`Card ${cardHint(cardId)} is already linked to ${owner?.name ?? existing.uhid} (${existing.uhid}).`);
    }
    if (existing) {
      existing.uhid = patient.uhid;
      existing.linkedBy = actor;
      return existing.save();
    }
    try {
      return await this.cards.create({ cardId, uhid: patient.uhid, linkedBy: actor });
    } catch (err) {
      // Linked at the same moment from another desk.
      if (err instanceof mongo.MongoServerError && err.code === 11000) throw new ConflictException(`Card ${cardHint(cardId)} was just linked. Look it up again.`);
      throw err;
    }
  }

  async unlink(id: string) {
    const removed = await this.cards.findByIdAndDelete(id).exec();
    if (!removed) throw new NotFoundException('Card not found');
    return { id, removed: true };
  }

  /** The card for a read in any reader's format: an exact match first, then the other forms. Null when unknown. */
  async findByCard(raw: string): Promise<PatientCardDocument | null> {
    const candidates = cardIdCandidates(raw);
    const found = await this.cards.find({ cardId: { $in: candidates } }).exec();
    const card = candidates.map((id) => found.find((c) => c.cardId === id)).find(Boolean);
    if (!card) return null;
    card.lastUsedAt = new Date();
    return card.save();
  }

  /**
   * A card tapped on a reader: today's token for its patient, issued or (if they
   * already hold one) returned. Unknown cards are refused with 404.
   */
  async tap(rawCardId: string, actor: string, source: 'front-desk' | 'kiosk') {
    const cardId = normalizeCardId(rawCardId);
    const card = await this.findByCard(cardId);
    if (!card) throw new NotFoundException('This card is not registered. Please go to the front desk.');
    const issued = await this.queue.issue({ uhid: card.uhid }, actor, source);
    return { ...issued, cardId };
  }
}
