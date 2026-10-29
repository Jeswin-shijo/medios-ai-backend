import { Injectable } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import type { AgentKey } from './coordinator-types';

export interface CoordinatorEvent {
  kind: 'message' | 'case' | 'clock' | 'escalation' | 'approval' | 'agent' | 'rule';
  id: string;
  caseId?: string;
  from?: AgentKey;
  to?: AgentKey[];
  summary?: string;
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
