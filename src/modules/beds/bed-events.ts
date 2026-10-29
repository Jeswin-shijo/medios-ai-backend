import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';
import type { BedRequest } from './schemas/bed-request.schema';

/** A bed request changed state: what the live stream tells open screens. */
export type BedRequestEvent = {
  id: string;
  state: BedRequest['state'];
  type: BedRequest['type'];
  patientName: string;
  bedLabel?: string;
  reason: string;
};

/** A bed changed hands or state: what the Coordinator bridge reports on. Never carries more than the bridge needs. */
export type BedChange = {
  kind: 'admitted' | 'transferred' | 'discharged' | 'cleaned';
  bedId: string;
  bedLabel: string;
  fromBedLabel?: string;
  admissionId?: string;
  patientId?: string;
  patientUhid?: string;
  patientName?: string;
  /** True when a person did it (Admit here, a hand transfer); false for the Bed Agent's own moves. */
  byStaff: boolean;
  requestId?: string;
};

/**
 * Tells open bed board streams that a bed changed. In-process only: with more than
 * one API instance, a board on another instance catches up on its next refresh.
 */
@Injectable()
export class BedEvents {
  private readonly changes = new Subject<void>();
  readonly changes$ = this.changes.asObservable();
  private readonly requests = new Subject<BedRequestEvent>();
  readonly requests$ = this.requests.asObservable();
  private readonly bedChanges = new Subject<BedChange>();
  readonly bedChanges$ = this.bedChanges.asObservable();

  changed() {
    this.changes.next();
  }

  requestChanged(e: BedRequestEvent) {
    this.requests.next(e);
  }

  /** Tells listeners which bed changed. A listener's failure never reaches the bed action. */
  bedChanged(c: BedChange) {
    try {
      this.bedChanges.next(c);
    } catch {
      // Listeners catch their own errors; this is the last guard.
    }
  }
}
