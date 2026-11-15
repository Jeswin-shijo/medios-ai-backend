import { UserRole } from '../users/schemas/user.schema';

/** The page and every read; open, note, change state, hand on and resolve tickets; contact and consent; check-up calls by hand; feedback. */
export const SUP_READ: readonly UserRole[] = [UserRole.ADMIN, UserRole.DOCTOR, UserRole.NURSE, UserRole.STAFF];
/** Send now, or dismiss, a Held update. */
export const SUP_SEND: readonly UserRole[] = [UserRole.ADMIN, UserRole.STAFF];
/** Mark a Needs doctor or Sent to ER check-up reviewed. */
export const SUP_REVIEW: readonly UserRole[] = [UserRole.ADMIN, UserRole.DOCTOR];
/** Templates and FAQs, Settings → Patient Support, and an update's full phone number. */
export const SUP_ADMIN: readonly UserRole[] = [UserRole.ADMIN];
