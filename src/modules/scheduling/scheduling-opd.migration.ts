import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { resolveCallAgentSettings, parseSessions } from '../calls/call-agent-settings';
import { Department, DepartmentDocument } from '../opd/schemas/department.schema';
import { OpDoctor, OpDoctorDocument } from '../opd/schemas/op-doctor.schema';
import { resolveQueueSettings } from '../queue/queue-settings';
import { SettingsService } from '../settings/settings.service';
import { User, UserDocument, UserRole } from '../users/schemas/user.schema';
import { SchedulingAppointmentsService } from './scheduling-appointments.service';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const GENERAL = { code: 'general-medicine', name: 'General Medicine', tokenPrefix: 'G', icon: 'local-hospital', color: '#1D6FE0', order: 1, active: true };
const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/**
 * A database that never ran the Scheduling seed has no OP doctors, and the web's booking dialog needs one. At start-up,
 * when there is none, this creates General Medicine (if the hospital has no department), one OP doctor named after the
 * first active doctor login (the call agent's clinic sessions as their sessions, the first queue room as their room) and
 * makes that doctor the default. It uses the models directly (the copied kiosk services stay untouched) and is safe to repeat.
 */
@Injectable()
export class SchedulingOpdMigration implements OnModuleInit {
  private readonly log = new Logger(SchedulingOpdMigration.name);

  constructor(
    @InjectModel(Department.name) private readonly departments: Model<DepartmentDocument>,
    @InjectModel(OpDoctor.name) private readonly doctors: Model<OpDoctorDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly settings: SettingsService,
    @Optional() private readonly appointments?: SchedulingAppointmentsService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.run();
    } catch (e) {
      this.log.warn(`The OP doctor migration failed: ${(e as Error).message}`);
    }
  }

  async run(): Promise<'created' | 'skipped'> {
    if (await this.doctors.exists({})) return 'skipped';
    const login = await this.users.findOne({ role: UserRole.DOCTOR, isActive: { $ne: false } }).sort({ createdAt: 1, _id: 1 }).lean().exec();
    if (!login) {
      this.log.warn('No OP doctor exists and there is no doctor login to create one from: set up doctors in Settings → Departments.');
      return 'skipped';
    }
    const stored = (await this.settings.getSettings()) as unknown as { queue?: unknown; callAgent?: unknown; reception?: Record<string, unknown> };
    const call = resolveCallAgentSettings(stored.callAgent);
    const days = WEEKDAYS.map((_, i) => i).filter((i) => !call.closedDays.includes(WEEKDAYS[i]));
    const sessions = parseSessions(call.clinicSessions).map(([start, end]) => ({ days, start: hhmm(start), end: hhmm(end) }));
    const room = resolveQueueSettings(stored.queue).counters[0];

    const active = await this.departments.find({ active: true }).sort({ order: 1, name: 1 }).lean().exec();
    const department =
      active.find((d) => d.code === GENERAL.code) ?? active[0] ?? (await this.departments.findOneAndUpdate({ code: GENERAL.code }, { $setOnInsert: GENERAL }, { upsert: true, new: true }).lean().exec());
    if (!department) return 'skipped';

    const doctor = await this.doctors.create({
      name: login.name,
      qualifications: '',
      departmentCode: department.code,
      fee: 0,
      room,
      tokenPrefix: department.tokenPrefix,
      sessions,
      avgConsultMinutes: 10,
      active: true,
      userId: String(login._id),
    });
    await this.settings.updateSettings({ reception: { ...(stored.reception ?? {}), defaultDoctorId: String(doctor._id) } } as never, { role: UserRole.ADMIN });
    // Older appointments have no doctor yet: they now get this one (the appointments' own start-up pass may have run first).
    await this.appointments?.backfill();
    this.log.log(`No OP doctor existed: created ${doctor.name} in ${department.name} (room ${room}) as the default doctor.`);
    return 'created';
  }
}
