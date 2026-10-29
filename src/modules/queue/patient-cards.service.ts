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

    const existing = await this.cards.findOne({ cardId }).exec();
    if (existing?.uhid === patient.uhid) return existing;
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

  /** The UHID a card is linked to. Reads only: no token, and `lastUsedAt` is left alone. */
  async findUhid(rawCardId: string): Promise<string> {
    const card = await this.cards.findOne({ cardId: normalizeCardId(rawCardId) }).exec();
    if (!card) throw new NotFoundException('This card is not registered. Please go to the front desk.');
    return card.uhid;
  }

  /**
   * A card tapped on a reader: today's token for its patient, issued or (if they
   * already hold one) returned. Unknown cards are refused with 404.
   */
  async tap(rawCardId: string, actor: string, source: 'front-desk' | 'kiosk') {
    const cardId = normalizeCardId(rawCardId);
    const card = await this.cards.findOneAndUpdate({ cardId }, { $set: { lastUsedAt: new Date() } }, { new: true }).exec();
    if (!card) throw new NotFoundException('This card is not registered. Please go to the front desk.');
    const issued = await this.queue.issue({ uhid: card.uhid }, actor, source);
    return { ...issued, cardId };
  }
}
