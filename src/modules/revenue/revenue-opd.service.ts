import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { Subscription } from 'rxjs';
import { clinicNow, isoDate } from '../../common/utils/clinic-time';
import { AppointmentEvents, AppointmentStatusChange } from '../appointments/appointment-events';
import { Appointment, AppointmentDocument } from '../appointments/schemas/appointment.schema';
import { Patient, PatientDocument } from '../patients/schemas/patient.schema';
import { PriceListService } from './price-list.service';
import { RevenueBillsService } from './revenue-bills.service';
import { ChargeLine, ChargeLineDocument } from './schemas/charge-line.schema';

const BY = { name: 'Revenue Agent' };
const FEE_STATUSES = ['Checked In', 'Waiting', 'In Consultation', 'Completed'];

/**
 * The OPD consultation fee, charged once when an appointment is checked in. The one AppointmentEvents subscription lives here:
 * Task 9 adds a `Completed` branch to `onStatusChange` for OPD auto-settle. Nothing here ever throws into the stream.
 */
@Injectable()
export class RevenueOpdService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RevenueOpdService.name);
  private sub?: Subscription;

  constructor(
    private readonly appointmentEvents: AppointmentEvents,
    private readonly prices: PriceListService,
    private readonly bills: RevenueBillsService,
    @InjectModel(Appointment.name) private readonly appointments: Model<AppointmentDocument>,
    @InjectModel(Patient.name) private readonly patients: Model<PatientDocument>,
    @InjectModel(ChargeLine.name) private readonly chargeLines: Model<ChargeLineDocument>,
  ) {}

  onModuleInit() {
    this.sub = this.appointmentEvents.statusChanges$.subscribe((change) => {
      void this.onStatusChange(change);
    });
  }

  onModuleDestroy() {
    this.sub?.unsubscribe();
  }

  /** A small switch on the new status. Catches everything, so one failure never ends the subscription. */
  async onStatusChange(change: AppointmentStatusChange): Promise<void> {
    try {
      if (change.status === 'Checked In') await this.chargeFee(change.id);
    } catch (e) {
      this.logger.warn(`Appointment ${change.id} (${change.status}): ${(e as Error).message}`);
    }
  }

  /** Charges the doctor's fee for the appointment, once. No patient for the uhid: logs and returns (catchUp retries). */
  async chargeFee(appointmentId: string): Promise<void> {
    if (!isValidObjectId(appointmentId)) return;
    const source = { type: 'opd-fee', ref: appointmentId };
    // A replay finds the line first, so it never opens an empty bill.
    if (await this.chargeLines.exists({ 'source.type': source.type, 'source.ref': source.ref })) return;
    const appointment = await this.appointments.findById(appointmentId).lean().exec();
    if (!appointment) {
      this.logger.warn(`Appointment ${appointmentId} not found; no OPD fee`);
      return;
    }
    const patient = await this.patients.findOne({ uhid: appointment.uhid }).lean().exec();
    if (!patient) {
      this.logger.warn(`Appointment ${appointmentId}: no patient for that UHID; no OPD fee yet`);
      return;
    }
    const doctorId = appointment.doctorId || '';
    const fee = doctorId ? await this.prices.opdFee(doctorId) : { price: 0, doctorName: '', needsPrice: true };
    const bill = await this.bills.open({ kind: 'opd', appointmentId, patientId: String(patient._id), day: appointment.date });
    const doctorName = fee.doctorName || appointment.doctorName || '';
    await this.bills.addCharge(String(bill._id), {
      code: `opd:${doctorId || 'unknown'}`,
      name: doctorName ? `Consultation - ${doctorName}` : 'Consultation',
      category: 'consultation',
      qty: 1,
      unitPrice: fee.price,
      needsPrice: fee.needsPrice || !(fee.price > 0),
      source,
      by: BY,
    });
  }

  /** Today's checked-in, waiting, seen or completed appointments with no fee line get one. Returns how many were charged. */
  async catchUp(day: string = isoDate(clinicNow())): Promise<number> {
    const found = await this.appointments.find({ date: day, status: { $in: FEE_STATUSES } }).select('_id').lean().exec();
    let charged = 0;
    for (const a of found) {
      const id = String(a._id);
      try {
        if (await this.chargeLines.exists({ 'source.type': 'opd-fee', 'source.ref': id })) continue;
        await this.chargeFee(id);
        if (await this.chargeLines.exists({ 'source.type': 'opd-fee', 'source.ref': id })) charged++;
      } catch (e) {
        this.logger.warn(`OPD fee catch-up for ${id}: ${(e as Error).message}`);
      }
    }
    return charged;
  }
}
