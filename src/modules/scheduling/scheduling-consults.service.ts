import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { clinicNow, displayDateTime } from '../../common/utils/clinic-time';
import type { Actor } from '../beds/actor';
import { CasesService } from '../coordinator/cases.service';
import { Priority as CasePriority } from '../coordinator/coordinator-types';
import { EscalationsService } from '../coordinator/escalations.service';
import { MessagesService } from '../coordinator/messages.service';
import { CoordinatorCounter, CoordinatorCounterDocument } from '../coordinator/schemas/coordinator-counter.schema';
import { Department, DepartmentDocument } from '../opd/schemas/department.schema';
import { OpDoctor, OpDoctorDocument } from '../opd/schemas/op-doctor.schema';
import { PatientsService } from '../patients/patients.service';
import { TaskAlertDocument, TaskAlertItem } from '../tasks-alerts/schemas/task-alert.schema';
import { UserRole } from '../users/schemas/user.schema';
import { Priority } from './scheduling-catalogue';
import { DOCTOR_SKILLS, SchedulingRosterService } from './scheduling-roster.service';
import { SchedulingSettingsService } from './scheduling-settings.service';
import { ConsultRequest, ConsultRequestDocument, ConsultStatus } from './schemas/consult-request.schema';
import { StaffMember, StaffMemberDocument } from './schemas/staff-member.schema';

const MIN_MS = 60_000;
const REASON_MAX = 500;
const CANCEL_REASON_MAX = 300;
const PRIORITIES: Priority[] = ['stat', 'urgent', 'routine'];
const CASE_PRIORITY: Record<Priority, CasePriority> = { stat: 'high', urgent: 'medium', routine: 'low' };
const OPEN: ConsultStatus[] = ['paged', 'accepted'];
const AGENT = 'Scheduling Agent';
const CHANGED = 'This consult has just changed; please reload.';
const LEAVING = ['home', 'transfer', 'left-against-advice', 'died'];

export interface ConsultRequestInput {
  patientId: string;
  departmentCode: string;
  priority: Priority;
  reason: string;
}

export interface ConsultView {
  id: string;
  number: string;
  patientId: string;
  patientUhid: string;
  patientName: string;
  caseId: string;
  departmentCode: string;
  department: string;
  priority: Priority;
  reason: string;
  status: ConsultStatus;
  pagedTo: { id: string; name: string } | null;
  pagedIds: string[];
  requestedBy: { id: string; name: string };
  requestedAt: string;
  dueAt: string;
  acceptedAt: string | null;
  seenAt: string | null;
  cancelled: { at: string; by: string; reason: string } | null;
}

type Lean = ConsultRequest & { _id: Types.ObjectId };
type Target = { ids: string[]; names: string[]; dutyDoctor: boolean };

const iso = (d?: Date | null) => (d ? new Date(d).toISOString() : null);
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/**
 * Consults: a doctor asks a department to see a patient. The agent pages the department's on-call doctor, or the Duty
 * doctor when that doctor has no login (spec 4.5). One alert and one clock share the link `scheduling-consult:<id>`; the
 * consult ladder escalates an unseen consult. Roles are checked by the routes; the ones that depend on the consult are here.
 */
@Injectable()
export class SchedulingConsultsService {
  constructor(
    @InjectModel(ConsultRequest.name) private readonly consults: Model<ConsultRequestDocument>,
    @InjectModel(StaffMember.name) private readonly staff: Model<StaffMemberDocument>,
    @InjectModel(OpDoctor.name) private readonly opDoctors: Model<OpDoctorDocument>,
    @InjectModel(Department.name) private readonly departments: Model<DepartmentDocument>,
    @InjectModel(CoordinatorCounter.name) private readonly counters: Model<CoordinatorCounterDocument>,
    @InjectModel(TaskAlertItem.name) private readonly alerts: Model<TaskAlertDocument>,
    private readonly patients: PatientsService,
    private readonly cases: CasesService,
    private readonly messages: MessagesService,
    private readonly settings: SchedulingSettingsService,
    private readonly roster: SchedulingRosterService,
    private readonly escalations: EscalationsService,
  ) {}

  // ---------- asking and paging ----------

  /** Opens or joins the patient's case, starts the Seen clock with consult-requested, then pages at once. */
  async request(actor: Actor, input: ConsultRequestInput): Promise<ConsultView> {
    if (!PRIORITIES.includes(input?.priority)) throw new BadRequestException('Priority must be stat, urgent or routine');
    const departmentCode = text(input.departmentCode);
    if (!departmentCode) throw new BadRequestException('Choose a department');
    const reason = text(input.reason);
    if (!reason || reason.length > REASON_MAX) throw new BadRequestException(`Give a reason of 1 to ${REASON_MAX} characters`);
    const patient = await this.patients.findOne(String(input.patientId));

    const { case: theCase } = await this.cases.openOrJoin({
      patientId: String(patient._id),
      patientUhid: patient.uhid,
      patientName: patient.name,
      kind: 'opd',
      priority: CASE_PRIORITY[input.priority],
      openedBy: 'scheduling',
    });
    const target = (await this.settings.get()).consultTargets[input.priority];
    const created = await this.consults.create({
      number: await this.nextNumber(),
      patient: patient._id,
      patientUhid: patient.uhid,
      patientName: patient.name,
      case: theCase._id,
      departmentCode,
      priority: input.priority,
      reason,
      status: 'paged',
      pagedIds: [],
      requestedBy: { id: actor.id, name: actor.name },
      requestedAt: new Date(),
      dueAt: new Date(Date.now() + target * MIN_MS),
    });
    const id = String(created._id);
    await this.announce(id, 'scheduling.consult-requested', 'requested');
    await this.page(id);
    return this.get(id);
  }

  /** Pages the department's on-call doctor, else the Duty doctor holders; writes the alert and sends consult-paged. */
  async page(id: string): Promise<ConsultView> {
    const c = await this.load(id);
    if (!OPEN.includes(c.status)) return this.get(id);
    const onCall = await this.roster.onCall(c.departmentCode, clinicNow());
    let target: Target;
    if (onCall?.userId) target = { ids: [onCall.userId], names: [onCall.name], dutyDoctor: false };
    else target = { ...(await this.escalations.holders('duty-doctor')), dutyDoctor: true };
    await this.setPaged(c, target);
    return this.get(id);
  }

  /** Pages someone else (a doctor of the department with a login). The clock keeps running. */
  async repage(actor: Actor, id: string, userId: string): Promise<ConsultView> {
    const c = await this.load(id);
    this.requireOwner(actor, c);
    if (!OPEN.includes(c.status)) throw new ConflictException(CHANGED);
    const doctor = await this.departmentDoctor(c.departmentCode, String(userId ?? ''));
    if (!doctor) throw new BadRequestException('Choose a doctor of this department who has a login');
    await this.setPaged(c, { ids: [String(userId)], names: [doctor.name], dutyDoctor: false }, true);
    return this.get(id);
  }

  private async setPaged(c: Lean, target: Target, again = false): Promise<void> {
    const id = String(c._id);
    const res = await this.consults
      .updateOne(
        { _id: c._id, status: { $in: OPEN } },
        { $set: { status: 'paged', pagedTo: { id: target.ids[0] ?? '', name: target.names[0] ?? '' }, pagedIds: target.ids }, $unset: { acceptedAt: '' } },
      )
      .exec();
    if (!res.matchedCount) throw new ConflictException(CHANGED);
    await this.writeAlert(id, target);
    await this.announce(id, 'scheduling.consult-paged', 'paged', again ? `:${Date.now()}` : ':first');
  }

  // ---------- the doctor's side ----------

  /** The paged doctor takes it. Only from paged. */
  async accept(actor: Actor, id: string): Promise<ConsultView> {
    const c = await this.load(id);
    await this.requireDoctorSide(actor, c);
    if (c.status !== 'paged') throw new ConflictException(CHANGED);
    const res = await this.consults.updateOne({ _id: c._id, status: 'paged' }, { $set: { status: 'accepted', acceptedAt: new Date() } }).exec();
    if (!res.modifiedCount) throw new ConflictException(CHANGED);
    await this.announce(id, 'scheduling.consult-accepted', 'accepted');
    return this.get(id);
  }

  /** The patient was seen: stops the clock and completes the page alert. */
  async seen(actor: Actor, id: string): Promise<ConsultView> {
    const c = await this.load(id);
    await this.requireDoctorSide(actor, c);
    if (!OPEN.includes(c.status)) throw new ConflictException(CHANGED);
    const res = await this.consults.updateOne({ _id: c._id, status: { $in: OPEN } }, { $set: { status: 'seen', seenAt: new Date() } }).exec();
    if (!res.modifiedCount) throw new ConflictException(CHANGED);
    await this.completeAlert(id);
    await this.announce(id, 'scheduling.consult-seen', 'seen');
    return this.get(id);
  }

  /** The requester or an admin withdraws it, with a reason. */
  async cancel(actor: Actor, id: string, reason: string): Promise<ConsultView> {
    const c = await this.load(id);
    this.requireOwner(actor, c);
    const why = text(reason);
    if (!why || why.length > CANCEL_REASON_MAX) throw new BadRequestException(`Give a reason of 1 to ${CANCEL_REASON_MAX} characters`);
    if (!OPEN.includes(c.status)) throw new ConflictException(CHANGED);
    if (!(await this.cancelOne(c, actor.name, why))) throw new ConflictException(CHANGED);
    return this.get(id);
  }

  /** The patient left the ER or was discharged: every open consult on the case is cancelled by the agent. Returns how many. */
  async onPatientLeft(caseId: string, reason: string): Promise<number> {
    if (!isValidObjectId(caseId)) return 0;
    const open = await this.consults.find({ case: caseId, status: { $in: OPEN } }).lean<Lean[]>().exec();
    let n = 0;
    for (const c of open) if (await this.cancelOne(c, AGENT, reason)) n++;
    return n;
  }

  private async cancelOne(c: Lean, by: string, reason: string): Promise<boolean> {
    const id = String(c._id);
    const res = await this.consults
      .updateOne({ _id: c._id, status: { $in: OPEN } }, { $set: { status: 'cancelled', cancelled: { at: new Date(), by, reason } } })
      .exec();
    if (!res.modifiedCount) return false;
    await this.completeAlert(id);
    await this.announce(id, 'scheduling.consult-cancelled', 'cancelled');
    return true;
  }

  // ---------- reads ----------

  async get(id: string): Promise<ConsultView> {
    return this.view(await this.load(id));
  }

  private async load(id: string): Promise<Lean> {
    if (!isValidObjectId(id)) throw new NotFoundException('Consult not found');
    const c = await this.consults.findById(id).lean<Lean>().exec();
    if (!c) throw new NotFoundException('Consult not found');
    return c;
  }

  private async view(c: Lean): Promise<ConsultView> {
    return {
      id: String(c._id),
      number: c.number,
      patientId: String(c.patient),
      patientUhid: c.patientUhid,
      patientName: c.patientName,
      caseId: String(c.case),
      departmentCode: c.departmentCode,
      department: await this.departmentName(c.departmentCode),
      priority: c.priority,
      reason: c.reason,
      status: c.status,
      pagedTo: c.pagedTo?.id ? { id: c.pagedTo.id, name: c.pagedTo.name } : null,
      pagedIds: c.pagedIds ?? [],
      requestedBy: { id: c.requestedBy.id, name: c.requestedBy.name },
      requestedAt: new Date(c.requestedAt).toISOString(),
      dueAt: new Date(c.dueAt).toISOString(),
      acceptedAt: iso(c.acceptedAt),
      seenAt: iso(c.seenAt),
      cancelled: c.cancelled ? { at: new Date(c.cancelled.at).toISOString(), by: c.cancelled.by, reason: c.cancelled.reason } : null,
    };
  }

  // ---------- who may act ----------

  private requireOwner(actor: Actor, c: Lean): void {
    if (actor?.role !== UserRole.ADMIN && actor?.id !== c.requestedBy.id) throw new ForbiddenException('Only the doctor who asked, or an admin, can do this.');
  }

  /** The paged user, any doctor of the department (staff member or OP doctor with a login), or an admin. */
  private async requireDoctorSide(actor: Actor, c: Lean): Promise<void> {
    if (actor?.role === UserRole.ADMIN || (c.pagedIds ?? []).includes(actor?.id)) return;
    if (actor?.role === UserRole.DOCTOR && (await this.departmentDoctor(c.departmentCode, actor.id))) return;
    throw new ForbiddenException('Only the paged doctor, a doctor of this department or an admin can do this.');
  }

  /** A doctor of the department with a login: a staff member with a doctor skill, or an OP doctor. */
  private async departmentDoctor(departmentCode: string, userId: string): Promise<{ name: string } | null> {
    if (!userId) return null;
    const s = await this.staff.findOne({ userId, active: true, departmentCode, skills: { $in: DOCTOR_SKILLS } }).select('name').lean().exec();
    if (s) return { name: s.name };
    const o = await this.opDoctors.findOne({ userId, departmentCode, active: true }).select('name').lean().exec();
    return o ? { name: o.name } : null;
  }

  // ---------- alert and messages ----------

  private async departmentName(code: string): Promise<string> {
    const d = await this.departments.findOne({ code }).select('name').lean().exec();
    return d?.name ?? code;
  }

  private async nextNumber(): Promise<string> {
    const c = await this.counters.findOneAndUpdate({ key: 'scheduling-consult' }, { $inc: { last: 1 } }, { upsert: true, new: true }).exec();
    return `CO-${String(c.last).padStart(4, '0')}`;
  }

  /** One alert per consult, shared with the clock (the escalation takes it over). Left closed if the consult closed meanwhile. */
  private async writeAlert(id: string, target: Target): Promise<void> {
    const c = await this.load(id);
    const department = await this.departmentName(c.departmentCode);
    const minutes = Math.max(0, Math.round((new Date(c.dueAt).getTime() - Date.now()) / MIN_MS));
    const names = target.names.join(', ') + (target.dutyDoctor ? ' (Duty doctor)' : '');
    await this.alerts
      .updateOne(
        { link: `scheduling-consult:${id}` },
        {
          $set: {
            title: `Consult: ${department} (${c.priority.toUpperCase()})`,
            subtitle: `For ${names} · ${c.number} · see within ${minutes} min`,
            patientName: c.patientName,
            uhid: c.patientUhid,
            type: 'System',
            category: 'Critical',
            priority: 'High',
            status: 'Pending',
            dueDateTime: displayDateTime(new Date(clinicNow().getTime() + (new Date(c.dueAt).getTime() - Date.now()))),
          },
        },
        { upsert: true },
      )
      .exec();
    const fresh = await this.consults.findById(id).select('status').lean().exec();
    if (fresh && !OPEN.includes(fresh.status)) await this.completeAlert(id);
  }

  private async completeAlert(id: string): Promise<void> {
    await this.alerts.updateOne({ link: `scheduling-consult:${id}` }, { $set: { status: 'Completed' } }).exec();
  }

  /** Every consult message carries dueAt; the summary never holds a name. */
  private async announce(id: string, type: string, what: string, keySuffix = ''): Promise<void> {
    const c = await this.load(id);
    const department = await this.departmentName(c.departmentCode);
    await this.messages.send({
      case: String(c.case),
      from: 'scheduling',
      to: ['coordinator'],
      type,
      priority: CASE_PRIORITY[c.priority],
      summary: `${c.number}: ${department} consult ${what} (${c.priority.toUpperCase()})`,
      payload: { consultId: id, number: c.number, department, priority: c.priority, dueAt: new Date(c.dueAt) },
      dedupeKey: `${type}:${id}${keySuffix}`,
    });
  }
}
