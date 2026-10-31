import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Department, DepartmentDocument } from './schemas/department.schema';
import { OpDoctor, OpDoctorDocument } from './schemas/op-doctor.schema';
import { DepartmentInput, DoctorInput } from './dto/opd.dto';
import { SettingsService } from '../settings/settings.service';
import { resolveQueueSettings } from '../queue/queue-settings';
import { resolveReceptionSettings } from '../reception/reception-settings';

const MAX_SESSIONS_PER_DAY = 3;

type SessionInput = { days: number[]; start: string; end: string };

/** Throws when a session ends before it starts, or sessions overlap (or exceed 3) on a weekday. */
function assertSessions(sessions: SessionInput[]) {
  const byDay = new Map<number, SessionInput[]>();
  for (const s of sessions) {
    if (s.end <= s.start) throw new BadRequestException(`Session ${s.start}-${s.end}: the end must be after the start`);
    for (const day of new Set(s.days)) byDay.set(day, [...(byDay.get(day) ?? []), s]);
  }
  for (const [day, list] of byDay) {
    if (list.length > MAX_SESSIONS_PER_DAY) throw new BadRequestException(`At most ${MAX_SESSIONS_PER_DAY} sessions are allowed on one day`);
    const sorted = [...list].sort((a, b) => a.start.localeCompare(b.start));
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].start < sorted[i - 1].end) {
        throw new BadRequestException(`Sessions ${sorted[i - 1].start}-${sorted[i - 1].end} and ${sorted[i].start}-${sorted[i].end} overlap on day ${day}`);
      }
    }
  }
}

/** The fields actually sent: a DTO instance carries explicit `undefined` for every field left out. */
function defined<T extends object>(dto: T): Partial<T> {
  return Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined)) as Partial<T>;
}

@Injectable()
export class OpdService {
  constructor(
    @InjectModel(Department.name) private departments: Model<DepartmentDocument>,
    @InjectModel(OpDoctor.name) private doctors: Model<OpDoctorDocument>,
    private readonly settings: SettingsService,
  ) {}

  // Departments

  listDepartments(opts: { activeOnly?: boolean } = {}): Promise<DepartmentDocument[]> {
    return this.departments
      .find(opts.activeOnly ? { active: true } : {})
      .sort({ order: 1, name: 1 })
      .exec();
  }

  async createDepartment(dto: DepartmentInput): Promise<DepartmentDocument> {
    if (await this.departments.exists({ code: dto.code })) {
      throw new ConflictException(`Department code "${dto.code}" already exists`);
    }
    return this.departments.create(dto);
  }

  async updateDepartment(id: string, dto: Partial<DepartmentInput>): Promise<DepartmentDocument> {
    const { code: _code, ...changes } = defined(dto); // the code never changes: doctors point at it
    const updated = await this.departments
      .findByIdAndUpdate(id, changes, { new: true, runValidators: true })
      .exec()
      .catch((e) => {
        if (e?.name === 'CastError') return null; // a malformed id is just "not found"
        throw e;
      });
    if (!updated) throw new NotFoundException('Department not found');
    return updated;
  }

  // Doctors

  listDoctors(opts: { departmentCode?: string; activeOnly?: boolean } = {}): Promise<OpDoctorDocument[]> {
    const filter: Record<string, unknown> = {};
    if (opts.departmentCode) filter.departmentCode = opts.departmentCode;
    if (opts.activeOnly) filter.active = true;
    return this.doctors.find(filter).sort({ name: 1 }).exec();
  }

  async getDoctor(id: string): Promise<OpDoctorDocument> {
    const doctor = await this.doctors.findById(id).exec().catch(() => null); // a malformed id is just "not found"
    if (!doctor) throw new NotFoundException('Doctor not found');
    return doctor;
  }

  async createDoctor(dto: DoctorInput): Promise<OpDoctorDocument> {
    const data = { avgConsultMinutes: 10, active: true, ...dto };
    await this.validateDoctor(data);
    return this.doctors.create(data).catch((e) => this.rethrowPrefixClash(e, data.tokenPrefix));
  }

  async updateDoctor(id: string, dto: Partial<DoctorInput>): Promise<OpDoctorDocument> {
    const changes = defined(dto);
    const doctor = await this.getDoctor(id);
    const merged = { ...doctor.toObject(), ...changes };
    // A doctor being switched off needs no valid room or department (the room may have been removed).
    await this.validateDoctor(merged, id, changes.active === false);
    doctor.set(changes);
    return doctor.save().catch((e) => this.rethrowPrefixClash(e, merged.tokenPrefix));
  }

  /** The doctor the kiosk uses by default: the one named in settings if active, else the first active one. */
  async defaultDoctor(): Promise<OpDoctorDocument | null> {
    const settings = resolveReceptionSettings((await this.settings.getSettings()).reception);
    if (settings.defaultDoctorId) {
      const chosen = await this.doctors.findById(settings.defaultDoctorId).exec().catch(() => null);
      if (chosen?.active) return chosen;
    }
    const departments = await this.listDepartments();
    const rank = new Map(departments.map((d, i) => [d.code, i]));
    const active = await this.listDoctors({ activeOnly: true });
    active.sort((a, b) => (rank.get(a.departmentCode) ?? Infinity) - (rank.get(b.departmentCode) ?? Infinity) || a.name.localeCompare(b.name));
    return active[0] ?? null;
  }

  /** The department's token letters when free among active doctors, else with 2, 3, ... added. */
  async suggestPrefix(departmentCode: string): Promise<string> {
    const department = await this.departments.findOne({ code: departmentCode }).exec();
    if (!department) throw new NotFoundException('Department not found');
    const used = new Set((await this.doctors.find({ active: true }, { tokenPrefix: 1 }).exec()).map((d) => d.tokenPrefix));
    if (!used.has(department.tokenPrefix)) return department.tokenPrefix;
    for (let n = 2; ; n++) {
      const suffix = String(n);
      const candidate = department.tokenPrefix.slice(0, 3 - suffix.length) + suffix; // stays within 3 characters
      if (!used.has(candidate)) return candidate;
    }
  }

  /** A concurrent request won the race for these token letters: answer as the up-front check would. */
  private async rethrowPrefixClash(error: any, tokenPrefix: string): Promise<never> {
    if (error?.code === 11000) {
      const clash = await this.doctors.findOne({ active: true, tokenPrefix }).exec();
      throw new ConflictException(`Token letters "${tokenPrefix}" are already used by Dr. ${clash?.name ?? 'another doctor'}`);
    }
    throw error;
  }

  private async validateDoctor(doctor: { departmentCode: string; room: string; tokenPrefix: string; sessions?: SessionInput[]; active?: boolean }, selfId?: string, deactivating = false) {
    if (deactivating) return;
    const rooms = resolveQueueSettings((await this.settings.getSettings()).queue).counters;
    if (!rooms.includes(doctor.room)) {
      throw new BadRequestException(`Room "${doctor.room}" is not one of the queue rooms (${rooms.join(', ')})`);
    }
    const department = await this.departments.findOne({ code: doctor.departmentCode }).exec();
    if (!department || !department.active) {
      throw new BadRequestException(`Department "${doctor.departmentCode}" does not exist or is not active`);
    }
    assertSessions(doctor.sessions ?? []);
    if (doctor.active !== false) {
      const clash = await this.doctors
        .findOne({ active: true, tokenPrefix: doctor.tokenPrefix, ...(selfId ? { _id: { $ne: selfId } } : {}) })
        .exec();
      if (clash) throw new ConflictException(`Token letters "${doctor.tokenPrefix}" are already used by Dr. ${clash.name}`);
    }
  }
}
