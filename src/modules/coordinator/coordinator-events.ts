import { Injectable } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { UserRole } from '../users/schemas/user.schema';
import type { AgentKey } from './coordinator-types';

export interface CoordinatorEvent {
  kind: 'message' | 'case' | 'clock' | 'escalation' | 'approval' | 'agent' | 'rule';
  id: string;
  caseId?: string;
  from?: AgentKey;
  to?: AgentKey[];
  summary?: string;
}

/** Which agents' events each narrow role may read in full (Y42). Other roles see everything. */
const READS: Partial<Record<UserRole, AgentKey[]>> = {
  [UserRole.PHARMACIST]: ['pharmacy', 'lab'],
  [UserRole.LAB]: ['lab'],
};

/**
 * What a signed-in role may see of an event. Pharmacists and lab staff get an event in full only
 * when it comes from an agent they read; any other is cut to `{ kind, from }`, enough to refetch.
 */
export function eventFor(role: UserRole, e: CoordinatorEvent): CoordinatorEvent | Pick<CoordinatorEvent, 'kind' | 'from'> {
  const reads = READS[role];
  if (!reads || (e.from && reads.includes(e.from))) return e;
  return { kind: e.kind, from: e.from };
}

/** Live feed of what the Coordinator does, for the stream endpoint. */
@Injectable()
export class CoordinatorEvents {
  private readonly subject = new Subject<CoordinatorEvent>();
  readonly events$: Observable<CoordinatorEvent> = this.subject.asObservable();

  emit(e: CoordinatorEvent): void {
    this.subject.next(e);
  }
}
