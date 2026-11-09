import { UserRole } from '../users/schemas/user.schema';

/**
 * Who may do what on the Discharge Agent (global constraints, "Roles"). The routes use them in `@Roles`, and the
 * services check them again. Pharmacist and lab are in none: every `/discharge` route is 403 for them.
 */

/** Every read, the page and the day summary. */
export const DIS_READ: readonly UserRole[] = [UserRole.ADMIN, UserRole.DOCTOR, UserRole.NURSE, UserRole.STAFF];
/**
 * Target date, order, edit, cancel, Start now, follow up later, the "not needed" choices, summary edit, sign and
 * re-sign, the cause-of-death certificate tick.
 */
export const DIS_ORDER: readonly UserRole[] = [UserRole.ADMIN, UserRole.DOCTOR];
/** Hand-ticked nurse lines (teaching and documents, against-advice form, body handed over), Left without discharge. */
export const DIS_WARD: readonly UserRole[] = [UserRole.ADMIN, UserRole.NURSE];
/** Print the gate pass, Patient left, Body released. */
export const DIS_LEAVE: readonly UserRole[] = [UserRole.ADMIN, UserRole.NURSE, UserRole.STAFF];
/** Settings → Discharge, the no-bill override. */
export const DIS_ADMIN: readonly UserRole[] = [UserRole.ADMIN];
/** The tick route: a doctor's line needs DIS_ORDER, a nurse's line DIS_WARD. The route allows both; the service decides by the line. */
export const DIS_TICK: readonly UserRole[] = [...new Set([...DIS_ORDER, ...DIS_WARD])];
