import { db, LOCAL_USER_ID } from './db';
import { applySchema } from './db/migrate';
import { closePool } from './db/pool';

// One-off: hand the pre-auth local data (imported from the old JSON store) to a
// real signed-in account, so signing in with Google does not present an empty
// dashboard.
//
//   1. Sign in with Google once so the account exists.
//   2. npm run claim-local -- you@gmail.com
//
// Safe to re-run: rows already owned by the destination account are left alone.

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: npm run claim-local -- <your-google-email>');
    process.exitCode = 1;
    return;
  }

  await applySchema();

  const target = await db.getUserByEmail(email);
  if (!target) {
    console.error(`No account found for ${email}. Sign in with Google once first, then re-run.`);
    process.exitCode = 1;
    return;
  }
  if (target.id === LOCAL_USER_ID) {
    console.log('That account already owns the local data — nothing to do.');
    return;
  }

  const moved = await db.transferUserData(LOCAL_USER_ID, target.id);
  console.log(`Claimed local data for ${target.email} (${target.id}):`);
  for (const [table, count] of Object.entries(moved)) console.log(`  ${table}: ${count} rows`);
  console.log('\nReload the dashboard — your jobs, scores and pipeline should be there.');
}

main()
  .catch((e) => { console.error('Claim failed:', e); process.exitCode = 1; })
  .finally(closePool);
