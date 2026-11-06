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

const CARD_NOT_REGISTERED = 'This card is not registered. Please go to the front desk.';

/** The hex UID with its bytes in the other order. */
const reverseBytes = (hex: string) => hex.match(/../g)!.reverse().join('');

/**
 * Every form another reader may have typed for the same card. A desk USB reader
 * types the UID as a decimal number (often zero-padded to 10 digits, in either
 * byte order); an NFC tablet reads it as hex (4 or 7 bytes). A read is taken as hex
 * where it can be, and digits also as a decimal number, so every form of one card
 * finds every other (R33). Original first (an exact match wins), no duplicates.
 */
export function cardIdCandidates(raw: string): string[] {
  const id = normalizeCardId(raw);
  const out = [id];
  /** The UID in hex, its other byte order, and the decimal forms of both. */
  const withForms = (hex: string) => {
    const reversed = reverseBytes(hex);
    out.push(hex, reversed);
    for (const h of [hex, reversed]) {
      const dec = BigInt(`0x${h}`).toString();
      out.push(dec, dec.padStart(10, '0'));
    }
  };
  if (/^[0-9A-F]+$/.test(id) && id.length % 2 === 0 && id.length >= 8 && id.length <= 14) withForms(id);
  // Digits may be a USB reader's decimal UID: its 4- and 7-byte hex forms where the number fits.
  if (/^[0-9]+$/.test(id) && id.length <= 17) {
    const n = BigInt(id);
    for (const bytes of [4, 7]) {
      if (n > 0n && n < 1n << BigInt(bytes * 8)) withForms(n.toString(16).toUpperCase().padStart(bytes * 2, '0'));
    }
  }
  return [...new Set(out)];
}

/** "…B2C3": enough to tell cards apart on screen. */
export const cardHint = (cardId: string) => `…${cardId.slice(-4)}`;

export const CARD_REPLACED_MESSAGE = 'This card has been replaced. Please use your new card or ask at the counter.';

/** A replaced card, refused wherever a card identifies a patient (kiosk, desk reader, ER). Coded for the tablet. */
const cardReplaced = () => new NotFoundException({ message: CARD_REPLACED_MESSAGE, code: 'CARD_REPLACED' });

type CardJson = PatientCard & { _id: unknown };

/** A linked card as the API returns it (a plain object, so `replaced` survives), with the hints of the cards this link replaced. */
export type LinkedCard = CardJson & { replaced: string[] };

type Linkable = Pick<PatientCardDocument, '_id' | 'linkedAt'> & { createdAt?: Date };

/** When a card was last linked; a card linked before `linkedAt` existed counts from its creation. */
const linkedTime = (card: Linkable) => (card.linkedAt ?? card.createdAt)?.getTime() ?? 0;

/** Negative when `a` was linked before `b`. The same instant is settled by id, so two cards never tie. */
const byLinked = (a: Linkable, b: Linkable) => {
  const [x, y] = [String(a._id), String(b._id)];
  return linkedTime(a) - linkedTime(b) || (x < y ? -1 : x > y ? 1 : 0);
};

@Injectable()
export class PatientCardsService {
  /** The last `linkedAt` given out: each link gets a later instant, even within one millisecond. */
  private lastLinkedAt = 0;

  constructor(
    @InjectModel(PatientCard.name) private readonly cards: Model<PatientCardDocument>,
    @InjectModel(Patient.name) private readonly patients: Model<PatientDocument>,
    private readonly queue: QueueService,
  ) {}

  /** A patient's cards: the active one first, then the replaced ones, newest first. */
  async list(uhid: string) {
    const cards = await this.cards.find({ uhid: uhid.trim() }).exec();
    return cards.sort((a, b) => Number(a.status === 'replaced') - Number(b.status === 'replaced') || byLinked(b, a));
  }

  /**
   * Links a card to a registered patient and makes it their one active card: their
   * older cards are marked replaced. A card active for someone else is refused unless
   * `reassign` (a card handed on, or linked by mistake); a replaced one moves freely.
   * `written`: the counter tablet has just written the patient's details onto it.
   */
  async link(rawCardId: string, uhid: string, actor: string, reassign = false, written = false): Promise<LinkedCard> {
    const cardId = normalizeCardId(rawCardId);
    const patient = await this.patients.findOne({ uhid: uhid.trim() }).exec();
    if (!patient) throw new NotFoundException(`${uhid} is not a registered patient`);

    // The same card may have been linked in another reader's format.
    const candidates = cardIdCandidates(cardId);
    const found = await this.cards.find({ cardId: { $in: candidates } }).exec();
    const sameOwner = found.find((c) => c.uhid === patient.uhid);
    if (sameOwner && sameOwner.status !== 'replaced') {
      // Already this patient's active card (linked again, or written again after a failed link).
      if (written) {
        sameOwner.writtenAt = new Date();
        await sameOwner.save();
      }
      return { ...sameOwner.toJSON<CardJson>(), replaced: [] };
    }
    const existing = sameOwner ?? candidates.map((id) => found.find((c) => c.cardId === id)).find(Boolean);
    if (existing && existing.uhid !== patient.uhid && existing.status !== 'replaced' && !reassign) {
      const owner = await this.patients.findOne({ uhid: existing.uhid }).exec();
      throw new ConflictException(`Card ${cardHint(cardId)} is already linked to ${owner?.name ?? existing.uhid} (${existing.uhid}).`);
    }

    this.lastLinkedAt = Math.max(Date.now(), this.lastLinkedAt + 1);
    const linkedAt = new Date(this.lastLinkedAt);
    const fields = { uhid: patient.uhid, linkedBy: actor, status: 'active' as const, linkedAt, ...(written && { writtenAt: linkedAt }) };
    let card: PatientCardDocument;
    if (existing) {
      // Text written for the card's previous patient does not name this one.
      if (existing.uhid !== patient.uhid && !written) existing.writtenAt = undefined;
      existing.set({ ...fields, replacedAt: undefined });
      card = await existing.save();
    } else {
      try {
        card = await this.cards.create({ cardId, ...fields });
      } catch (err) {
        // Linked at the same moment from another desk.
        if (err instanceof mongo.MongoServerError && err.code === 11000) throw new ConflictException(`Card ${cardHint(cardId)} was just linked. Look it up again.`);
        throw err;
      }
    }
    const replaced = await this.replaceOlderCards(card);
    const fresh = await this.cards.findById(card._id).exec();
    return { ...(fresh ?? card).toJSON<CardJson>(), replaced };
  }

  /**
   * Makes `card` its patient's one active card: each of their other cards linked
   * before it is marked replaced. Two links for one patient at once both run this,
   * so it never marks "everything but me" (they would replace each other): a link
   * that finds a newer active card once its own writes are done steps back instead.
   * Exactly one card ends active, the newest. Returns the hints of the cards it replaced.
   */
  private async replaceOlderCards(card: PatientCardDocument): Promise<string[]> {
    const othersActive = { uhid: card.uhid, status: { $ne: 'replaced' }, _id: { $ne: card._id } };
    const replacedAt = new Date();
    const replaced: string[] = [];
    for (const other of await this.cards.find(othersActive).exec()) {
      if (byLinked(other, card) > 0) continue;
      // Only while it is as read: a card re-linked meanwhile is newer and settles itself.
      const res = await this.cards.updateOne({ ...othersActive, _id: other._id, linkedAt: other.linkedAt ?? null }, { $set: { status: 'replaced', replacedAt } }).exec();
      if (res.modifiedCount === 1) replaced.push(cardHint(other.cardId));
    }
    const newer = (await this.cards.find(othersActive).exec()).some((other) => byLinked(other, card) > 0);
    if (newer) {
      await this.cards.updateOne({ _id: card._id, uhid: card.uhid, linkedAt: card.linkedAt, status: { $ne: 'replaced' } }, { $set: { status: 'replaced', replacedAt } }).exec();
    }
    return replaced;
  }

  async unlink(id: string) {
    const removed = await this.cards.findByIdAndDelete(id).exec();
    if (!removed) throw new NotFoundException('Card not found');
    return { id, removed: true };
  }

  /**
   * The card for a read in any reader's format: an exact match first, then the other forms.
   * Null when unknown. Reads only, and replaced cards too: the callers refuse those.
   */
  private async lookup(raw: string): Promise<PatientCardDocument | null> {
    const candidates = cardIdCandidates(raw);
    const found = await this.cards.find({ cardId: { $in: candidates } }).exec();
    return candidates.map((id) => found.find((c) => c.cardId === id)).find(Boolean) ?? null;
  }

  /**
   * The UHID a card is linked to, whichever reader format linked it (as `findByCard`).
   * Reads only: no token, and `lastUsedAt` is left alone.
   */
  async findUhid(rawCardId: string): Promise<string> {
    const card = await this.lookup(rawCardId);
    if (!card) throw new NotFoundException(CARD_NOT_REGISTERED);
    if (card.status === 'replaced') throw cardReplaced();
    return card.uhid;
  }

  /**
   * The card for a read in any reader's format: an exact match first, then the other forms.
   * Null when unknown; a replaced card is refused (404, code CARD_REPLACED).
   */
  async findByCard(raw: string): Promise<PatientCardDocument | null> {
    const card = await this.lookup(raw);
    if (!card) return null;
    if (card.status === 'replaced') throw cardReplaced();
    card.lastUsedAt = new Date();
    return card.save();
  }

  /**
   * A card tapped on a reader: today's token for its patient, issued or (if they
   * already hold one) returned. Unknown and replaced cards are refused with 404.
   */
  async tap(rawCardId: string, actor: string, source: 'front-desk' | 'kiosk') {
    const cardId = normalizeCardId(rawCardId);
    const card = await this.findByCard(cardId);
    if (!card) throw new NotFoundException(CARD_NOT_REGISTERED);
    const issued = await this.queue.issue({ uhid: card.uhid }, actor, source);
    return { ...issued, cardId };
  }
}
