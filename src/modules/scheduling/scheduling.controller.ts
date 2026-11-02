import { BadRequestException, Body, Controller, Delete, Get, Logger, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { clinicNow, parseIsoDay } from '../../common/utils/clinic-time';
import { actorOf } from '../beds/actor';
import { OpdService } from '../opd/opd.service';
import { UserRole } from '../users/schemas/user.schema';
import {
  ActivateCathLabDto, AppointmentsQueryDto, BoardQueryDto, BookAppointmentDto, ConsultReasonDto, ConsultRequestDto, ConsultsQueryDto, CopyWeekDto,
  DoctorProfileDto, SchedulingDoctorsQueryDto, FollowUpDto, SchedulingIdParam, MoveAppointmentDto, NoteDto, OverviewQueryDto, ProcedureRequestDto, ProceduresQueryDto, SchedulingReasonDto,
  RepageDto, RoomBlockDto, RoomKeyParam, RosterEntryDto, RosterQueryDto, SchedulingSlotsQueryDto, SchedulingSnapshotQueryDto, StaffDto, WaitBookDto, WaitlistQueryDto,
  isRealDay,
} from './dto/scheduling.dto';
import { PROCEDURES, ROOMS, SKILLS, SKILL_LABEL } from './scheduling-catalogue';
import { SchedulingAppointmentsService } from './scheduling-appointments.service';
import { SchedulingConsultsService } from './scheduling-consults.service';
import { SchedulingDoctorsService } from './scheduling-doctors.service';
import { SchedulingFollowupsService } from './scheduling-followups.service';
import { SchedulingOverviewService } from './scheduling-overview.service';
import { SchedulingProceduresService } from './scheduling-procedures.service';
import { SchedulingRoomsService } from './scheduling-rooms.service';
import { SchedulingRosterService } from './scheduling-roster.service';
import { SchedulingSettingsService } from './scheduling-settings.service';
import { SchedulingWaitlistService } from './scheduling-waitlist.service';

/** The Scheduling page and every read. */
const SCHED_READ = [UserRole.ADMIN, UserRole.DOCTOR, UserRole.NURSE, UserRole.STAFF];
/** Book, move and cancel appointments; every waitlist action. */
const SCHED_BOOK = [UserRole.ADMIN, UserRole.DOCTOR, UserRole.STAFF];
/** Request procedures and consults, Activate cath lab, order follow-ups, accept and complete consults. */
const SCHED_CLINICAL = [UserRole.ADMIN, UserRole.DOCTOR];
/** Start and finish procedures. */
const SCHED_TEAM = [UserRole.ADMIN, UserRole.DOCTOR, UserRole.NURSE];
/** Roster edits, staff, rooms and blocks, Settings → Scheduling. */
const SCHED_ADMIN = [UserRole.ADMIN];

/** A day (clinic clock) or a moment. */
const fromOf = (v?: string): Date => {
  if (!v) return clinicNow();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) && isRealDay(v) ? parseIsoDay(v) : momentOf(v, 'from');
  return d;
};

/** A moment on the clinic clock (YYYY-MM-DDTHH:mm); a 400 when it is not a real one. */
function momentOf(v: string, label: string): Date {
  const d = new Date(v);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(v) || !isRealDay(v) || isNaN(d.getTime())) throw new BadRequestException(`${label} must be a real date, or a date and time`);
  return d;
}

function plainObject(body: unknown): void {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('The body must be an object');
}

@ApiTags('Scheduling')
@ApiBearerAuth()
@Controller('scheduling')
export class SchedulingController {
  private readonly logger = new Logger(SchedulingController.name);

  constructor(
    private readonly overview: SchedulingOverviewService,
    private readonly doctors: SchedulingDoctorsService,
    private readonly appointments: SchedulingAppointmentsService,
    private readonly procedures: SchedulingProceduresService,
    private readonly consults: SchedulingConsultsService,
    private readonly roster: SchedulingRosterService,
    private readonly rooms: SchedulingRoomsService,
    private readonly waitlist: SchedulingWaitlistService,
    private readonly followups: SchedulingFollowupsService,
    private readonly settings: SchedulingSettingsService,
    private readonly opd: OpdService,
  ) {}

  /** A roster or room change may free a room or a team: waiting requests are tried again (spec 4.3). Never blocks or fails the save. */
  private retry(): void {
    void this.procedures.retryWaiting().catch((e) => this.logger.error(`Retrying waiting procedures failed: ${(e as Error)?.message ?? e}`));
  }

  // ---------- overview, reference data ----------

  @Get('overview')
  @Roles(...SCHED_READ)
  @ApiOperation({ summary: 'Scheduling cards, the day\'s schedule, calendar, room use and conflicts' })
  getOverview(@Query() q: OverviewQueryDto) {
    return this.overview.overview(q.day);
  }

  @Get('snapshots')
  @Roles(...SCHED_READ)
  @ApiOperation({ summary: 'Hourly scheduling counts for the last 24 hours or 7 days' })
  snapshots(@Query() q: SchedulingSnapshotQueryDto) {
    return this.overview.series(q.range ?? '24h');
  }

  @Post('summary')
  @Roles(...SCHED_READ)
  @ApiOperation({ summary: 'Summarise today (the AI sees counts only)' })
  summary() {
    return this.overview.summarise();
  }

  @Get('catalogue')
  @Roles(...SCHED_READ)
  @ApiOperation({ summary: 'Rooms, procedures with their pre-tests, skills, shifts and departments' })
  async catalogue() {
    const [cfg, departments] = await Promise.all([this.settings.get(), this.opd.listDepartments({ activeOnly: true })]);
    return {
      rooms: ROOMS.map((r) => ({ key: r.key, name: r.name, kind: r.kind, ...(cfg.roomHours[r.key] ?? { open: r.open, close: r.close, turnover: r.turnover }) })),
      procedures: PROCEDURES.map((p) => ({ key: p.key, name: p.name, roomKind: p.roomKind, minutes: cfg.procedureMinutes[p.key] ?? p.minutes, team: p.team, preTests: p.preTests, contrast: p.contrast })),
      skills: SKILLS.map((key) => ({ key, label: SKILL_LABEL[key] })),
      shifts: (Object.keys(cfg.shifts) as (keyof typeof cfg.shifts)[]).map((key) => ({ key, ...cfg.shifts[key] })),
      priorities: ['stat', 'urgent', 'routine'],
      departments: departments.map((d) => ({ code: d.code, name: d.name })),
    };
  }

  // ---------- doctors and appointments ----------

  @Get('doctors')
  @Roles(...SCHED_READ)
  @ApiOperation({ summary: 'OP doctors with their slot length and leave' })
  async listDoctors(@Query() q: SchedulingDoctorsQueryDto) {
    return { doctors: await this.doctors.listWithProfiles(q.activeOnly === 'true') };
  }

  @Put('doctors/:id/profile')
  @Roles(...SCHED_CLINICAL)
  @ApiOperation({ summary: 'Slot length (admin) and leave (admin, or the doctor on their own profile)' })
  setProfile(@CurrentUser() user: unknown, @Param() p: SchedulingIdParam, @Body() dto: DoctorProfileDto) {
    return this.doctors.setProfile(actorOf(user), p.id, { slotMinutes: dto.slotMinutes, leave: dto.leave });
  }

  @Get('doctors/:id/slots')
  @Roles(...SCHED_READ)
  @ApiOperation({ summary: 'The next free slots of a doctor' })
  async slots(@Param() p: SchedulingIdParam, @Query() q: SchedulingSlotsQueryDto) {
    return { slots: await this.doctors.freeSlots(p.id, fromOf(q.from), q.count ?? 10) };
  }

  @Get('appointments')
  @Roles(...SCHED_READ)
  @ApiOperation({ summary: 'The appointments of a day, optionally of one doctor' })
  async listAppointments(@Query() q: AppointmentsQueryDto) {
    return { appointments: await this.appointments.list(q.date, q.doctorId) };
  }

  @Post('appointments')
  @Roles(...SCHED_BOOK)
  @ApiOperation({ summary: 'Book an appointment' })
  book(@CurrentUser() user: unknown, @Body() dto: BookAppointmentDto) {
    return this.appointments.book(actorOf(user), dto);
  }

  @Patch('appointments/:id/move')
  @Roles(...SCHED_BOOK)
  @ApiOperation({ summary: 'Move an appointment to another slot' })
  move(@CurrentUser() user: unknown, @Param() p: SchedulingIdParam, @Body() dto: MoveAppointmentDto) {
    return this.appointments.move(actorOf(user), p.id, dto);
  }

  @Patch('appointments/:id/cancel')
  @Roles(...SCHED_BOOK)
  @ApiOperation({ summary: 'Cancel an appointment' })
  cancel(@CurrentUser() user: unknown, @Param() p: SchedulingIdParam, @Body() dto: SchedulingReasonDto) {
    return this.appointments.cancel(actorOf(user), p.id, dto.reason);
  }

  @Post('appointments/:id/wants-earlier')
  @Roles(...SCHED_BOOK)
  @ApiOperation({ summary: 'The patient would take an earlier time: put the appointment on the waitlist' })
  wantsEarlier(@CurrentUser() user: unknown, @Param() p: SchedulingIdParam) {
    return this.waitlist.markEarlierWanted(actorOf(user), p.id);
  }

  // ---------- procedures ----------

  @Get('procedures')
  @Roles(...SCHED_READ)
  @ApiOperation({ summary: 'Procedure requests, optionally of one status or day' })
  async listProcedures(@Query() q: ProceduresQueryDto) {
    return { procedures: await this.procedures.list({ status: q.status, day: q.day, patientId: q.patientId }) };
  }

  @Get('procedures/board')
  @Roles(...SCHED_READ)
  @ApiOperation({ summary: 'One clinic day by room: bookings, blocks and requests not booked yet' })
  board(@Query() q: BoardQueryDto) {
    return this.procedures.board(q.day);
  }

  @Post('procedures')
  @Roles(...SCHED_CLINICAL)
  @ApiOperation({ summary: 'Request a procedure; the agent books the earliest room, time and team' })
  requestProcedure(@CurrentUser() user: unknown, @Body() dto: ProcedureRequestDto) {
    return this.procedures.request(actorOf(user), dto);
  }

  @Post('procedures/activate-cath-lab')
  @Roles(...SCHED_CLINICAL)
  @ApiOperation({ summary: 'Activate cath lab: a STAT coronary angiography from now' })
  activateCathLab(@CurrentUser() user: unknown, @Body() dto: ActivateCathLabDto) {
    return this.procedures.activateCathLab(actorOf(user), dto.patientId, dto.note);
  }

  @Post('procedures/:id/start')
  @Roles(...SCHED_TEAM)
  @ApiOperation({ summary: 'Start a procedure' })
  startProcedure(@CurrentUser() user: unknown, @Param() p: SchedulingIdParam) {
    return this.procedures.start(actorOf(user), p.id);
  }

  @Post('procedures/:id/done')
  @Roles(...SCHED_TEAM)
  @ApiOperation({ summary: 'Finish a procedure' })
  doneProcedure(@CurrentUser() user: unknown, @Param() p: SchedulingIdParam, @Body() dto: NoteDto) {
    return this.procedures.done(actorOf(user), p.id, dto.note);
  }

  @Post('procedures/:id/cancel')
  @Roles(...SCHED_CLINICAL)
  @ApiOperation({ summary: 'Cancel a procedure' })
  cancelProcedure(@CurrentUser() user: unknown, @Param() p: SchedulingIdParam, @Body() dto: SchedulingReasonDto) {
    return this.procedures.cancel(actorOf(user), p.id, dto.reason);
  }

  // ---------- consults ----------

  @Get('consults')
  @Roles(...SCHED_READ)
  @ApiOperation({ summary: 'Consult requests, newest first, optionally of one status' })
  async listConsults(@Query() q: ConsultsQueryDto) {
    return { consults: await this.consults.list(q.status, q.patientId) };
  }

  @Post('consults')
  @Roles(...SCHED_CLINICAL)
  @ApiOperation({ summary: 'Ask a department to see a patient; the on-call doctor is paged' })
  requestConsult(@CurrentUser() user: unknown, @Body() dto: ConsultRequestDto) {
    return this.consults.request(actorOf(user), dto);
  }

  @Post('consults/:id/accept')
  @Roles(...SCHED_CLINICAL)
  @ApiOperation({ summary: 'Accept a consult' })
  acceptConsult(@CurrentUser() user: unknown, @Param() p: SchedulingIdParam) {
    return this.consults.accept(actorOf(user), p.id);
  }

  @Post('consults/:id/seen')
  @Roles(...SCHED_CLINICAL)
  @ApiOperation({ summary: 'Mark a consult seen' })
  seenConsult(@CurrentUser() user: unknown, @Param() p: SchedulingIdParam) {
    return this.consults.seen(actorOf(user), p.id);
  }

  @Post('consults/:id/repage')
  @Roles(...SCHED_CLINICAL)
  @ApiOperation({ summary: 'Page another doctor for a consult' })
  repageConsult(@CurrentUser() user: unknown, @Param() p: SchedulingIdParam, @Body() dto: RepageDto) {
    return this.consults.repage(actorOf(user), p.id, dto.userId);
  }

  @Post('consults/:id/cancel')
  @Roles(...SCHED_CLINICAL)
  @ApiOperation({ summary: 'Cancel a consult' })
  cancelConsult(@CurrentUser() user: unknown, @Param() p: SchedulingIdParam, @Body() dto: ConsultReasonDto) {
    return this.consults.cancel(actorOf(user), p.id, dto.reason);
  }

  // ---------- roster, staff ----------

  @Get('roster')
  @Roles(...SCHED_READ)
  @ApiOperation({ summary: 'The seven days of the duty roster from a date' })
  getRoster(@Query() q: RosterQueryDto) {
    return this.roster.week(q.from);
  }

  @Put('roster/entries')
  @Roles(...SCHED_ADMIN)
  @ApiOperation({ summary: 'Put a person on a shift, or change their entry' })
  async setEntry(@CurrentUser() user: unknown, @Body() dto: RosterEntryDto) {
    await this.roster.assertKnownTitles(dto.titles);
    const saved = await this.roster.setEntry(actorOf(user), dto);
    this.retry();
    return saved;
  }

  @Delete('roster/entries/:id')
  @Roles(...SCHED_ADMIN)
  @ApiOperation({ summary: 'Remove a roster entry' })
  async removeEntry(@CurrentUser() user: unknown, @Param() p: SchedulingIdParam) {
    const out = await this.roster.removeEntry(actorOf(user), p.id);
    this.retry();
    return out;
  }

  @Post('roster/copy-week')
  @Roles(...SCHED_ADMIN)
  @ApiOperation({ summary: 'Copy a week of the roster onto another week' })
  async copyWeek(@CurrentUser() user: unknown, @Body() dto: CopyWeekDto) {
    const out = await this.roster.copyWeek(actorOf(user), dto.from, dto.to);
    this.retry();
    return out;
  }

  @Get('staff')
  @Roles(...SCHED_READ)
  @ApiOperation({ summary: 'Staff members who can be put on the roster' })
  async staff() {
    return { staff: await this.roster.staff() };
  }

  @Get('staff/logins')
  @Roles(...SCHED_ADMIN)
  @ApiOperation({ summary: 'Logins a staff member can be linked to (not held by another staff member)' })
  @ApiQuery({ name: 'staffId', required: false })
  async staffLogins(@CurrentUser() user: unknown, @Query('staffId') staffId?: string) {
    return { logins: await this.roster.logins(actorOf(user), staffId) };
  }

  @Put('staff')
  @Roles(...SCHED_ADMIN)
  @ApiOperation({ summary: 'Create a staff member, or update the one with an id' })
  upsertStaff(@CurrentUser() user: unknown, @Body() dto: StaffDto) {
    return this.roster.upsertStaff(actorOf(user), dto);
  }

  @Get('duty-now')
  @Roles(...SCHED_READ)
  @ApiOperation({ summary: 'Who is on duty now' })
  async dutyNow() {
    return { onDuty: await this.roster.onDuty(clinicNow(), { onCall: true }) };
  }

  // ---------- rooms ----------

  @Get('rooms')
  @Roles(...SCHED_READ)
  @ApiOperation({ summary: 'The rooms with their hours and coming blocks' })
  async listRooms() {
    return { rooms: await this.rooms.rooms() };
  }

  @Post('rooms/:key/blocks')
  @Roles(...SCHED_ADMIN)
  @ApiOperation({ summary: 'Block a room for a period' })
  async addBlock(@CurrentUser() user: unknown, @Param() p: RoomKeyParam, @Body() dto: RoomBlockDto) {
    const block = await this.rooms.addBlock(actorOf(user), p.key, { from: momentOf(dto.from, 'from'), to: momentOf(dto.to, 'to'), reason: dto.reason });
    this.retry();
    return block;
  }

  @Delete('rooms/blocks/:id')
  @Roles(...SCHED_ADMIN)
  @ApiOperation({ summary: 'Remove a room block' })
  async removeBlock(@CurrentUser() user: unknown, @Param() p: SchedulingIdParam) {
    const out = await this.rooms.removeBlock(actorOf(user), p.id);
    this.retry();
    return out;
  }

  // ---------- waitlist, follow-ups ----------

  @Get('waitlist')
  @Roles(...SCHED_READ)
  @ApiOperation({ summary: 'Appointments and procedures that need a new time, with offered times' })
  async listWaitlist(@Query() q: WaitlistQueryDto) {
    return { items: await this.waitlist.list(q.status ?? 'open') };
  }

  @Post('waitlist/:id/book')
  @Roles(...SCHED_BOOK)
  @ApiOperation({ summary: 'Book one of the offered times' })
  bookOffered(@CurrentUser() user: unknown, @Param() p: SchedulingIdParam, @Body() dto: WaitBookDto) {
    return this.waitlist.bookOffered(actorOf(user), p.id, dto.index);
  }

  @Post('waitlist/:id/find')
  @Roles(...SCHED_BOOK)
  @ApiOperation({ summary: 'Find other times' })
  findAnother(@CurrentUser() user: unknown, @Param() p: SchedulingIdParam) {
    return this.waitlist.findAnother(actorOf(user), p.id);
  }

  @Post('waitlist/:id/cancel')
  @Roles(...SCHED_BOOK)
  @ApiOperation({ summary: 'Cancel the booking behind a waitlist item' })
  cancelWaiting(@CurrentUser() user: unknown, @Param() p: SchedulingIdParam, @Body() dto: SchedulingReasonDto) {
    return this.waitlist.cancelBooking(actorOf(user), p.id, dto.reason);
  }

  @Post('followups')
  @Roles(...SCHED_CLINICAL)
  @ApiOperation({ summary: 'Order a follow-up in N days; booked at once, or put on the waitlist when the week is full' })
  orderFollowUp(@CurrentUser() user: unknown, @Body() dto: FollowUpDto) {
    return this.followups.order(actorOf(user), dto);
  }

  // ---------- settings ----------

  @Get('settings')
  @Roles(...SCHED_READ)
  @ApiOperation({ summary: 'Scheduling settings: shifts, targets, room hours, procedure minutes' })
  getSettings() {
    return this.settings.get();
  }

  @Put('settings')
  @Roles(...SCHED_ADMIN)
  @ApiOperation({ summary: 'Change scheduling settings (admin)' })
  saveSettings(@CurrentUser() user: unknown, @Body() body: unknown) {
    plainObject(body);
    return this.settings.save(actorOf(user), body);
  }
}
