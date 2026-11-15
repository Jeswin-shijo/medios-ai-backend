import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { Actor } from '../beds/actor';
import { SettingsService } from '../settings/settings.service';
import { SupportFaq, SupportFaqDocument } from './schemas/support-faq.schema';
import { SupportTemplate, SupportTemplateDocument } from './schemas/support-template.schema';
import type { Language } from './support-catalogue';
import { SupportSettingsService } from './support-settings.service';
import { SUP_ADMIN } from './support-roles';
import { DEFAULT_FAQS, DEFAULT_TEMPLATES } from './support-texts';

export interface SupportTemplateView {
  key: string;
  trigger: string | null;
  en: string;
  ta: string;
  approved: boolean;
  taChecked: boolean;
  updatedByName: string;
  updatedAt: Date;
}
export interface SupportFaqView {
  topic: string;
  title: string;
  keywords: string[];
  en: string;
  ta: string;
  approved: boolean;
  taChecked: boolean;
  updatedByName: string;
  updatedAt: Date;
}
export interface TemplatePatch {
  en?: string;
  ta?: string;
  approved?: boolean;
  taChecked?: boolean;
}
export interface FaqPatch extends TemplatePatch {
  title?: string;
  keywords?: string[];
}

const MAX_TEXT = 1000;
const TOPIC = /^[a-z0-9-]{2,40}$/;
export const FAQ_NOT_FOUND = "I don't have that information. Offer to arrange a call back.";

const fill = (text: string, values: Record<string, string>, optional: string[]) => {
  const missing: string[] = [];
  const out = text.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const v = values[name];
    if (typeof v === 'string' && v.trim() !== '') return v;
    if (!optional.includes(name) && !missing.includes(name)) missing.push(name);
    return '';
  });
  return {
    text: out
      .replace(/ {2,}/g, ' ')
      .replace(/ ([.,])/g, '$1')
      .trim(),
    missing
  };
};

/** Approved family texts and hospital facts: stored rows, filled from records. Never writes clinical text. */
@Injectable()
export class SupportTextsService {
  constructor(
    @InjectModel(SupportTemplate.name) private readonly templateModel: Model<SupportTemplateDocument>,
    @InjectModel(SupportFaq.name) private readonly faqModel: Model<SupportFaqDocument>,
    private readonly settings: SettingsService,
    private readonly supportSettings: SupportSettingsService
  ) {}

  /** Inserts missing keys and topics only; an edited row is never overwritten. */
  async ensureDefaults(): Promise<void> {
    await this.templateModel.bulkWrite(
      DEFAULT_TEMPLATES.map((t) => ({
        updateOne: {
          filter: { key: t.key },
          update: { $setOnInsert: { ...t, approved: true, taChecked: false, updatedByName: '', updatedAt: new Date() } },
          upsert: true
        }
      }))
    );
    await this.faqModel.bulkWrite(
      DEFAULT_FAQS.map((f) => ({
        updateOne: {
          filter: { topic: f.topic },
          update: { $setOnInsert: { ...f, approved: true, taChecked: false, updatedByName: '', updatedAt: new Date() } },
          upsert: true
        }
      }))
    );
  }

  private view<T>(doc: any, fields: string[]): T {
    const o: any = {};
    for (const f of fields) o[f] = doc[f];
    return o as T;
  }

  async templates(): Promise<SupportTemplateView[]> {
    const rows = await this.templateModel.find().lean().exec();
    const order = (k: string) => DEFAULT_TEMPLATES.findIndex((d) => d.key === k);
    return rows
      .sort((a, b) => (order(a.key) < 0 ? 999 : order(a.key)) - (order(b.key) < 0 ? 999 : order(b.key)) || a.key.localeCompare(b.key))
      .map((r) => this.view<SupportTemplateView>(r, ['key', 'trigger', 'en', 'ta', 'approved', 'taChecked', 'updatedByName', 'updatedAt']));
  }

  private async faqRows() {
    const rows = await this.faqModel.find().lean().exec();
    const order = (t: string) => DEFAULT_FAQS.findIndex((d) => d.topic === t);
    return rows.sort((a, b) => (order(a.topic) < 0 ? 999 : order(a.topic)) - (order(b.topic) < 0 ? 999 : order(b.topic)) || a.topic.localeCompare(b.topic));
  }

  async faqs(): Promise<SupportFaqView[]> {
    return (await this.faqRows()).map((r) =>
      this.view<SupportFaqView>(r, ['topic', 'title', 'keywords', 'en', 'ta', 'approved', 'taChecked', 'updatedByName', 'updatedAt'])
    );
  }

  private assertAdmin(actor: Actor) {
    if (!actor || !SUP_ADMIN.includes(actor.role)) throw new ForbiddenException('Only an admin can change the texts.');
  }

  private cleanPatch(patch: FaqPatch): Record<string, unknown> {
    if (!patch || typeof patch !== 'object') throw new BadRequestException('Send the changes to save');
    const set: Record<string, unknown> = {};
    for (const f of ['en', 'ta'] as const) {
      if (patch[f] === undefined) continue;
      if (typeof patch[f] !== 'string' || patch[f]!.length > MAX_TEXT) throw new BadRequestException(`The text can be at most ${MAX_TEXT} characters`);
      if (f === 'en' && !patch.en!.trim()) throw new BadRequestException('The English text cannot be empty');
      set[f] = patch[f]!.trim();
    }
    for (const f of ['approved', 'taChecked'] as const) {
      if (patch[f] === undefined) continue;
      if (typeof patch[f] !== 'boolean') throw new BadRequestException(`${f} must be true or false`);
      set[f] = patch[f];
    }
    if (patch.title !== undefined) {
      if (typeof patch.title !== 'string' || !patch.title.trim() || patch.title.length > 80)
        throw new BadRequestException('The title must be 1 to 80 characters');
      set.title = patch.title.trim();
    }
    if (patch.keywords !== undefined) {
      if (!Array.isArray(patch.keywords) || patch.keywords.length > 20 || patch.keywords.some((k) => typeof k !== 'string' || !k.trim() || k.length > 40))
        throw new BadRequestException('Keywords must be up to 20 short words');
      set.keywords = [...new Set(patch.keywords.map((k) => k.trim().toLowerCase()))];
    }
    return set;
  }

  async saveTemplate(actor: Actor, key: string, patch: TemplatePatch): Promise<SupportTemplateView> {
    this.assertAdmin(actor);
    const set = this.cleanPatch({ en: patch?.en, ta: patch?.ta, approved: patch?.approved, taChecked: patch?.taChecked });
    const doc = await this.templateModel
      .findOneAndUpdate({ key }, { $set: { ...set, updatedByName: actor.name, updatedAt: new Date() } }, { new: true })
      .lean()
      .exec();
    if (!doc) throw new BadRequestException('Unknown template');
    return this.view<SupportTemplateView>(doc, ['key', 'trigger', 'en', 'ta', 'approved', 'taChecked', 'updatedByName', 'updatedAt']);
  }

  async saveFaq(actor: Actor, topic: string, patch: FaqPatch): Promise<SupportFaqView> {
    this.assertAdmin(actor);
    const set = this.cleanPatch(patch);
    const doc = await this.faqModel
      .findOneAndUpdate({ topic }, { $set: { ...set, updatedByName: actor.name, updatedAt: new Date() } }, { new: true })
      .lean()
      .exec();
    if (!doc) throw new BadRequestException('Unknown topic');
    return this.view<SupportFaqView>(doc, ['topic', 'title', 'keywords', 'en', 'ta', 'approved', 'taChecked', 'updatedByName', 'updatedAt']);
  }

  async addFaq(actor: Actor, input: { topic: string; title: string; keywords?: string[]; en: string; ta?: string }): Promise<SupportFaqView> {
    this.assertAdmin(actor);
    if (!input || typeof input.topic !== 'string' || !TOPIC.test(input.topic))
      throw new BadRequestException('The topic must be 2 to 40 letters, numbers or dashes');
    const set = this.cleanPatch({ title: input.title, keywords: input.keywords ?? [], en: input.en, ta: input.ta ?? '' });
    if (!set.title || !set.en) throw new BadRequestException('A title and an English text are needed');
    if (await this.faqModel.exists({ topic: input.topic })) throw new BadRequestException('That topic already exists');
    const doc = await this.faqModel.create({
      topic: input.topic,
      ta: '',
      keywords: [],
      ...set,
      approved: true,
      taChecked: false,
      updatedByName: actor.name,
      updatedAt: new Date()
    });
    return this.view<SupportFaqView>(doc, ['topic', 'title', 'keywords', 'en', 'ta', 'approved', 'taChecked', 'updatedByName', 'updatedAt']);
  }

  async render(
    key: string,
    language: Language,
    values: Record<string, string>,
    optional: string[] = []
  ): Promise<{ text: string; language: Language; missing: string[] } | null> {
    const row = await this.templateModel.findOne({ key }).lean().exec();
    if (!row || !row.approved) return null;
    const useTa = language === 'ta' && !!row.ta?.trim();
    const { text, missing } = fill(useTa ? row.ta : row.en, values, optional);
    return { text, language: useTa ? 'ta' : 'en', missing };
  }

  private async facts(): Promise<Record<string, string>> {
    const hospital = (await this.settings.getSettings()).hospital as any;
    const cfg = await this.supportSettings.get();
    return { visiting: cfg.visitingHours, hospital: hospital?.name ?? '', hospitalPhone: hospital?.phone ?? '', address: hospital?.address ?? '' };
  }

  private async matches(asked: string): Promise<any[]> {
    const q = asked.trim().toLowerCase();
    const words = q.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const rows = (await this.faqRows()).filter((r) => r.approved);
    return rows.filter((r) => r.topic === q || (r.keywords ?? []).some((k) => words.includes(k.toLowerCase())));
  }

  async findFaq(topic: string, language: Language): Promise<{ found: boolean; topic?: string; text: string }> {
    const hit = (await this.matches(String(topic ?? '')))[0];
    if (!hit) return { found: false, text: FAQ_NOT_FOUND };
    const useTa = language === 'ta' && !!hit.ta?.trim();
    const facts = await this.facts();
    const text = (useTa ? hit.ta : hit.en).replace(/\{(\w+)\}/g, (_m: string, n: string) => facts[n] ?? '');
    return { found: true, topic: hit.topic, text: text.replace(/ {2,}/g, ' ').trim() };
  }

  /** The desk's search: a topic, a keyword or a word of the title; approved or not. */
  async searchFaqs(q: string): Promise<SupportFaqView[]> {
    const needle = String(q ?? '')
      .trim()
      .toLowerCase();
    const all = await this.faqs();
    if (!needle) return all;
    const words = needle.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    return all.filter((f) => f.topic.includes(needle) || f.title.toLowerCase().includes(needle) || f.keywords.some((k) => words.includes(k.toLowerCase())));
  }

  /** Never empty: the stored text, else the built-in default. */
  async emergencyLine(language: Language): Promise<string> {
    const def = DEFAULT_TEMPLATES.find((t) => t.key === 'emergency-line')!;
    const row = await this.templateModel.findOne({ key: 'emergency-line' }).lean().exec();
    const src = row && row.approved ? row : def;
    const text = language === 'ta' && src.ta?.trim() ? src.ta : src.en;
    return text.trim() || def.en;
  }
}
