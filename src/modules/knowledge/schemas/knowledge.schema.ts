import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type KnowledgeArticleDocument = KnowledgeArticle & Document;
export type ClinicalGuidelineDocument = ClinicalGuideline & Document;

@Schema({ timestamps: true })
export class KnowledgeArticle {
  @Prop({ required: true })
  title: string;

  @Prop({ default: 'Protocols' })
  category: string;

  @Prop({ default: 'Protocol', enum: ['Guideline', 'Protocol', 'Reference', 'SOP'] })
  type: string;

  @Prop({ default: '26 Sep 2026' })
  lastUpdated: string;

  @Prop({ required: true })
  summary: string;

  @Prop({ default: '' })
  content: string;

  @Prop({ default: false })
  isBookmarked: boolean;
}

export const KnowledgeArticleSchema = SchemaFactory.createForClass(KnowledgeArticle);

@Schema({ timestamps: true })
export class ClinicalGuideline {
  @Prop({ required: true })
  title: string;

  @Prop({ default: 'v2026.2' })
  version: string;

  @Prop({ required: true })
  specialty: string;

  @Prop({ default: 'National / Official Protocol' })
  source: string;

  @Prop({ default: 'Sep 2026' })
  updatedDate: string;

  @Prop({ default: 'High (A)', enum: ['High (A)', 'Moderate (B)', 'Low (C)'] })
  evidenceLevel: string;

  @Prop({ default: 'Strong', enum: ['Strong', 'Recommendation', 'Conditional'] })
  recommendationStrength: string;

  @Prop({ default: '' })
  background: string;

  @Prop({ type: [String], default: [] })
  keyPoints: string[];

  @Prop({ type: [String], default: [] })
  applicableTo: string[];

  @Prop({ type: [String], default: [] })
  notApplicableTo: string[];
}

export const ClinicalGuidelineSchema = SchemaFactory.createForClass(ClinicalGuideline);
