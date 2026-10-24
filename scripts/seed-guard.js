// Runs before `npm run seed` (npm's "preseed" hook). The demo seed deletes and replaces
// every collection and creates demo logins with a published password, so it refuses any
// database that is not on this machine unless SEED_ALLOW_REMOTE=true is set on purpose.
const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/medios_hospital';
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
