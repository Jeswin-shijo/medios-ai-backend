import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { DocumentsService } from './documents.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Clinical Documents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
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
  async create(@Body() body: any) {
    return this.documentsService.create(body);
  }

  @Patch(':id/sign')
  @ApiOperation({ summary: 'Digitally sign a clinical document' })
  async signDocument(@Param('id') id: string, @CurrentUser('name') doctorName: string) {
    return this.documentsService.signDocument(id, doctorName || 'Dr. Shajin');
  }
}
