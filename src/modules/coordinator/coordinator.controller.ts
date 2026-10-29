import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../users/schemas/user.schema';
import { UsersService } from '../users/users.service';
import { ADMIT_ROLES, actorOf } from '../beds/actor';
import { AgentRegistry } from './agent-registry';
import { AgentStatusService } from './agent-status.service';
import { ApprovalsService } from './approvals.service';
import { CasesService } from './cases.service';
import { ChatService } from './chat.service';
import { ClocksService } from './clocks.service';
import { CoordinatorEvents } from './coordinator-events';
import { CoordinatorOverviewService } from './coordinator-overview.service';
import { EscalationsService } from './escalations.service';
import { MessagesService } from './messages.service';
import { RulesService } from './rules.service';
import {
  ActDto,
  ApprovalQueryDto,
  AskDto,
  CaseQueryDto,
  DutyTitleDto,
  IdParam,
  LadderDto,
  MessageQueryDto,
  ReassignDto,
  RuleKeyParam,
  SetRuleDto,
  SnapshotRangeDto,
} from './dto/coordinator.dto';

/** A comment line goes out this often so proxies keep the stream open. */
export const PING_MS = 25_000;
const OK = { ok: true };
const ADMIN = [UserRole.ADMIN];

const iso = (d?: Date | null) => (d ? new Date(d).toISOString() : undefined);

/** A case as the API shows it: string ids, ISO times. */
export function caseView(c: any) {
  return {
    id: String(c._id),
    number: c.number,
    patientId: String(c.patient),
    patientUhid: c.patientUhid,
    patientName: c.patientName,
    kind: c.kind,
    priority: c.priority,
    state: c.state,
    openedAt: iso(c.openedAt),
    closedAt: iso(c.closedAt),
    closedReason: c.closedReason ?? undefined,
    agents: [...(c.agents ?? [])],
    refs: {
      bedRequestIds: [...(c.refs?.bedRequestIds ?? [])],
      admissionId: c.refs?.admissionId ?? undefined,
    },
    openedBy: c.openedBy,
  };
}

@ApiTags('Coordinator')
@ApiBearerAuth()
@Controller('coordinator')
export class CoordinatorController {
  constructor(
    private readonly overview: CoordinatorOverviewService,
    private readonly cases: CasesService,
    private readonly messages: MessagesService,
    private readonly clocks: ClocksService,
    private readonly agentStatus: AgentStatusService,
    private readonly approvals: ApprovalsService,
    private readonly escalations: EscalationsService,
    private readonly rules: RulesService,
    private readonly registry: AgentRegistry,
    private readonly chat: ChatService,
    private readonly events: CoordinatorEvents,
    private readonly users: UsersService,
  ) {}

  @Get('overview')
  @Roles(...ADMIT_ROLES)
  @ApiOperation({ summary: 'Counts, agent statuses and what needs attention' })
  getOverview() {
    return this.overview.overview();
  }

  @Get('snapshots')
  @Roles(...ADMIT_ROLES)
  @ApiOperation({ summary: 'Hourly counts for the trend charts' })
  snapshots(@Query() q: SnapshotRangeDto) {
    return this.overview.series(q.range ?? '24h');
  }

  @Get('cases')
  @Roles(...ADMIT_ROLES)
  @ApiOperation({ summary: 'Patient cases, newest first' })
  async listCases(@Query() q: CaseQueryDto) {
    return (await this.cases.list(q)).map(caseView);
  }

  @Get('cases/:id')
  @Roles(...ADMIT_ROLES)
  @ApiOperation({ summary: 'One case with its message timeline and clocks' })
  async getCase(@Param() p: IdParam) {
    const c = await this.cases.get(p.id);
    if (!c) throw new NotFoundException('Case not found');
    const [timeline, clocks] = await Promise.all([this.cases.timeline(p.id), this.clocks.list({ case: p.id })]);
    return { case: caseView(c), timeline, clocks };
  }

  @Get('messages')
  @Roles(...ADMIT_ROLES)
  @ApiOperation({ summary: 'Messages between agents' })
  listMessages(@Query() q: MessageQueryDto) {
    return this.messages.list(q as any);
  }

  @Get('agents')
  @Roles(...ADMIT_ROLES)
  @ApiOperation({ summary: 'The nine agents and whether they are online' })
  agents() {
    return this.agentStatus.list();
  }

  @Get('approvals')
  @Roles(...ADMIT_ROLES)
  @ApiOperation({ summary: 'Approvals waiting for, or already given by, staff' })
  listApprovals(@Query() q: ApprovalQueryDto) {
    return this.approvals.list(q);
  }

  @Post('approvals/:id/act')
  @HttpCode(HttpStatus.OK)
  @Roles(...ADMIT_ROLES) // the approval's own roles are checked in the service
  @ApiOperation({ summary: 'Approve or reject (only the roles the approval names)' })
  act(@CurrentUser() user: any, @Param() p: IdParam, @Body() dto: ActDto) {
    return this.approvals.act(actorOf(user), p.id, dto.decision);
  }

  @Post('approvals/:id/reassign')
  @HttpCode(HttpStatus.OK)
  @Roles(...ADMIT_ROLES) // the approval's roles, or an admin, are checked in the service
  @ApiOperation({ summary: 'Hand an approval to another duty title or role' })
  reassign(@CurrentUser() user: any, @Param() p: IdParam, @Body() dto: ReassignDto) {
    return this.approvals.reassign(actorOf(user), p.id, dto.target, dto.note);
  }

  @Post('escalations/:id/ack')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Acknowledge an escalation (the service checks who may)' })
  async ack(@CurrentUser() user: any, @Param() p: IdParam) {
    await this.escalations.acknowledge(actorOf(user), p.id);
    return OK;
  }

  @Get('rules')
  @Roles(...ADMIT_ROLES)
  @ApiOperation({ summary: 'The Coordinator rules and whether each is on' })
  listRules() {
    return this.rules.list();
  }

  @Put('rules/:key')
  @Roles(...ADMIN)
  @ApiOperation({ summary: 'Switch an unlocked rule on or off (admin)' })
  setRule(@CurrentUser() user: any, @Param() p: RuleKeyParam, @Body() dto: SetRuleDto) {
    return this.rules.set(actorOf(user), p.key, dto.value);
  }

  @Get('request-types')
  @Roles(...ADMIT_ROLES)
  @ApiOperation({ summary: 'The request types an agent can raise' })
  requestTypes() {
    return this.registry.requestTypes();
  }

  @Get('ladders')
  @Roles(...ADMIN)
  @ApiOperation({ summary: 'Escalation ladders (admin)' })
  ladders() {
    return this.escalations.ladders();
  }

  @Put('ladders')
  @Roles(...ADMIN)
  @ApiOperation({ summary: 'Save one escalation ladder (admin)' })
  saveLadder(@CurrentUser() user: any, @Body() dto: LadderDto) {
    return this.escalations.saveLadder(actorOf(user), dto);
  }

  // Readable by everyone who can reassign an approval: Reassign offers the titles as targets.
  @Get('titles')
  @Roles(...ADMIT_ROLES)
  @ApiOperation({ summary: 'Duty titles and who holds them' })
  titles() {
    return this.escalations.titles();
  }

  @Put('titles')
  @Roles(...ADMIN)
  @ApiOperation({ summary: 'Save one duty title (admin)' })
  saveTitle(@CurrentUser() user: any, @Body() dto: DutyTitleDto) {
    return this.escalations.saveTitle(actorOf(user), dto);
  }

  @Get('staff')
  @Roles(...ADMIN)
  @ApiOperation({ summary: 'Staff accounts, for choosing duty-title holders (admin)' })
  staff() {
    return this.users.listStaff();
  }

  @Post('ask')
  @HttpCode(HttpStatus.OK)
  @Roles(...ADMIT_ROLES)
  @ApiOperation({ summary: 'Ask the Coordinator a question; it answers and suggests, never acts' })
  ask(@CurrentUser() user: any, @Body() dto: AskDto) {
    return this.chat.ask(actorOf(user), dto.question);
  }

  /** Live Coordinator events. `@Res()` takes the response over, so the JSON wrapper does not apply. */
  @Get('stream')
  @Roles(...ADMIT_ROLES)
  @ApiOperation({ summary: 'Live Coordinator events (text/event-stream): "coordinator" and "ping" events' })
  stream(@Req() req: Request, @Res() res: Response) {
    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    let closed = false;
    const write = (event: string, data: unknown) => {
      if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const sub = this.events.events$.subscribe((e) => write('coordinator', e));
    const ping = setInterval(() => write('ping', {}), PING_MS);
    req.on('close', () => {
      closed = true;
      sub.unsubscribe();
      clearInterval(ping);
    });

    write('ping', {});
  }
}
