/** One correction or refund waiting for an admin, with what the admin needs to decide it (read from Revenue's own records). */
export interface PendingApprovalRow {
  /** The Coordinator approval to act on. */
  approvalId: string;
  type: 'correction' | 'refund';
  /** change, reversal, discount or writeoff for a correction; refund for a refund. */
  kind: 'change' | 'reversal' | 'discount' | 'writeoff' | 'refund';
  /** The correction's or refund's own id. */
  recordId: string;
  bill: { id: string; number: string; kind: string; patientName: string; patientUhid: string };
  /** The charge line a correction changes; absent for a bill-level one and for a refund. */
  line?: { id: string; name: string; amount: number };
  amount?: number;
  percent?: number;
  qty?: number;
  unitPrice?: number;
  reason: string;
  requestedBy: string;
  requestedAt: string;
}
