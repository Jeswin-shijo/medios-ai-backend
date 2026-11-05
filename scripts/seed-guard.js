// Runs before `npm run seed` (npm's "preseed" hook). The demo seed deletes and replaces
// every collection and creates demo logins with a published password, so it refuses any
// database that is not on this machine unless SEED_ALLOW_REMOTE=true is set on purpose.
// Use the same database the API would: read .env (an explicit MONGODB_URI wins), never guess one.
const { existsSync } = require('fs');
const { join } = require('path');
const envFile = join(__dirname, '..', '.env');
if (!process.env.MONGODB_URI && existsSync(envFile)) process.loadEnvFile(envFile);
if (!process.env.MONGODB_URI) {
  console.error('Refusing to seed: MONGODB_URI is not set (put it in .env or pass it explicitly).');
  process.exit(1);
}
const uri = process.env.MONGODB_URI;
// The first host in the URI, without credentials, port or path ("[::1]" stays whole).
const host = uri.replace(/^mongodb(\+srv)?:\/\//, '').replace(/^[^@/]*@/, '').match(/^(\[[^\]]*\]|[^/:?,]*)/)[1];
const local = ['localhost', '127.0.0.1', '[::1]'].includes(host);

if (!local && process.env.SEED_ALLOW_REMOTE !== 'true') {
  console.error(
    `Refusing to seed ${host}: the demo seed wipes the database and adds demo accounts (password Admin@123).\n` +
      'For a real deployment use `npm run create-user` instead. To load demo data into a remote\n' +
      'demo database anyway, run again with SEED_ALLOW_REMOTE=true.',
  );
  process.exit(1);
}
