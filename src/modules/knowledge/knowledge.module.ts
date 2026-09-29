import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  KnowledgeArticle,
  KnowledgeArticleSchema,
  ClinicalGuideline,
  ClinicalGuidelineSchema,
} from './schemas/knowledge.schema';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeController } from './knowledge.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: KnowledgeArticle.name, schema: KnowledgeArticleSchema },
      { name: ClinicalGuideline.name, schema: ClinicalGuidelineSchema },
    ]),
  ],
  controllers: [KnowledgeController],
  providers: [KnowledgeService],
  exports: [KnowledgeService, MongooseModule],
})
export class KnowledgeModule {}
