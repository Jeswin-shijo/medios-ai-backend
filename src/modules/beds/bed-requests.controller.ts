import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ADMIT_ROLES, REQUEST_ROLES, actorOf } from './actor';
import { BedAgentService } from './bed-agent.service';
import { BedRequestsService } from './bed-requests.service';
import { BedRequestQueryDto, CreateBedRequestDto, NotesNeedDto, RequestIdParam } from './dto/beds.dto';

/** Registered before `BedsController` so `/beds/requests` is not read as `/beds/:bedId/...`. */
@ApiTags('Beds')
@ApiBearerAuth()
@Controller('beds/requests')
export class BedRequestsController {
  constructor(
    private readonly requests: BedRequestsService,
    private readonly agent: BedAgentService,
  ) {}

  @Post()
  @Roles(...REQUEST_ROLES)
  @ApiOperation({ summary: 'Ask the Bed Agent to place a patient' })
  async create(@CurrentUser() user: any, @Body() dto: CreateBedRequestDto) {
    const created = await this.requests.create(actorOf(user), dto);
    const id = String(created._id);
    this.agent.submit(id);
    return this.requests.get(id);
  }

  @Get()
  @Roles(...ADMIT_ROLES)
  @ApiOperation({ summary: 'Bed requests, newest first' })
  list(@Query() q: BedRequestQueryDto) {
    return this.requests.list(q);
  }

  @Get(':id')
  @Roles(...ADMIT_ROLES)
  @ApiOperation({ summary: 'One bed request, with its notes and the Bed Agent decision' })
  get(@Param() p: RequestIdParam) {
    return this.requests.get(p.id);
  }

  @Post(':id/cancel')
  @Roles(...REQUEST_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel an open bed request' })
  async cancel(@CurrentUser() user: any, @Param() p: RequestIdParam) {
    await this.requests.cancel(actorOf(user), p.id);
    return this.requests.get(p.id);
  }

  @Post(':id/notes-need')
  @Roles(...REQUEST_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm or dismiss a need the Bed Agent read in the notes' })
  async notesNeed(@CurrentUser() user: any, @Param() p: RequestIdParam, @Body() dto: NotesNeedDto) {
    await this.agent.resolveNotesNeed(actorOf(user), p.id, dto.need, dto.confirm);
    return this.requests.get(p.id);
  }
}
