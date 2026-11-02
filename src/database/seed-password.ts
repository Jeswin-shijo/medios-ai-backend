/**
 * The password given to every demo login. A remote seed must bring its own password:
 * `Admin@123` is published, so it is only allowed on a database on this machine.
 */
export const LOCAL_DEMO_PASSWORD = 'Admin@123';

export function isLocalMongoUri(uri: string | undefined): boolean {
  if (!uri) return true; // the seed defaults to a local database
  const host = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?:,]+)/i.exec(uri.trim())?.[1]?.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

export function resolveDemoPassword(env: Record<string, string | undefined> = process.env): string {
  const chosen = env.SEED_DEMO_PASSWORD;
  if (chosen) return chosen;
  if (isLocalMongoUri(env.MONGODB_URI)) return LOCAL_DEMO_PASSWORD;
  throw new Error('Refusing to seed a remote database with the published demo password. Set SEED_DEMO_PASSWORD to a private password.');
}
