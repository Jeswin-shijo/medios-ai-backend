import { SetMetadata } from '@nestjs/common';
import { UserRole } from '../../modules/users/schemas/user.schema';

export const ROLES_KEY = 'roles';

/** Restricts a route (or controller) to the listed roles; enforced by RolesGuard. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
