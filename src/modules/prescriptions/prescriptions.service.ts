import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Prescription, PrescriptionDocument } from './schemas/prescription.schema';

const KNOWN_INTERACTIONS: Record<string, string[]> = {
  metformin: ['cimetidine', 'furosemide', 'iodinated contrast agents'],
  telmisartan: ['potassium supplements', 'spironolactone', 'nsaids', 'ibuprofen'],
  atorvastatin: ['clarithromycin', 'itraconazole', 'grapefruit juice', 'gemfibrozil'],
  amlodipine: ['simvastatin', 'diltiazem'],
  aspirin: ['warfarin', 'ibuprofen', 'heparin'],
};

const ALTERNATIVES: Record<string, { generic: string; alternatives: string[] }> = {
  metformin: {
    generic: 'Metformin Hydrochloride (Glucophage)',
    alternatives: ['Glycomet 500mg', 'Riomet', 'Janumet (Metformin + Sitagliptin)'],
  },
  telmisartan: {
    generic: 'Telmisartan (Micardis)',
    alternatives: ['Telma 40', 'Cresort 40', 'Losartan 50mg', 'Olmesartan 20mg'],
  },
  atorvastatin: {
    generic: 'Atorvastatin Calcium (Lipitor)',
    alternatives: ['Atorva 10', 'Lipikind 10', 'Rosuvastatin 5mg'],
  },
};

@Injectable()
export class PrescriptionsService {
  constructor(
    @InjectModel(Prescription.name)
    private prescriptionModel: Model<PrescriptionDocument>,
  ) {}

  async findByPatient(uhid: string): Promise<Prescription[]> {
    return this.prescriptionModel.find({ uhid }).sort({ createdAt: -1 }).exec();
  }

  async findOne(id: string): Promise<PrescriptionDocument> {
    const rx = await this.prescriptionModel.findById(id).exec();
    if (!rx) {
      throw new NotFoundException(`Prescription ${id} not found`);
    }
    return rx;
  }

  async create(data: Partial<Prescription>): Promise<PrescriptionDocument> {
    const rx = new this.prescriptionModel(data);
    return rx.save();
  }

  async update(id: string, updates: Partial<Prescription>): Promise<PrescriptionDocument> {
    const rx = await this.findOne(id);
    Object.assign(rx, updates);
    return rx.save();
  }

  async checkInteractions(medicines: string[]) {
    const warnings: string[] = [];
    const normalized = medicines.map(m => m.toLowerCase());

    for (const med of normalized) {
      for (const [key, interactList] of Object.entries(KNOWN_INTERACTIONS)) {
        if (med.includes(key)) {
          for (const otherMed of normalized) {
            if (otherMed !== med && interactList.some(i => otherMed.includes(i))) {
              warnings.push(`Potential interaction between ${med} and ${otherMed}: Monitor patient or adjust dosage.`);
            }
          }
        }
      }
    }

    return {
      hasInteractions: warnings.length > 0,
      warnings,
      checkedMedicinesCount: medicines.length,
    };
  }

  async getAlternatives(medicine: string) {
    const key = medicine.toLowerCase();
    for (const [k, v] of Object.entries(ALTERNATIVES)) {
      if (key.includes(k)) {
        return v;
      }
    }
    return {
      generic: medicine,
      alternatives: [`Generic alternative for ${medicine}`],
    };
  }
}
