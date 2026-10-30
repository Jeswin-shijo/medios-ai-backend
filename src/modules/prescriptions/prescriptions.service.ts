import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Actor } from '../beds/actor';
import { PharmacyPrescriptionsService } from '../pharmacy/pharmacy-prescriptions.service';
import { nameChecks } from '../pharmacy/pharmacy-rules';
import { Prescription, PrescriptionDocument } from './schemas/prescription.schema';

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

/** The server owns these: a client body (the web PUTs the whole record back) never sets them. */
function withoutPharmacyFields<T extends object>(body: T): T {
  const clean = { ...body } as Record<string, unknown>;
  delete clean.pharmacyRev;
  delete clean.pharmacyBy;
  delete clean.pharmacyPending;
  return clean as T;
}

@Injectable()
export class PrescriptionsService {
  private readonly logger = new Logger(PrescriptionsService.name);

  constructor(
    @InjectModel(Prescription.name)
    private prescriptionModel: Model<PrescriptionDocument>,
    private readonly pharmacy: PharmacyPrescriptionsService,
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

  async create(data: Partial<Prescription>, actor: Actor): Promise<PrescriptionDocument> {
    const rx = new this.prescriptionModel({ ...withoutPharmacyFields(data), pharmacyRev: 1, pharmacyPending: true, pharmacyBy: { id: actor.id, name: actor.name } });
    const saved = await rx.save();
    await this.handOff(saved);
    return saved;
  }

  async update(id: string, updates: Partial<Prescription>, actor: Actor): Promise<PrescriptionDocument> {
    const rx = await this.findOne(id);
    Object.assign(rx, withoutPharmacyFields(updates));
    // An atomic increment of the stored value: a stale copy of the record can never repeat a revision.
    rx.$inc('pharmacyRev', 1);
    // Always written, even when the loaded copy already says true: a sync may have cleared it since the load.
    rx.pharmacyPending = true;
    rx.markModified('pharmacyPending');
    rx.pharmacyBy = { id: actor.id, name: actor.name };
    const saved = await rx.save();
    await this.handOff(saved);
    return saved;
  }

  /** Tells Pharmacy about the saved revision. The save never fails because of Pharmacy: reconcile picks it up later. */
  private async handOff(rx: PrescriptionDocument): Promise<void> {
    try {
      await this.pharmacy.sync(String(rx._id));
    } catch (e) {
      this.logger.error(`Prescription ${String(rx._id)} was saved but not sent to Pharmacy yet: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async checkInteractions(medicines: string[]) {
    const warnings = nameChecks(medicines).map((f) => `${f.severity === 'red' ? 'Red' : 'Amber'}: ${f.text}`);
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
