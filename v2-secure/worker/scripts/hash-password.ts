// Hash a password using the same PBKDF2 scheme the Worker verifies against.
// Used to mint user records before putting them into the USERS KV namespace.
//
// Imports hashPassword from src/auth.ts to guarantee identical iteration
// count + salt size + format. If a future change bumps PBKDF2 iterations
// in auth.ts, every newly-seeded user record matches automatically.
//
// Node 18+ ships btoa + Web Crypto globally, so auth.ts (written for the
// Workers runtime) executes unchanged under tsx.
//
// Usage:
//   npx tsx scripts/hash-password.ts <password>
//
// Then paste the printed hash into a wrangler command:
//   wrangler kv key put --binding=USERS thang@jellymedia.vn '{"pwd_hash":"<paste>","role":"admin","allowed_apps":["all"]}'

import { hashPassword } from '../src/auth';

const password = process.argv[2];
if (!password) {
  console.error('Usage: npx tsx scripts/hash-password.ts <password>');
  process.exit(1);
}

hashPassword(password).then((h) => {
  console.log(h);
});
