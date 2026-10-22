import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Consultation, ConsultationDocument } from './schemas/consultation.schema';
import { displayDate, displayTime } from '../../common/utils/clinic-time';

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

  /**
   * Latest note for the patient. A patient with no consultation yet gets a blank,
   * unsaved draft (no `id`) dated now; POST /consultations/soap stores it.
   */
  async getLatestSoap(uhid: string, doctorName: string): Promise<ConsultationDocument | Partial<Consultation>> {
    const consultation = await this.consultationModel
      .findOne({ uhid })
      .sort({ createdAt: -1 })
      .exec();

    return (
      consultation ?? {
        uhid,
        patientName: '',
        visitDate: displayDate(),
        visitTime: displayTime(),
        visitType: '',
        doctor: doctorName,
        department: '',
        reason: '',
        subjective: '',
        objective: '',
        assessment: '',
        plan: '',
        freeText: '',
        icd10: [],
        isFinal: false,
      }
    );
  }

  /** Updates the note named by `id`, or creates one when there is no `id`. */
  async saveSoap(
    data: Partial<Consultation> & { id?: string; _id?: string },
    doctorName: string,
  ): Promise<ConsultationDocument> {
    const { id, _id, ...fields } = data;
    const existingId = id ?? _id;
    if (existingId) {
      const existing = await this.consultationModel.findById(existingId).exec();
      if (!existing) throw new NotFoundException(`Consultation ${existingId} not found`);
      Object.assign(existing, fields);
      return existing.save();
    }

    const created = new this.consultationModel({ ...fields, doctor: fields.doctor || doctorName });
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
