import { medicineByKey, Priority, productByKey } from './pharmacy-catalogue';
import type { PatientFactsView } from './pharmacy-patients.service';
import type { Flag, FlagKind } from './pharmacy-rules';
import type { PharmacyTargets } from './pharmacy-settings.service';
import type { PharmacyLineDocument, PharmacyLineStatus } from './schemas/pharmacy-line.schema';
import type { PharmacyOrderDocument, PharmacySetting } from './schemas/pharmacy-order.schema';

const MIN_MS = 60_000;
const iso = (d?: Date | null) => (d ? new Date(d).toISOString() : null);

export interface FlagView {
  key: string;
  kind: FlagKind;
  severity: 'red' | 'amber';
  text: string;
  confirmed: { by: string; reason: string; at: string } | null;
  reviewed: { by: string; at: string } | null;
}

export interface QueryView {
  seq: number;
  kind: string;
  question: string;
  by: { id: string; name: string };
  at: string;
  dueAt: string;
  suggestions: { medicine: string; label: string }[];
  answer: { outcome: string; by: { id: string; name: string }; reason: string; at: string } | null;
}

type By = { id: string; name: string };
export interface PharmacyLineView {
  id: string;
  orderId: string;
  orderNumber: string;
  priority: Priority;
  setting: PharmacySetting;
  defaultStore: 'main' | 'er';
  source: 'order' | 'prescription';
  status: PharmacyLineStatus;
  medicine: string | null;
  medicineLabel: string;
  product: string | null;
  productLabel: string;
  freeName: string | null;
  dose: number | null;
  unit: string;
  route: string;
  frequency: string;
  durationDays: number | null;
  quantity: number | null;
  issueUnit: string;
  note: string;
  version: number;
  flags: FlagView[];
  query: QueryView | null;
  approved: { by: By; at: string; reason: string | null } | null;
  rejected: { by: By; reason: string; at: string } | null;
  issued: { by: By; at: string; store: string; quantity: number | null; batches: { batch: string; batchNo: string; expiry: string; qty: number }[] } | null;
  cancelled: { by: By; reason: string; at: string } | null;
  stopped: { by: By; reason: string; at: string } | null;
  waitingForStock: boolean;
  replaces: string | null;
  prescriptionItem: string | null;
  checkDueAt: string | null;
  issueDueAt: string | null;
  orderedBy: By;
  orderedAt: string;
  patient: {
    id: string;
    name: string;
    uhid: string;
    location: { area: PharmacySetting; ward?: string };
    allergies: string[];
    weightKg: number | null;
    age: number | null;
    sex: 'M' | 'F' | 'Other' | null;
    egfr: number | null;
    egfrAt: string | null;
  };
}

export interface PharmacyOrderView {
  id: string;
  number: string;
  patientId: string;
  patientUhid: string;
  patientName: string;
  caseId: string;
  setting: PharmacySetting;
  ward: string | null;
  orderedBy: By;
  priority: Priority;
  note: string;
  source: 'order' | 'prescription';
  prescriptionId: string | null;
  orderedAt: string;
  lines: PharmacyLineView[];
}

/**
 * A flag as the views show it. With the line's `version`, a confirmation or review made on an older version is
 * hidden (null), the same rule as needsDoctor, needsReason and needsReview in pharmacy-rules.ts.
 */
export const flagView = (f: Flag, version?: number): FlagView => ({
  key: f.key,
  kind: f.kind,
  severity: f.severity,
  text: f.text,
  confirmed: f.confirmed && (version === undefined || f.version === version) ? { by: f.confirmed.by, reason: f.confirmed.reason, at: iso(f.confirmed.at)! } : null,
  reviewed: f.reviewed && (version === undefined || f.version === version) ? { by: f.reviewed.by, at: iso(f.reviewed.at)! } : null,
});

/** The views of lines, built from what the service read: the orders, the targets, each patient's facts and each case's location. Pure. */
export function buildLineViews(
  lines: PharmacyLineDocument[],
  orders: Map<string, PharmacyOrderDocument>,
  targets: PharmacyTargets,
  facts: Map<string, PatientFactsView>,
  where: Map<string, { area: PharmacySetting; ward?: string }>,
): PharmacyLineView[] {
    return lines.flatMap((l) => {
      const o = orders.get(String(l.order));
      if (!o) return [];
      const f = facts.get(String(l.patient))!;
      const product = l.product ? productByKey(l.product) : undefined;
      const created = o.createdAt ?? new Date();
      const checkDue = l.status === 'to-check' ? new Date(new Date(l.enteredCheckAt ?? created).getTime() + targets.check[o.priority] * MIN_MS) : null;
      const issueDue =
        l.status === 'approved' && !l.waitingForStock && o.setting !== 'OPD' ? new Date(new Date(l.issueFrom ?? created).getTime() + targets.issue[o.priority] * MIN_MS) : null;
      const q = l.query;
      const view: PharmacyLineView = {
        id: String(l._id),
        orderId: String(o._id),
        orderNumber: o.number,
        priority: o.priority,
        setting: o.setting,
        defaultStore: o.setting === 'ER' ? 'er' : 'main',
        source: o.source,
        status: l.status,
        medicine: l.medicine,
        medicineLabel: l.medicine ? (medicineByKey(l.medicine)?.name ?? l.medicine) : (l.freeName ?? 'Unlisted medicine'),
        product: l.product,
        productLabel: product?.label ?? l.freeName ?? 'Unlisted medicine',
        freeName: l.freeName ?? null,
        dose: l.dose,
        unit: l.unit,
        route: l.route,
        frequency: l.frequency,
        durationDays: l.durationDays,
        quantity: l.quantity,
        issueUnit: product?.issueUnit ?? '',
        note: l.note ?? '',
        version: l.version,
        flags: ((l.flags ?? []) as Flag[]).map((f) => flagView(f, l.version)),
        query: q
          ? {
              seq: q.seq,
              kind: q.kind,
              question: q.question,
              by: q.by,
              at: iso(q.at)!,
              dueAt: iso(q.dueAt)!,
              suggestions: (q.suggestions ?? []).map((m) => ({ medicine: m, label: medicineByKey(m)?.name ?? m })),
              answer: q.answer ? { outcome: q.answer.outcome, by: q.answer.by, reason: q.answer.reason, at: iso(q.answer.at)! } : null,
            }
          : null,
        approved: l.approved ? { by: l.approved.by, at: iso(l.approved.at)!, reason: l.approved.reason ?? null } : null,
        rejected: l.rejected ? { by: l.rejected.by, reason: l.rejected.reason, at: iso(l.rejected.at)! } : null,
        issued: l.issued ? { by: l.issued.by, at: iso(l.issued.at)!, store: l.issued.store, quantity: l.issued.quantity ?? null, batches: l.issued.batches ?? [] } : null,
        cancelled: l.cancelled ? { by: l.cancelled.by, reason: l.cancelled.reason, at: iso(l.cancelled.at)! } : null,
        stopped: l.stopped ? { by: l.stopped.by, reason: l.stopped.reason, at: iso(l.stopped.at)! } : null,
        waitingForStock: !!l.waitingForStock,
        replaces: l.replaces ? String(l.replaces) : null,
        prescriptionItem: l.prescriptionItem ?? null,
        checkDueAt: iso(checkDue),
        issueDueAt: iso(issueDue),
        orderedBy: o.orderedBy,
        orderedAt: iso(o.orderedAt)!,
        patient: {
          id: String(l.patient),
          name: o.patientName,
          uhid: o.patientUhid,
          location: where.get(String(o.case))!,
          allergies: f.allergies,
          weightKg: f.weightKg,
          age: f.age,
          sex: f.sex,
          egfr: f.egfr,
          egfrAt: f.egfrAt,
        },
      };
      return [view];
    });
}

/** The views of orders, with their lines from `views`. Pure. */
export function buildOrderViews(orders: PharmacyOrderDocument[], views: PharmacyLineView[]): PharmacyOrderView[] {
  return orders.map((o) => ({
      id: String(o._id),
      number: o.number,
      patientId: String(o.patient),
      patientUhid: o.patientUhid,
      patientName: o.patientName,
      caseId: String(o.case),
      setting: o.setting,
      ward: o.ward ?? null,
      orderedBy: o.orderedBy,
      priority: o.priority,
      note: o.note ?? '',
      source: o.source,
      prescriptionId: o.prescription ? String(o.prescription) : null,
      orderedAt: iso(o.orderedAt)!,
      lines: views.filter((v) => v.orderId === String(o._id)),
  }));
}
