import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { KnowledgeService } from './knowledge.service';

@ApiTags('Hospital Knowledge & Clinical Guidelines')
@ApiBearerAuth()
@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly knowledgeService: KnowledgeService) {}

  @Get('articles')
  @ApiOperation({ summary: 'Get hospital SOPs and knowledge articles' })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'search', required: false })
  async findArticles(
    @Query('category') category?: string,
    @Query('search') search?: string,
  ) {
    return this.knowledgeService.findArticles({ category, search });
  }

  @Get('guidelines')
  @ApiOperation({ summary: 'Get clinical guidelines and evidence protocols' })
  @ApiQuery({ name: 'specialty', required: false })
  @ApiQuery({ name: 'search', required: false })
  async findGuidelines(
    @Query('specialty') specialty?: string,
    @Query('search') search?: string,
  ) {
    return this.knowledgeService.findGuidelines({ specialty, search });
  }

  @Get('guidelines/:id')
  @ApiOperation({ summary: 'Get guideline by ID' })
  async findGuidelineById(@Param('id') id: string) {
    return this.knowledgeService.findGuidelineById(id);
  }

  @Post('ask-ai')
  @ApiOperation({ summary: 'Query clinical guidelines using AI with citation' })
  async askAi(@Body('question') question: string) {
    return this.knowledgeService.askAi(question || '');
  }
}
