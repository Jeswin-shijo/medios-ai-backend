import { Schema } from 'mongoose';

/** Never serialized, even when a query selected them. */
const SECRET_FIELDS = ['passwordHash', 'tokenVersion', 'failedLoginAttempts', 'lockedUntil', 'tokenHash', 'keyHash'];

/**
 * Shapes every document the API returns: `_id` becomes a string `id` (clients key
 * records by `id`), `__v` is dropped, and credential fields never leave the server.
 * Registered on the connection, so it covers every schema including embedded ones.
 */
export function apiJsonPlugin(schema: Schema) {
  schema.set('toJSON', {
    transform: (_doc, ret) => {
      const { _id, __v, ...rest } = ret;
      for (const field of SECRET_FIELDS) delete rest[field];
      return _id == null ? rest : { id: String(_id), ...rest };
    },
  });
}
