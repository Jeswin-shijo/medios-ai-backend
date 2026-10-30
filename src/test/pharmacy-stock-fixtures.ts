import { clinicNow, isoDate } from '../common/utils/clinic-time';
import { productByKey } from '../modules/pharmacy/pharmacy-catalogue';
import { PharmacyIssueService } from '../modules/pharmacy/pharmacy-issue.service';
import { PharmacyStockService } from '../modules/pharmacy/pharmacy-stock.service';
import { PharmacySettingsService } from '../modules/pharmacy/pharmacy-settings.service';
import { SettingsService } from '../modules/settings/settings.service';
import { models } from './test-db';
import { DOC, PHARM, World } from './pharmacy-fixtures';

const DAY = 86_400_000;
/** A clinic date `n` days from today, as YYYY-MM-DD. */
export const inDays = (n: number) => isoDate(new Date(clinicNow().getTime() + n * DAY));

/** The stock and issue services wired onto a world. */
export function buildStock(m: ReturnType<typeof models>, w: World) {
  const settings = new PharmacySettingsService(new SettingsService(m.HospitalSettings));
  const stock = new PharmacyStockService(m.PharmacyBatch, m.PharmacyMovement, m.PharmacyStockLevel, m.PharmacyLine, m.PharmacyOrder, m.TaskAlertItem, w.orders, settings);
  const issue = new PharmacyIssueService(m.PharmacyBatch, m.PharmacyMovement, m.PharmacyLine, m.PharmacyOrder, stock, w.orders, w.checks);
  /** A batch written straight to the database (so it can be expired, which receive refuses). */
  const batch = (product: string, store: 'main' | 'er', batchNo: string, days: number, quantity: number) =>
    m.PharmacyBatch.create({
      product, medicine: productByKey(product)!.medicine, store, batchNo, expiry: inDays(days), quantity,
      receivedBy: { id: PHARM.id, name: PHARM.name }, receivedAt: clinicNow(), takes: [],
    }) as Promise<any>;
  /** An ordered and approved line. */
  const approved = async (lines: any[], priority: 'stat' | 'urgent' | 'routine' = 'urgent') => {
    const v = await w.orders.order(DOC, { patientId: w.patientId, priority, lines });
    for (const l of v.lines) await w.checks.approve(PHARM, l.id, { reason: 'intended' });
    return v;
  };
  return { stock, issue, batch, approved };
}
export type StockWorld = ReturnType<typeof buildStock>;
