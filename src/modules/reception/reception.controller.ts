import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../users/schemas/user.schema';
import { VisitsQueryDto } from './dto/reception.dto';
import { OpVisitsService } from './visits.service';

/** The front desk and clinical staff's side of the reception kiosk. */
@ApiTags('Reception')
@ApiBearerAuth()
@Controller('reception')
export class ReceptionController {
  constructor(
    private readonly visits: OpVisitsService,
    private readonly config: ConfigService,
  ) {}

  @Get('status')
  @Roles(UserRole.ADMIN, UserRole.STAFF)
  @ApiOperation({ summary: 'Which sample or absent providers the kiosk runs on' })
  status() {
    return {
      paymentProvider: this.config.get<string>('reception.paymentProvider') === 'sample' ? 'sample' : 'none',
      smsProvider: this.config.get<string>('reception.smsProvider') === 'sample' ? 'sample' : 'none',
    };
  }

  @Get('visits')
  @Roles(UserRole.ADMIN, UserRole.STAFF, UserRole.DOCTOR, UserRole.NURSE)
  @ApiOperation({ summary: "A day's OP visits; `awaiting-cash` is the counter's list, `needs-attention` the paid ones missing a bill or token" })
  list(@Query() query: VisitsQueryDto) {
    return this.visits.list(query);
  }

  @Post('visits/:id/confirm-cash')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.ADMIN, UserRole.STAFF)
  @ApiOperation({ summary: 'The cash was taken at the counter: pay the visit, issue the token and bill' })
  confirmCash(@Param('id') id: string, @CurrentUser('name') user: string) {
    return this.visits.confirmCash(id, user || 'Front desk');
  }

  @Post('visits/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.ADMIN, UserRole.STAFF)
  @ApiOperation({ summary: 'Cancel an unpaid visit' })
  cancel(@Param('id') id: string, @CurrentUser('name') user: string) {
    return this.visits.cancel(id, { actor: user || 'Front desk' });
  }
}
