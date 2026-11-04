import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';

export interface PatientDetailsChange {
  /** The patient's database id. */
  id: string;
}

/**
 * Announces a change of a patient's name or UHID made through the patients API (an ER placeholder filled in, a spelling
 * fixed), so modules that keep a copy of them (Revenue's bills) can follow without the patients module depending on them.
 */
@Injectable()
export class PatientEvents {
  private readonly changes = new Subject<PatientDetailsChange>();
  readonly detailsChanged$ = this.changes.asObservable();

  detailsChanged(change: PatientDetailsChange) {
    this.changes.next(change);
  }
}
