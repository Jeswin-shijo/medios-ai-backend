import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { clinicNow } from '../../common/utils/clinic-time';
import type { Actor } from '../beds/actor';
import type { WardType } from '../beds/bed-types';
import { Ward, WardDocument } from '../beds/schemas/ward.schema';
import { OpDoctor, OpDoctorDocument } from '../opd/schemas/op-doctor.schema';
import { UserRole } from '../users/schemas/user.schema';
import { PRICE_CATEGORIES, PRICE_CODE_PATTERN, PriceCategory } from './revenue-catalogue';
import { PriceItem, PriceItemDocument } from './schemas/price-item.schema';

export interface PriceInput {
  code: string;
  name: string;
  category: string;
  unit?: string;
  price: number;
  active?: boolean;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

@Injectable()
export class PriceListService {
  private readonly log = new Logger(PriceListService.name);

  constructor(
    @InjectModel(PriceItem.name) private readonly items: Model<PriceItemDocument>,
    @InjectModel(Ward.name) private readonly wards: Model<WardDocument>,
    @InjectModel(OpDoctor.name) private readonly doctors: Model<OpDoctorDocument>,
  ) {}

  async list(filter: { category?: string; q?: string } = {}) {
    const query: Record<string, unknown> = {};
    if (filter.category) query.category = filter.category;
    if (filter.q?.trim()) {
      const re = new RegExp(escape(filter.q.trim()), 'i');
      query.$or = [{ code: re }, { name: re }];
    }
    return this.items.find(query).sort({ category: 1, code: 1 }).lean();
  }

  /** Admin only. Creates or changes one price; the change is logged and no existing charge is touched. */
  async upsert(actor: Actor, input: PriceInput) {
    if (actor?.role !== UserRole.ADMIN) throw new ForbiddenException('Only an admin can change the price list.');
    const code = typeof input?.code === 'string' ? input.code.trim() : '';
    if (!PRICE_CODE_PATTERN.test(code)) throw new BadRequestException('The code must look like "lab:cbc" (lower case letters, then a colon, then letters, digits, dots or dashes).');
    if (!PRICE_CATEGORIES.includes(input.category as PriceCategory)) throw new BadRequestException(`"${input.category}" is not a price category`);
    if (typeof input.price !== 'number' || !Number.isInteger(input.price) || input.price < 0) throw new BadRequestException('The price must be a whole number of rupees, 0 or more.');
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) throw new BadRequestException('Give the item a name');
    const unit = typeof input.unit === 'string' && input.unit.trim() ? input.unit.trim() : 'each';
    const active = input.active === undefined ? true : input.active === true;

    const existing = await this.items.findOne({ code });
    const change = { at: clinicNow(), by: actor.name, from: existing ? existing.price : null, to: input.price };
    if (!existing) {
      const created = await this.items.create({ code, name, category: input.category, unit, price: input.price, active, log: [change] });
      return created.toObject();
    }
    const set: Record<string, unknown> = { name, category: input.category, unit, active, price: input.price };
    const update: Record<string, unknown> = { $set: set };
    if (existing.price !== input.price) update.$push = { log: change };
    return this.items.findOneAndUpdate({ code }, update, { new: true }).lean();
  }

  /** An inactive or missing item counts as missing: price 0, name = code. A price of 0 also needs a price. */
  async priceFor(code: string): Promise<{ price: number; name: string; needsPrice: boolean }> {
    const item = await this.items.findOne({ code, active: true }).lean();
    if (!item) return { price: 0, name: code, needsPrice: true };
    return { price: item.price, name: item.name, needsPrice: item.price === 0 };
  }

  /** The ward's daily rate. An unknown ward gives 0 and a warning, never an error. */
  async bedRate(wardId: string): Promise<{ price: number; wardType: WardType; wardName: string }> {
    let ward: WardDocument | null = null;
    try {
      ward = await this.wards.findById(wardId).lean<WardDocument>();
    } catch {
      ward = null;
    }
    if (!ward) {
      this.log.warn(`Bed rate asked for an unknown ward (${String(wardId)}); charging 0.`);
      return { price: 0, wardType: 'general', wardName: '' };
    }
    return { price: ward.ratePerDay, wardType: ward.type, wardName: ward.name };
  }

  /** The OPD fee of an OP doctor at check-in. An unknown doctor, or a fee of 0, needs a price. */
  async opdFee(doctorId: string): Promise<{ price: number; doctorName: string; needsPrice: boolean }> {
    let doctor: OpDoctorDocument | null = null;
    try {
      doctor = await this.doctors.findById(doctorId).lean<OpDoctorDocument>();
    } catch {
      doctor = null;
    }
    if (!doctor) return { price: 0, doctorName: '', needsPrice: true };
    return { price: doctor.fee, doctorName: doctor.name, needsPrice: !(doctor.fee > 0) };
  }
}
