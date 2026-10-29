import { ReceptionSettings } from './reception-settings';
import { KioskTokenView } from './reception.types';
import { QueueService } from '../queue/queue.service';

/** Where tracking links point: the setting, else PUBLIC_WEB_URL, else nothing. */
export function resolveTrackingBase(reception: ReceptionSettings, publicWebUrl?: string): string {
  return reception.trackingBaseUrl || (publicWebUrl ?? '').replace(/\/+$/, '');
}

export function toKioskTokenView(view: Awaited<ReturnType<QueueService['kioskView']>>, trackingBase: string): KioskTokenView {
  return {
    label: view.label,
    status: view.status,
    ahead: view.ahead,
    room: view.room,
    doctorName: view.doctorName,
    department: view.department,
    trackCode: view.trackCode,
    trackUrl: trackingBase ? `${trackingBase}/track#${view.trackCode}` : '',
    issuedAt: new Date(view.issuedAt).toISOString(),
    appointmentTime: view.appointmentTime || undefined,
  };
}
