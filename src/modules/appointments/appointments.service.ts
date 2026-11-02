import { ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Appointment, AppointmentDocument } from './schemas/appointment.schema';
import { clockLabel, clockMinutes, isoDate } from '../../common/utils/clinic-time';
import { escapeRegex } from '../../common/utils/escape-regex';
import { AppointmentEvents } from './appointment-events';
import { OpdService } from '../opd/opd.service';
import { isDuplicateKey, releaseStaleSlot, slotKeyOf } from './slot-key';

@Injectable()
export class AppointmentsService {
  constructor(
    @InjectModel(Appointment.name)
    private appointmentModel: Model<AppointmentDocument>,
    private readonly events: AppointmentEvents,
    @Optional() private readonly opd?: OpdService,
  ) {}

  async findAll(query: {
    date?: string;
    status?: string;
    uhid?: string;
    search?: string;
    limit?: number;
    skip?: number;
  }): Promise<{ appointments: Appointment[]; total: number }> {
    const filter: any = {};

    if (query.date) {
      filter.date = query.date;
    }

    if (query.status && query.status !== 'All') {
      filter.status = query.status;
    }

    if (query.uhid) {
      filter.uhid = query.uhid;
    }

    if (query.search) {
      filter.$or = [
        { patientName: { $regex: escapeRegex(query.search), $options: 'i' } },
        { uhid: { $regex: escapeRegex(query.search), $options: 'i' } },
        { condition: { $regex: escapeRegex(query.search), $options: 'i' } },
      ];
    }

    const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 500); // capped: one request cannot dump the collection
    const skip = Math.max(Number(query.skip) || 0, 0);

    const [appointments, total] = await Promise.all([
      this.appointmentModel.find(filter).sort({ time: 1 }).skip(skip).limit(limit).exec(),
      this.appointmentModel.countDocuments(filter).exec(),
    ]);

    return { appointments, total };
  }

  /** The day's queue in clock order ("02:00 PM" after "09:30 AM"). */
  async findToday(day: Date = new Date()): Promise<Appointment[]> {
    const appointments = await this.appointmentModel.find({ date: isoDate(day) }).exec();
    return appointments.sort((a, b) => clockMinutes(a.time) - clockMinutes(b.time));
  }

  async findOne(id: string): Promise<AppointmentDocument> {
    const appointment = await this.appointmentModel.findById(id).exec();
    if (!appointment) {
      throw new NotFoundException(`Appointment ${id} not found`);
    }
    return appointment;
  }

  /**
   * Books an appointment. One without a doctor gets the default doctor, so it holds a slot like every other booking; a taken slot is a 409.
   * With no OP doctor set up at all, it is stored as before, without a slot key.
   */
  async create(data: Partial<Appointment>): Promise<AppointmentDocument> {
    const fields: Partial<Appointment> = { ...data };
    if (!fields.doctorId && this.opd) {
      const doctor = await this.opd.defaultDoctor();
      if (doctor) Object.assign(fields, { doctorId: String(doctor._id), doctorName: doctor.name, departmentCode: doctor.departmentCode });
    }
    const minutes = clockMinutes(String(fields.time ?? ''));
    if (fields.doctorId && fields.date && minutes !== Number.MAX_SAFE_INTEGER) {
      fields.slotKey = slotKeyOf(fields.doctorId, fields.date, clockLabel(minutes));
      await releaseStaleSlot(this.appointmentModel, fields.slotKey);
    } else {
      delete fields.slotKey;
    }
    try {
      return await new this.appointmentModel(fields).save();
    } catch (e) {
      if (isDuplicateKey(e)) throw new ConflictException('That slot was just taken');
      throw e;
    }
  }

  async updateStatus(id: string, status: string): Promise<AppointmentDocument> {
    const appointment = await this.findOne(id);
    const wasCanceled = appointment.status === 'Canceled';
    if (wasCanceled && status !== 'Canceled') {
      throw new ConflictException("A cancelled appointment can't be reopened; book a new one.");
    }
    appointment.status = status;
    if (status === 'Canceled') appointment.set('slotKey', undefined); // releases the slot for the database guard
    if (status === 'Checked In' && !appointment.checkedInTime) {
      const now = new Date();
      appointment.checkedInTime = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    const saved = await appointment.save();
    this.events.statusChanged({ id: String(saved._id), status });
    if (status === 'Canceled' && !wasCanceled && saved.doctorId) {
      this.events.slotFreed({ id: String(saved._id), doctorId: saved.doctorId, date: saved.date, time: saved.time });
    }
    return saved;
  }

  async update(id: string, updates: Partial<Appointment>): Promise<AppointmentDocument> {
    const appointment = await this.findOne(id);
    Object.assign(appointment, updates);
    return appointment.save();
  }

  async remove(id: string): Promise<{ success: boolean; message: string }> {
    const appointment = await this.findOne(id);
    await this.appointmentModel.deleteOne({ _id: appointment._id }).exec();
    return { success: true, message: `Appointment ${id} deleted` };
  }
}
