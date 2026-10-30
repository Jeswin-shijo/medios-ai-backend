import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { LabReportDocument, LabTestReport } from '../lab-reports/schemas/lab-report.schema';
import { Patient, PatientDocument } from '../patients/schemas/patient.schema';
import { KidneyStatus, PatientFacts, Sex, egfr } from './pharmacy-rules';

/** A kidney report older than this (real time) is not used. */
export const KIDNEY_FRESH_MS = 72 * 3_600_000;

export type PatientFactsView = PatientFacts & { creatinine: number | null; egfrAt: string | null };

const NONE: PatientFactsView = { age: null, sex: null, weightKg: null, allergies: [], egfr: null, kidneyStatus: 'not-calculated', creatinine: null, egfrAt: null };

const SEX: Record<string, Sex> = { Male: 'M', Female: 'F', Other: 'Other' };

/** What the checks need to know about a patient: age, sex, weight, allergies and the latest kidney result. */
@Injectable()
export class PharmacyPatientsService {
  constructor(
    @InjectModel(Patient.name) private readonly patients: Model<PatientDocument>,
    @InjectModel(LabTestReport.name) private readonly reports: Model<LabReportDocument>,
  ) {}

  /** A missing Patient record (a seeded sample inpatient) gives no facts at all. */
  async facts(patientId: string): Promise<PatientFactsView> {
    const p = isValidObjectId(patientId) ? await this.patients.findById(patientId).lean().exec() : null;
    if (!p) return { ...NONE, allergies: [] };
    const age = typeof p.age === 'number' && Number.isFinite(p.age) ? p.age : null;
    const sex = SEX[p.gender] ?? null;
    const w = p.vitals?.weightKg;
    const weightKg = typeof w === 'number' && w > 0 ? w : null;
    const allergies = (p.allergies ?? []).filter((a): a is string => typeof a === 'string' && !!a.trim());
    const facts: PatientFactsView = { age, sex, weightKg, allergies, egfr: null, kidneyStatus: 'not-calculated', creatinine: null, egfrAt: null };
    // A child, or unknown age or sex: no eGFR can be calculated (the child flag covers children).
    if (age === null || age < 18 || sex === null) return facts;
    facts.kidneyStatus = 'unknown';
    const report = await this.reports
      .findOne({ uhid: p.uhid, testName: 'Kidney function', labLine: { $exists: true, $ne: null }, updatedAt: { $gte: new Date(Date.now() - KIDNEY_FRESH_MS) } })
      .sort({ updatedAt: -1 })
      .lean<{ groups?: { parameters?: { name: string; result: unknown }[] }[]; updatedAt?: Date }>()
      .exec();
    const creatinine = report?.groups?.flatMap((g) => g.parameters ?? []).find((q) => q.name === 'Creatinine')?.result;
    if (report && typeof creatinine === 'number') {
      const value = egfr({ creatinine, age, sex });
      if (value !== null) {
        facts.egfr = value;
        facts.kidneyStatus = 'known' as KidneyStatus;
        facts.creatinine = creatinine;
        facts.egfrAt = report.updatedAt ? new Date(report.updatedAt).toISOString() : null;
      }
    }
    return facts;
  }
}
