import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';

export interface AppointmentStatusChange {
  id: string;
  status: string;
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

  statusChanged(change: AppointmentStatusChange) {
    this.statusChanges.next(change);
  }
}
