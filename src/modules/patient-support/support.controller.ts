import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { actorOf } from '../beds/actor';
import { TicketType } from './support-catalogue';
import { SupportCheckupsService, CheckupTab, SubmitCheckupInput } from './support-checkups.service';
import { SupportFactsService } from './support-facts.service';
import { SupportFeedbackService } from './support-feedback.service';
import { SupportOverviewService } from './support-overview.service';
import { SUP_ADMIN, SUP_READ, SUP_REVIEW, SUP_SEND } from './support-roles';
import { SupportSettingsService } from './support-settings.service';
import { SupportTextsService } from './support-texts.service';
import { SupportTicketsService } from './support-tickets.service';
import { SupportUpdatesService } from './support-updates.service';
import {
  AddFaqDto,
  CheckupAnswersDto,
  CheckupListQueryDto,
  CheckupReviewDto,
  FaqPatchDto,
  FaqSearchQueryDto,
  FeedbackDto,
  FeedbackListQueryDto,
  OpenTicketDto,
  SaveContactDto,
  SupportIdParam,
  SupportKeyParam,
  SupportPatientParam,
  SupportTopicParam,
  TemplatePatchDto,
  TicketHandOnDto,
  TicketListQueryDto,
  TicketNoteDto,
  TicketResolveDto,
  TicketStateDto,
  UpdateListQueryDto
} from './dto/support.dto';

/**
 * Patient Support routes (`/api/support`). Each maps to a service method, which checks the role again and decides; a
 * service's 400, 403, 404 or 409 passes through unchanged. Pharmacist and lab are in no role list: every route is 403 for
 * them. A ticket or feedback taken here always has the source `desk` (the call sources come only from the phone agents).
 */
@ApiTags('Patient Support')
@ApiBearerAuth()
@Controller('support')
export class SupportController {
  constructor(
    private readonly overview: SupportOverviewService,
    private readonly tickets: SupportTicketsService,
    private readonly updates: SupportUpdatesService,
    private readonly checkups: SupportCheckupsService,
    private readonly feedback: SupportFeedbackService,
    private readonly texts: SupportTextsService,
    private readonly facts: SupportFactsService,
    private readonly settings: SupportSettingsService
  ) {}

  // ---------- the page ----------

  @Get('overview')
  @Roles(...SUP_READ)
  @ApiOperation({ summary: 'The cards, queues, workflow and insights' })
  getOverview(@CurrentUser() user: unknown) {
    return this.overview.overview(actorOf(user));
  }

  @Post('day-summary')
  @Roles(...SUP_READ)
  @ApiOperation({ summary: 'The AI day summary (counts only)' })
  daySummary() {
    return this.overview.daySummary();
  }

  // ---------- tickets ----------

  @Get('tickets')
  @Roles(...SUP_READ)
  @ApiOperation({ summary: 'The tickets, newest first' })
  listTickets(@Query() q: TicketListQueryDto) {
    return this.tickets.list(q);
  }

  @Get('tickets/:id')
  @Roles(...SUP_READ)
  @ApiOperation({ summary: 'One ticket with its notes and call transcript' })
  ticket(@Param() p: SupportIdParam) {
    return this.tickets.detail(p.id);
  }

  @Post('tickets')
  @Roles(...SUP_READ)
  @ApiOperation({ summary: 'Open a ticket at the desk' })
  openTicket(@CurrentUser() user: unknown, @Body() dto: OpenTicketDto) {
    return this.tickets.open(actorOf(user), { ...dto, source: 'desk' });
  }

  @Post('tickets/:id/notes')
  @Roles(...SUP_READ)
  @ApiOperation({ summary: 'Add a note (the first one is the first response)' })
  addNote(@CurrentUser() user: unknown, @Param() p: SupportIdParam, @Body() dto: TicketNoteDto) {
    return this.tickets.note(actorOf(user), p.id, dto.body);
  }

  @Post('tickets/:id/state')
  @Roles(...SUP_READ)
  @ApiOperation({ summary: 'Change a ticket state' })
  setTicketState(@CurrentUser() user: unknown, @Param() p: SupportIdParam, @Body() dto: TicketStateDto) {
    return this.tickets.setState(actorOf(user), p.id, dto.state);
  }

  @Post('tickets/:id/hand-on')
  @Roles(...SUP_READ)
  @ApiOperation({ summary: 'Hand a ticket on to the owner of another type' })
  handOn(@CurrentUser() user: unknown, @Param() p: SupportIdParam, @Body() dto: TicketHandOnDto) {
    return this.tickets.handOn(actorOf(user), p.id, dto.ticketType as TicketType, dto.note);
  }

  @Post('tickets/:id/resolve')
  @Roles(...SUP_READ)
  @ApiOperation({ summary: 'Resolve a ticket' })
  resolveTicket(@CurrentUser() user: unknown, @Param() p: SupportIdParam, @Body() dto: TicketResolveDto) {
    return this.tickets.resolve(actorOf(user), p.id, dto.resolution);
  }

  // ---------- family updates ----------

  @Get('updates')
  @Roles(...SUP_READ)
  @ApiOperation({ summary: 'The family updates, newest first' })
  listUpdates(@CurrentUser() user: unknown, @Query() q: UpdateListQueryDto) {
    return this.updates.list(q, actorOf(user));
  }

  @Post('updates/:id/send')
  @Roles(...SUP_SEND)
  @ApiOperation({ summary: 'Send a held or waiting update now' })
  sendUpdate(@CurrentUser() user: unknown, @Param() p: SupportIdParam) {
    return this.updates.sendNow(actorOf(user), p.id);
  }

  @Post('updates/:id/dismiss')
  @Roles(...SUP_SEND)
  @ApiOperation({ summary: 'Dismiss a held update' })
  dismissUpdate(@CurrentUser() user: unknown, @Param() p: SupportIdParam) {
    return this.updates.dismiss(actorOf(user), p.id);
  }

  // ---------- check-up calls ----------

  @Get('checkups')
  @Roles(...SUP_READ)
  @ApiOperation({ summary: 'The check-up calls of a tab' })
  listCheckups(@Query() q: CheckupListQueryDto) {
    return this.checkups.list((q.tab ?? 'to-do') as CheckupTab);
  }

  @Get('checkups/:id')
  @Roles(...SUP_READ)
  @ApiOperation({ summary: 'One check-up with its questions and answers' })
  checkup(@Param() p: SupportIdParam) {
    return this.checkups.detail(p.id);
  }

  @Post('checkups/:id/answers')
  @Roles(...SUP_READ)
  @ApiOperation({ summary: 'Record the answers of a check-up call made by hand' })
  submitCheckup(@CurrentUser() user: unknown, @Param() p: SupportIdParam, @Body() dto: CheckupAnswersDto) {
    return this.checkups.submit(actorOf(user), p.id, dto as unknown as SubmitCheckupInput);
  }

  @Post('checkups/:id/no-answer')
  @Roles(...SUP_READ)
  @ApiOperation({ summary: 'The patient did not answer' })
  checkupNoAnswer(@CurrentUser() user: unknown, @Param() p: SupportIdParam) {
    return this.checkups.noAnswer(actorOf(user), p.id);
  }

  @Post('checkups/:id/review')
  @Roles(...SUP_REVIEW)
  @ApiOperation({ summary: 'A doctor reviews a worrying or ER-bound check-up' })
  reviewCheckup(@CurrentUser() user: unknown, @Param() p: SupportIdParam, @Body() dto: CheckupReviewDto) {
    return this.checkups.review(actorOf(user), p.id, dto.note);
  }

  // ---------- feedback ----------

  @Get('feedback')
  @Roles(...SUP_READ)
  @ApiOperation({ summary: 'Ratings and comments' })
  listFeedback(@Query() q: FeedbackListQueryDto) {
    return this.feedback.list(q);
  }

  @Post('feedback')
  @Roles(...SUP_READ)
  @ApiOperation({ summary: 'Record a rating taken at the desk' })
  recordFeedback(@CurrentUser() user: unknown, @Body() dto: FeedbackDto) {
    return this.feedback.record(actorOf(user), { ...dto, source: 'desk' });
  }

  // ---------- texts ----------

  @Get('templates')
  @Roles(...SUP_READ)
  @ApiOperation({ summary: 'The message templates' })
  templates() {
    return this.texts.templates();
  }

  @Get('faqs')
  @Roles(...SUP_READ)
  @ApiOperation({ summary: 'The hospital facts' })
  faqs() {
    return this.texts.faqs();
  }

  @Get('faqs/search')
  @Roles(...SUP_READ)
  @ApiOperation({ summary: 'Search the approved hospital facts' })
  searchFaqs(@Query() q: FaqSearchQueryDto) {
    return this.texts.searchFaqs(q.q);
  }

  @Put('templates/:key')
  @Roles(...SUP_ADMIN)
  @ApiOperation({ summary: 'Edit a template (admin)' })
  saveTemplate(@CurrentUser() user: unknown, @Param() p: SupportKeyParam, @Body() dto: TemplatePatchDto) {
    return this.texts.saveTemplate(actorOf(user), p.key, dto);
  }

  @Put('faqs/:topic')
  @Roles(...SUP_ADMIN)
  @ApiOperation({ summary: 'Edit a hospital fact (admin)' })
  saveFaq(@CurrentUser() user: unknown, @Param() p: SupportTopicParam, @Body() dto: FaqPatchDto) {
    return this.texts.saveFaq(actorOf(user), p.topic, dto);
  }

  @Post('faqs')
  @Roles(...SUP_ADMIN)
  @ApiOperation({ summary: 'Add a hospital fact (admin)' })
  addFaq(@CurrentUser() user: unknown, @Body() dto: AddFaqDto) {
    return this.texts.addFaq(actorOf(user), dto);
  }

  // ---------- contact and consent ----------

  @Get('patients/:patientId/contact')
  @Roles(...SUP_READ)
  @ApiOperation({ summary: "A patient's contacts, language and consent" })
  contact(@Param() p: SupportPatientParam) {
    return this.facts.contactOf(p.patientId);
  }

  @Put('patients/:patientId/contact')
  @Roles(...SUP_READ)
  @ApiOperation({ summary: "Record a patient's contacts, language and consent" })
  saveContact(@CurrentUser() user: unknown, @Param() p: SupportPatientParam, @Body() dto: SaveContactDto) {
    return this.facts.saveContact(actorOf(user), p.patientId, dto);
  }

  // ---------- settings ----------

  @Get('settings')
  @Roles(...SUP_READ)
  @ApiOperation({ summary: 'Settings → Patient Support' })
  getSettings() {
    return this.settings.get();
  }

  /** The body is not a whitelisting DTO: the service checks every range and must see an unknown key to refuse it (400), as Discharge does. */
  @Put('settings')
  @Roles(...SUP_ADMIN)
  @ApiOperation({ summary: 'Change Settings → Patient Support (admin)' })
  saveSettings(@CurrentUser() user: unknown, @Body() body: Record<string, unknown>) {
    return this.settings.save(actorOf(user), body);
  }
}
