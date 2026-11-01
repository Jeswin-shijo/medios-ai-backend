import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { isoDate, parseIsoDay } from '../../common/utils/clinic-time';
import type { Actor } from '../beds/actor';
import { EscalationsService } from '../coordinator/escalations.service';
import { UserRole } from '../users/schemas/user.schema';
import { SKILLS, Shift, Skill } from './scheduling-catalogue';
import { SchedulingSettingsService } from './scheduling-settings.service';
import { covers, shiftWindow } from './scheduling-time';
import { RosterEntry, RosterEntryDocument } from './schemas/roster-entry.schema';
import { StaffMember, StaffMemberDocument } from './schemas/staff-member.schema';

export interface OnDuty {
  entryId: string;
  staffId: string;
  userId?: string;
  name: string;
  skills: string[];
  departmentCode?: string;
  shift: Shift;
  window: { start: Date; end: Date };
  titles: string[];
}

export interface StaffInput {
  id?: string;
  name: string;
  skills?: string[];
  departmentCode?: string;
  userId?: string | null;
  active?: boolean;
}

/** Skills that make a staff member a doctor who can take a consult. */
export const DOCTOR_SKILLS: Skill[] = [
  'physician', 'cardiologist', 'surgeon', 'orthopaedic-surgeon', 'obstetrician',
  'anaesthetist', 'paediatrician', 'ent-surgeon', 'radiologist', 'sonologist',
];

const SHIFTS: Shift[] = ['morning', 'evening', 'night', 'on-call'];
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const addDays = (day: string, n: number): string => {
  const d = parseIsoDay(day);
  d.setDate(d.getDate() + n);
  return isoDate(d);
};

const requireAdmin = (actor: Actor) => {
  if (actor?.role !== UserRole.ADMIN) throw new ForbiddenException('Only an admin can change the roster.');
};

const validDay = (v: unknown, label: string): string => {
  if (typeof v !== 'string' || !ISO_DAY.test(v) || isNaN(parseIsoDay(v).getTime()) || isoDate(parseIsoDay(v)) !== v) {
    throw new BadRequestException(`${label} must be a date as YYYY-MM-DD`);
  }
  return v;
};

/** The same moment with the date pinned to the demo clinic day (CLINIC_DATE), as clinicNow() does. */
function toClinicClock(at: Date): Date {
  const pinned = /^(\d{4})-(\d{2})-(\d{2})$/.exec(process.env.CLINIC_DATE ?? '');
  const d = new Date(at);
  if (pinned) d.setFullYear(Number(pinned[1]), Number(pinned[2]) - 1, Number(pinned[3]));
  return d;
}

/** Staff and the duty roster. Also the Coordinator's source for who holds a duty title now. */
@Injectable()
export class SchedulingRosterService implements OnModuleInit {
  constructor(
    @InjectModel(StaffMember.name) private readonly staffModel: Model<StaffMemberDocument>,
    @InjectModel(RosterEntry.name) private readonly entries: Model<RosterEntryDocument>,
    private readonly settings: SchedulingSettingsService,
    private readonly escalations: EscalationsService,
  ) {}

  onModuleInit(): void {
    // Escalations ask with the real moment; the roster is on the clinic clock.
    this.escalations.useDutySource((titleKey, at) => this.titleHolders(titleKey, toClinicClock(at)));
  }

  async staff(): Promise<StaffMemberDocument[]> {
    return this.staffModel.find().sort({ name: 1 }).lean<StaffMemberDocument[]>().exec();
  }

  /** Admin only. Creates a staff member, or updates the one with `id`. */
  async upsertStaff(actor: Actor, input: StaffInput): Promise<StaffMemberDocument> {
    requireAdmin(actor);
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    if (!name) throw new BadRequestException('Give the staff member a name');
    const skills = input.skills ?? [];
    if (!Array.isArray(skills) || skills.some((s) => !SKILLS.includes(s as Skill))) throw new BadRequestException('Unknown skill');
    const userId = typeof input.userId === 'string' && input.userId ? input.userId : undefined;
    if (userId && !Types.ObjectId.isValid(userId)) throw new BadRequestException('"userId" is not a user id');
    const fields = { name, skills: [...new Set(skills)], departmentCode: input.departmentCode ?? '', active: input.active ?? true };
    try {
      if (input.id) {
        if (!Types.ObjectId.isValid(input.id)) throw new NotFoundException('Staff member not found');
        const update: Record<string, unknown> = { $set: fields };
        if (userId) (update.$set as Record<string, unknown>).userId = userId;
        else update.$unset = { userId: 1 };
        const doc = await this.staffModel.findByIdAndUpdate(input.id, update, { new: true }).lean<StaffMemberDocument>().exec();
        if (!doc) throw new NotFoundException('Staff member not found');
        return doc;
      }
      const created = await this.staffModel.create({ ...fields, ...(userId ? { userId } : {}) });
      return created.toObject();
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new ConflictException('That login already belongs to another staff member');
      throw err;
    }
  }

  /** The seven days from `from`, with every entry in them. */
  async week(from: string) {
    validDay(from, '"from"');
    const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
    const rows = await this.entries.find({ date: { $in: days } }).sort({ date: 1, shift: 1 }).lean().exec();
    const staff = new Map((await this.staffModel.find({ _id: { $in: rows.map((r) => r.staff) } }).lean().exec()).map((s) => [String(s._id), s]));
    return {
      from,
      days,
      entries: rows.map((r) => ({
        id: String(r._id),
        date: r.date,
        shift: r.shift,
        staffId: String(r.staff),
        staffName: staff.get(String(r.staff))?.name ?? '',
        departmentCode: r.departmentCode,
        titles: r.titles,
        note: r.note,
      })),
    };
  }

  /** A 400 for any key that is not a known duty title (the Coordinator's titles). */
  async assertKnownTitles(titles: string[] | undefined): Promise<void> {
    if (!titles?.length) return;
    const known = new Set((await this.escalations.titles()).map((t) => t.key));
    const unknown = [...new Set(titles)].filter((t) => !known.has(t));
    if (unknown.length) throw new BadRequestException(`Unknown duty title: ${unknown.join(', ')}`);
  }

  /** Admin only. Puts a person on a shift, or changes the entry they already have for it. */
  async setEntry(actor: Actor, input: { date: string; shift: Shift; staffId: string; departmentCode?: string; titles?: string[]; note?: string }) {
    requireAdmin(actor);
    const date = validDay(input?.date, '"date"');
    if (!SHIFTS.includes(input.shift)) throw new BadRequestException('"shift" must be morning, evening, night or on-call');
    if (!Types.ObjectId.isValid(input.staffId)) throw new NotFoundException('Staff member not found');
    const person = await this.staffModel.findById(input.staffId).lean().exec();
    if (!person) throw new NotFoundException('Staff member not found');
    if (!person.active) throw new BadRequestException('That staff member is not active');
    const titles = input.titles ?? [];
    if (!Array.isArray(titles) || titles.some((t) => typeof t !== 'string' || !t)) throw new BadRequestException('"titles" must be duty title keys');
    if (titles.length && !person.userId) throw new BadRequestException('Only a staff member with a login can hold a duty title');
    const set: Record<string, unknown> = { titles: [...new Set(titles)], note: input.note ?? '' };
    const update: Record<string, unknown> = { $set: set };
    if (input.departmentCode) set.departmentCode = input.departmentCode;
    else update.$unset = { departmentCode: 1 };
    const doc = await this.entries
      .findOneAndUpdate({ date, shift: input.shift, staff: person._id }, update, { upsert: true, new: true, setDefaultsOnInsert: true })
      .lean()
      .exec();
    return doc;
  }

  async removeEntry(actor: Actor, id: string): Promise<{ removed: true }> {
    requireAdmin(actor);
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Roster entry not found');
    const gone = await this.entries.findByIdAndDelete(id).lean().exec();
    if (!gone) throw new NotFoundException('Roster entry not found');
    return { removed: true };
  }

  /** Admin only. Copies the seven days from `from` onto the seven days from `to`; entries already there stay as they are. */
  async copyWeek(actor: Actor, from: string, to: string): Promise<{ copied: number; skipped: number }> {
    requireAdmin(actor);
    validDay(from, '"from"');
    validDay(to, '"to"');
    const source = await this.entries.find({ date: { $in: Array.from({ length: 7 }, (_, i) => addDays(from, i)) } }).lean().exec();
    const offset = Math.round((parseIsoDay(to).getTime() - parseIsoDay(from).getTime()) / 86_400_000);
    let copied = 0;
    let skipped = 0;
    for (const e of source) {
      const res = await this.entries.updateOne(
        { date: addDays(e.date, offset), shift: e.shift, staff: e.staff },
        { $setOnInsert: { titles: e.titles, note: e.note, ...(e.departmentCode ? { departmentCode: e.departmentCode } : {}) } },
        { upsert: true },
      );
      if (res.upsertedCount) copied++;
      else skipped++;
    }
    return { copied, skipped };
  }

  /**
   * Everyone whose entry covers `at` (clinic clock). Entries dated the day before count, so a night entry dated 26 Sep
   * covers 02:00 on 27 Sep. On-call entries are left out unless `onCall` is set. Inactive staff are left out.
   */
  async onDuty(at: Date, opts: { onCall?: boolean } = {}): Promise<OnDuty[]> {
    const day = isoDate(at);
    const { shifts } = await this.settings.get();
    const rows = await this.entries.find({ date: { $in: [addDays(day, -1), day] } }).lean().exec();
    if (!rows.length) return [];
    const staff = new Map((await this.staffModel.find({ _id: { $in: rows.map((r) => r.staff) }, active: true }).lean().exec()).map((s) => [String(s._id), s]));
    const out: OnDuty[] = [];
    for (const r of rows) {
      const person = staff.get(String(r.staff));
      if (!person) continue;
      if (r.shift === 'on-call' && !opts.onCall) continue;
      const window = shiftWindow(r.date, r.shift, shifts);
      if (!covers(window, at, at)) continue;
      out.push({
        entryId: String(r._id),
        staffId: String(person._id),
        userId: person.userId,
        name: person.name,
        skills: person.skills,
        departmentCode: r.departmentCode || person.departmentCode || undefined,
        shift: r.shift,
        window,
        titles: r.titles,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name) || a.entryId.localeCompare(b.entryId));
  }

  /**
   * Who is on call for a department: the on-call entry for it, else a doctor of that department on a morning, evening
   * or night shift. Only people with a login can be paged. Null otherwise (the caller falls back to the Duty doctor title).
   */
  async onCall(departmentCode: string, at: Date): Promise<OnDuty | null> {
    const duty = (await this.onDuty(at, { onCall: true })).filter((d) => d.userId && d.departmentCode === departmentCode);
    return (
      duty.find((d) => d.shift === 'on-call') ??
      duty.find((d) => d.shift !== 'on-call' && d.skills.some((s) => DOCTOR_SKILLS.includes(s as Skill))) ??
      null
    );
  }

  /** User ids of the staff whose entry covers `at` and lists the title; null when nobody does. */
  async titleHolders(titleKey: string, at: Date): Promise<string[] | null> {
    const ids = (await this.onDuty(at, { onCall: true })).filter((d) => d.userId && d.titles.includes(titleKey)).map((d) => d.userId as string);
    return ids.length ? [...new Set(ids)] : null;
  }
}
