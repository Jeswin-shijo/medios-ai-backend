import { UserRole } from '../users/schemas/user.schema';

/** The signed-in staff member behind a bed change. */
export interface Actor {
  id: string;
  name: string;
  role: UserRole;
}

/** The request's user (the User document) as an Actor. */
export const actorOf = (user: any): Actor => ({ id: String(user._id ?? user.id), name: user.name, role: user.role });

/** See the board and stream; suggest, hold, admit, transfer and discharge. */
export const ADMIT_ROLES = [UserRole.ADMIN, UserRole.DOCTOR, UserRole.NURSE, UserRole.STAFF];
/** Mark beds cleaned, block and unblock them. */
export const HOUSEKEEPING_ROLES = [UserRole.ADMIN, UserRole.NURSE, UserRole.STAFF];
/** Choose a bed the rules exclude, with a reason. */
export const OVERRIDE_ROLES = [UserRole.ADMIN, UserRole.DOCTOR];
