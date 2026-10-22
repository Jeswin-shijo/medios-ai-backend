import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  KnowledgeArticle,
  KnowledgeArticleDocument,
  ClinicalGuideline,
  ClinicalGuidelineDocument,
} from './schemas/knowledge.schema';
import { escapeRegex } from '../../common/utils/escape-regex';

@Injectable()
export class KnowledgeService {
  constructor(
    @InjectModel(KnowledgeArticle.name)
    private articleModel: Model<KnowledgeArticleDocument>,
    @InjectModel(ClinicalGuideline.name)
    private guidelineModel: Model<ClinicalGuidelineDocument>,
  ) {}

  async findArticles(query: { category?: string; search?: string }): Promise<KnowledgeArticle[]> {
    const filter: any = {};
    if (query.category && query.category !== 'all') {
      filter.category = { $regex: escapeRegex(query.category), $options: 'i' };
    }
    if (query.search) {
      filter.$or = [
        { title: { $regex: escapeRegex(query.search), $options: 'i' } },
        { summary: { $regex: escapeRegex(query.search), $options: 'i' } },
      ];
    }
    return this.articleModel.find(filter).sort({ createdAt: -1 }).exec();
  }

  async findGuidelines(query: { specialty?: string; search?: string }): Promise<ClinicalGuideline[]> {
    const filter: any = {};
    if (query.specialty && query.specialty !== 'all' && query.specialty !== 'All Guidelines') {
      filter.specialty = { $regex: escapeRegex(query.specialty), $options: 'i' };
    }
    if (query.search) {
      filter.$or = [
        { title: { $regex: escapeRegex(query.search), $options: 'i' } },
        { source: { $regex: escapeRegex(query.search), $options: 'i' } },
      ];
    }
    return this.guidelineModel.find(filter).sort({ createdAt: -1 }).exec();
  }

  async findGuidelineById(id: string): Promise<ClinicalGuidelineDocument> {
    const guideline = await this.guidelineModel.findById(id).exec();
    if (!guideline) throw new NotFoundException(`Guideline ${id} not found`);
    return guideline;
  }

  async askAi(question: string) {
    return {
      question,
      answer:
        'First-line pharmacological management for Type 2 Diabetes with stage 1 hypertension includes Metformin combined with an ACE-inhibitor (or ARB, e.g. Telmisartan). In patients with high cardiovascular or renal risk, consider adding an SGLT2 inhibitor (Empagliflozin/Dapagliflozin) regardless of baseline HbA1c.',
      sourceCited: 'ADA Standards of Medical Care in Diabetes 2026 / ACC-AHA 2026',
      evidenceLevel: 'Level A (High Quality Randomized Trials)',
      relatedGuideline: 'Type 2 Diabetes Mellitus Management (v2026.2)',
    };
  }

  async createArticle(data: Partial<KnowledgeArticle>): Promise<KnowledgeArticleDocument> {
    const created = new this.articleModel(data);
    return created.save();
  }

  async createGuideline(data: Partial<ClinicalGuideline>): Promise<ClinicalGuidelineDocument> {
    const created = new this.guidelineModel(data);
    return created.save();
  }
}
