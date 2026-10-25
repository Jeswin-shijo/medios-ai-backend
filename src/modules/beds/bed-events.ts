import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';

/**
 * Tells open bed board streams that a bed changed. In-process only: with more than
 * one API instance, a board on another instance catches up on its next refresh.
 */
@Injectable()
export class BedEvents {
  private readonly changes = new Subject<void>();
  readonly changes$ = this.changes.asObservable();

  changed() {
    this.changes.next();
  }
}
