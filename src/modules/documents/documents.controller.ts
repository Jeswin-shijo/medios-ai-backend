import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { DocumentsService } from './documents.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../users/schemas/user.schema';

@ApiTags('Clinical Documents')
@ApiBearerAuth()
@Controller('documents')
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Get()
  @ApiOperation({ summary: 'Get clinical documents with filters' })
  @ApiQuery({ name: 'uhid', required: false })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'status', required: false })
  async findAll(
    @Query('uhid') uhid?: string,
    @Query('category') category?: string,
    @Query('status') status?: string,
  ) {
    return this.documentsService.findAll({ uhid, category, status });
  }

  @Post()
  @ApiOperation({ summary: 'Upload or record a clinical document' })
  async create(@Body() body: any, @CurrentUser('name') userName: string) {
    return this.documentsService.create({ ...body, author: body.author || userName });
  }

  @Patch(':id/sign')
  @Roles(UserRole.DOCTOR)
  @ApiOperation({ summary: 'Digitally sign a clinical document as the current user' })
  async signDocument(@Param('id') id: string, @CurrentUser('name') doctorName: string) {
    return this.documentsService.signDocument(id, doctorName);
  }
}
