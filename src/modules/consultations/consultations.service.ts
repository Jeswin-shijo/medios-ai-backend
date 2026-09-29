import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Consultation, ConsultationDocument } from './schemas/consultation.schema';

const DEFAULT_ICD10_CODES = [
  { code: 'I10', description: 'Essential (primary) hypertension', type: 'Chronic' },
  { code: 'E11.9', description: 'Type 2 diabetes mellitus without complications', type: 'Chronic' },
  { code: 'E11.65', description: 'Type 2 diabetes with hyperglycemia', type: 'Chronic' },
  { code: 'J06.9', description: 'Acute upper respiratory infection, unspecified', type: 'Acute' },
  { code: 'E78.5', description: 'Hyperlipidemia, unspecified', type: 'Chronic' },
  { code: 'K21.9', description: 'Gastro-esophageal reflux disease without esophagitis', type: 'Chronic' },
  { code: 'R05', description: 'Cough', type: 'Acute' },
  { code: 'R50.9', description: 'Fever, unspecified', type: 'Acute' },
  { code: 'M54.5', description: 'Low back pain', type: 'Acute' },
  { code: 'I25.10', description: 'Atherosclerotic heart disease of native coronary artery', type: 'Chronic' },
];

@Injectable()
export class ConsultationsService {
  constructor(
    @InjectModel(Consultation.name)
    private consultationModel: Model<ConsultationDocument>,
  ) {}

  async findByPatient(uhid: string): Promise<Consultation[]> {
    return this.consultationModel.find({ uhid }).sort({ createdAt: -1 }).exec();
  }

  async getLatestSoap(uhid: string): Promise<ConsultationDocument> {
    let consultation = await this.consultationModel
      .findOne({ uhid })
      .sort({ createdAt: -1 })
      .exec();

    if (!consultation) {
      consultation = new this.consultationModel({
        uhid,
        visitDate: '26 Sep 2026',
        visitTime: '09:30 AM',
        subjective:
          'Patient presents for routine follow-up of Type 2 Diabetes and Hypertension. Reports occasional morning headaches and postprandial fatigue. Denies chest pain, shortness of breath, or visual disturbances. Compliance with Metformin has been irregular over past 2 weeks.',
        objective:
          'Vitals: BP 138/88 mmHg, HR 78 bpm, SpO2 98%, Temp 98.4°F, BMI 25.0 kg/m².\nCVS: S1, S2 heard, no murmurs.\nRS: Bilateral clear, vesicular breath sounds.\nAbdomen: Soft, non-tender, no organomegaly.\nExtremities: No pedal edema, peripheral pulses palpable.',
        assessment:
          '1. Type 2 Diabetes Mellitus - sub-optimally controlled, likely medication non-adherence.\n2. Primary Hypertension - Stage 1, moderately controlled.\n3. Overweight BMI - lifestyle intervention needed.',
        plan:
          '1. Reinforce medication adherence: Metformin 500mg BD after meals.\n2. Add Telmisartan 40mg OD morning for BP stabilization.\n3. Order HbA1c, Fasting Blood Sugar, Lipid Profile, and Serum Creatinine.\n4. Dietary counselling: low glycemic index diet, sodium < 2g/day.\n5. Review in 4 weeks with home BP & blood sugar log.',
        icd10: [
          { code: 'I10', description: 'Essential (primary) hypertension', type: 'Chronic' },
          { code: 'E11.9', description: 'Type 2 diabetes mellitus without complications', type: 'Chronic' },
        ],
        isFinal: false,
      });
      await consultation.save();
    }
    return consultation;
  }

  async saveSoap(data: Partial<Consultation>): Promise<ConsultationDocument> {
    const rawData = data as any;
    if (rawData._id) {
      const existing = await this.consultationModel.findById(rawData._id).exec();
      if (existing) {
        Object.assign(existing, data);
        return existing.save();
      }
    }

    const created = new this.consultationModel(data);
    return created.save();
  }

  async searchIcd10(query?: string) {
    if (!query) return DEFAULT_ICD10_CODES;
    const q = query.toLowerCase();
    return DEFAULT_ICD10_CODES.filter(
      item =>
        item.code.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q),
    );
  }

  async generateAiSuggestions(symptoms: string) {
    return {
      considerations: [
        'Consider evaluating for Microalbuminuria due to co-existing T2D and Hypertension.',
        'Patient reports fatigue; check TSH and Serum Ferritin to rule out secondary causes.',
        'Potential ACEi/ARB + Metformin interaction with renal clearance; check eGFR.',
      ],
      suggestedInvestigations: [
        'HbA1c (Glycated Hemoglobin)',
        'Fasting Blood Glucose + Postprandial',
        'Lipid Profile (Full)',
        'Kidney Function Test (Serum Creatinine & Urea)',
        'Urine Routine & Microalbumin',
      ],
      suggestedTreatmentPlan: [
        'Continue Metformin 500 mg BD (After food)',
        'Telmisartan 40 mg OD (Morning, after breakfast)',
        'Lifestyle modifications: 30 mins brisk walk 5 days/week',
        'Schedule Ophthalmology fundus screening for diabetic retinopathy',
      ],
      patientEducation: [
        'Signs of hypoglycemia (sweating, tremors, dizziness)',
        'Importance of timed meals while on anti-diabetic medications',
        'Home BP recording technique: sit quietly for 5 mins before measurement',
      ],
    };
  }
}
