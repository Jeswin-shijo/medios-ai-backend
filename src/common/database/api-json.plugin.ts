import { Schema } from 'mongoose';

/**
 * Shapes every document the API returns: `_id` becomes a string `id` (clients key
 * records by `id`), `__v` is dropped, and password hashes never leave the server.
 * Registered on the connection, so it covers every schema including embedded ones.
 */
export function apiJsonPlugin(schema: Schema) {
  schema.set('toJSON', {
    transform: (_doc, ret) => {
      const { _id, __v, passwordHash, ...rest } = ret;
      return _id == null ? rest : { id: String(_id), ...rest };
    },
  });
}
