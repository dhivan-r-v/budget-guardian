// Clears approval history and uploaded statements (and, with --reseed, regenerates the demo transactions) so a
// demo starts clean. Money already sent in the PayPal sandbox is not reversed.
// Usage: node scripts/reset-demo.js [--reseed]

import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { openDb, DB_PATH } from '../src/db.js';

const { values: args } = parseArgs({ options: { reseed: { type: 'boolean', default: false } } });
const db = openDb();
const { changes } = db.prepare('DELETE FROM approvals').run();
const uploads = db.prepare("DELETE FROM transactions WHERE source = 'statement'").run().changes;
db.prepare('DELETE FROM statement_imports').run();
console.log(`Cleared ${changes} approval(s) and ${uploads} uploaded statement purchase(s) from ${DB_PATH}.`);
db.close();
if (args.reseed) execFileSync(process.execPath, ['scripts/seed.js'], { stdio: 'inherit' });
