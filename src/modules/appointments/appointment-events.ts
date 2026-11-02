import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';

export interface AppointmentStatusChange {
  id: string;
  status: string;
}

export interface AppointmentSlotFreed {
  id: string;
  doctorId: string;
  date: string;
  time: string;
}

/**
 * Announces status changes made through the appointments API, so modules that
 * depend on appointments (the token queue) can follow them without the appointments
 * module depending back on them.
 */
@Injectable()
export class AppointmentEvents {
  private readonly statusChanges = new Subject<AppointmentStatusChange>();
  readonly statusChanges$ = this.statusChanges.asObservable();

  private readonly slotsFreed = new Subject<AppointmentSlotFreed>();
  /** A slot was freed through the appointments API (a cancel). Scheduling's waitlist follows it. */
  readonly slotFreed$ = this.slotsFreed.asObservable();

  slotFreed(slot: AppointmentSlotFreed) {
    this.slotsFreed.next(slot);
  }

  statusChanged(change: AppointmentStatusChange) {
    this.statusChanges.next(change);
  }
}
