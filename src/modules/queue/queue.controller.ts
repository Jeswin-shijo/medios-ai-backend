import { Body, Controller, Delete, Get, Headers, HttpCode, HttpStatus, Logger, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { debounceTime } from 'rxjs';
import { QueueService } from './queue.service';
import { QueueDisplaysService } from './queue-displays.service';
import { QueueEvents } from './queue-events';
import { PatientCardsService } from './patient-cards.service';
import { SettingsService } from '../settings/settings.service';
import { CardTapDto, CardsQueryDto, CallTokenDto, CreateDisplayDto, IssueTokenDto, LinkCardDto, QueueQueryDto, UpdateDisplayDto } from './dto/queue.dto';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../users/schemas/user.schema';

const MINUTE = 60_000;
/** Roles that run the front desk or call patients in. */
const QUEUE_STAFF = [UserRole.ADMIN, UserRole.DOCTOR, UserRole.NURSE, UserRole.STAFF];
/** A display stream re-sends the queue this often even when nothing changed (keep-alive, other API instances). */
const STREAM_REFRESH_MS = 15_000;

@ApiTags('Token Queue')
@ApiBearerAuth()
@Controller('queue')
export class QueueController {
  private readonly logger = new Logger(QueueController.name);

  constructor(
    private readonly queue: QueueService,
    private readonly displays: QueueDisplaysService,
    private readonly cards: PatientCardsService,
    private readonly settings: SettingsService,
    private readonly events: QueueEvents,
  ) {}

  @Get()
  @ApiOperation({ summary: "A day's tokens in number order, with counts and the queue settings" })
  board(@Query() query: QueueQueryDto) {
    return this.queue.board(query.date);
  }

  @Post('tokens')
  @Roles(...QUEUE_STAFF)
  @ApiOperation({ summary: "Check a patient in and give them today's token (returns their existing one if they hold it)" })
  issue(@Body() dto: IssueTokenDto, @CurrentUser('name') user: string) {
    return this.queue.issue(dto, user || 'Front desk');
  }

  @Post('next')
  @Roles(...QUEUE_STAFF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Finish the room's current token and call the next in line" })
  next(@Body() dto: CallTokenDto, @CurrentUser('name') user: string) {
    return this.queue.call(dto.counter, user || 'Staff', dto.finish);
  }

  @Post('tokens/:id/call')
  @Roles(...QUEUE_STAFF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Call this waiting or skipped token out of turn' })
  callToken(@Param('id') id: string, @Body() dto: CallTokenDto, @CurrentUser('name') user: string) {
    return this.queue.call(dto.counter, user || 'Staff', dto.finish, id);
  }

  @Post('tokens/:id/recall')
  @Roles(...QUEUE_STAFF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Announce a called token again' })
  recall(@Param('id') id: string) {
    return this.queue.recall(id);
  }

  @Post('tokens/:id/skip')
  @Roles(...QUEUE_STAFF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'The called patient did not come' })
  skip(@Param('id') id: string) {
    return this.queue.skip(id);
  }

  @Post('tokens/:id/requeue')
  @Roles(...QUEUE_STAFF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Put a skipped token back in the queue (it keeps its number)' })
  requeue(@Param('id') id: string) {
    return this.queue.requeue(id);
  }

  @Post('tokens/:id/complete')
  @Roles(...QUEUE_STAFF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'The doctor has finished with this token' })
  complete(@Param('id') id: string) {
    return this.queue.complete(id);
  }

  @Post('tokens/:id/cancel')
  @Roles(...QUEUE_STAFF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Withdraw a waiting or skipped token' })
  cancel(@Param('id') id: string) {
    return this.queue.cancel(id);
  }

  // ---------------------------------------------------------------- patient cards

  @Get('cards')
  @Roles(...QUEUE_STAFF)
  @ApiOperation({ summary: "A patient's linked cards" })
  listCards(@Query() query: CardsQueryDto) {
    return this.cards.list(query.uhid);
  }

  @Post('cards')
  @Roles(...QUEUE_STAFF)
  @ApiOperation({ summary: 'Link a card (its serial number, as the USB reader types it) to a patient' })
  linkCard(@Body() dto: LinkCardDto, @CurrentUser('name') user: string) {
    return this.cards.link(dto.cardId, dto.uhid, user || 'Front desk', dto.reassign === true);
  }

  @Delete('cards/:id')
  @Roles(...QUEUE_STAFF)
  @ApiOperation({ summary: 'Unlink a card (lost, or handed back)' })
  unlinkCard(@Param('id') id: string) {
    return this.cards.unlink(id);
  }

  @Post('cards/tap')
  @Roles(...QUEUE_STAFF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'A card tapped on the front-desk reader: issue (or return) its patient\'s token; 404 for an unknown card' })
  tapAtDesk(@Body() dto: CardTapDto, @CurrentUser('name') user: string) {
    return this.cards.tap(dto.cardId, user || 'Front desk', 'front-desk');
  }

  // ---------------------------------------------------------------- devices (displays and kiosks)

  @Get('displays')
  @Roles(UserRole.ADMIN, UserRole.DOCTOR)
  @ApiOperation({ summary: 'Displays and check-in kiosks allowed to use the queue' })
  listDisplays() {
    return this.displays.list();
  }

  @Post('displays')
  @Roles(UserRole.ADMIN, UserRole.DOCTOR)
  @ApiOperation({ summary: 'Add a display or kiosk; its key is returned once' })
  createDisplay(@Body() dto: CreateDisplayDto, @CurrentUser('name') user: string) {
    return this.displays.create(dto.name, dto.kind ?? 'display', user || 'Admin', dto.printSlips === true);
  }

  @Patch('displays/:id')
  @Roles(UserRole.ADMIN, UserRole.DOCTOR)
  @ApiOperation({ summary: "Rename a device or switch a kiosk's slip printing" })
  updateDisplay(@Param('id') id: string, @Body() dto: UpdateDisplayDto) {
    return this.displays.update(id, dto);
  }

  @Delete('displays/:id')
  @Roles(UserRole.ADMIN, UserRole.DOCTOR)
  @ApiOperation({ summary: 'Remove a display or kiosk; its link stops working' })
  removeDisplay(@Param('id') id: string) {
    return this.displays.remove(id);
  }

  // ---------------------------------------------------------------- check-in kiosk

  /** The kiosk page checks its key and reads its settings on start. */
  @Public()
  @Get('kiosk/state')
  @Throttle({ default: { limit: 30, ttl: MINUTE } })
  @ApiHeader({ name: 'Authorization', description: 'Kiosk <key>' })
  @ApiOperation({ summary: 'Kiosk settings: hospital name, slip printing (kiosk key, no sign-in)' })
  async kioskState(@Headers('authorization') authorization?: string) {
    const kiosk = await this.displays.authenticate(authorization, 'kiosk');
    const s = (await this.settings.getSettings()) as unknown as Record<string, any>;
    return { name: kiosk.name, printSlips: kiosk.printSlips, hospitalName: String(s.hospital?.name ?? '') };
  }

  /** A patient tapped their card at a kiosk. The answer is shown on the kiosk screen, so it carries no UHID or full name. */
  @Public()
  @Post('kiosk/tap')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: MINUTE } })
  @ApiHeader({ name: 'Authorization', description: 'Kiosk <key>' })
  @ApiOperation({ summary: 'Card tap at a check-in kiosk: issue or return the token (kiosk key, no sign-in)' })
  async kioskTap(@Headers('authorization') authorization: string | undefined, @Body() dto: CardTapDto) {
    const kiosk = await this.displays.authenticate(authorization, 'kiosk');
    const { token, existing } = await this.cards.tap(dto.cardId, `Kiosk: ${kiosk.name}`, 'kiosk');
    // The current setting, so switching printing on or off applies from the next tap.
    return { ...(await this.queue.kioskView(token, existing)), printSlips: kiosk.printSlips };
  }

  /** For a display that cannot keep a stream open; it polls this instead. */
  @Public()
  @Get('display/state')
  @Throttle({ default: { limit: 30, ttl: MINUTE } })
  @ApiHeader({ name: 'Authorization', description: 'Display <key>' })
  @ApiOperation({ summary: 'What the waiting-room display shows (display key, no sign-in)' })
  async displayState(@Headers('authorization') authorization?: string) {
    await this.displays.authenticate(authorization);
    return this.queue.displaySnapshot();
  }

  /**
   * Server-sent events: a `snapshot` on connect, after every queue change, and every
   * 15 s; `revoked` and the end of the stream when the display is removed.
   */
  @Public()
  @Get('display/stream')
  @Throttle({ default: { limit: 10, ttl: MINUTE } })
  @ApiHeader({ name: 'Authorization', description: 'Display <key>' })
  @ApiOperation({ summary: 'Live queue for the waiting-room display (text/event-stream)' })
  async displayStream(@Headers('authorization') authorization: string | undefined, @Req() req: Request, @Res() res: Response) {
    const display = await this.displays.authenticate(authorization);

    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx: do not buffer the stream
    });
    res.flushHeaders();

    let closed = false;
    let sending = Promise.resolve();
    const write = (event: string, data: unknown) => {
      if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    // Chained so snapshots go out in the order the changes happened.
    const sendSnapshot = () => {
      sending = sending
        .then(async () => {
          if (!closed) write('snapshot', await this.queue.displaySnapshot());
        })
        .catch((err) => this.logger.warn(`Display ${display.name}: ${(err as Error).message}`));
    };

    const changes = this.events.changes$.pipe(debounceTime(150)).subscribe(sendSnapshot);
    const refresh = setInterval(async () => {
      if (await this.displays.stillValid(display._id).catch(() => true)) return sendSnapshot();
      write('revoked', {});
      res.end();
    }, STREAM_REFRESH_MS);
    req.on('close', () => {
      closed = true;
      changes.unsubscribe();
      clearInterval(refresh);
    });

    sendSnapshot();
  }
}
