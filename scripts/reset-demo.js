// Clears approval history, uploaded statements and visitors' demo copies (and, with --reseed, regenerates the demo transactions) so a
// demo starts clean. Money already sent in the PayPal sandbox is not reversed.
// Usage: node scripts/reset-demo.js [--reseed]

import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { openDb, DB_PATH } from '../src/db.js';

const { values: args } = parseArgs({ options: { reseed: { type: 'boolean', default: false } } });
const db = openDb();
const { changes } = db.prepare('DELETE FROM approvals').run();
const uploads = db.prepare("DELETE FROM transactions WHERE source = 'statement'").run().changes;
db.prepare('DELETE FROM statement_imports').run();
console.log(`Cleared ${changes} approval(s) and ${uploads} uploaded statement purchase(s) from ${DB_PATH}.`);
// Per-visitor demo copies (WORKSPACES=1): all removed; visitors get fresh ones.
const dropped = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'workspaces'").get().n
  ? db.prepare('DELETE FROM workspaces').run().changes
  : 0;
if (dropped) db.exec('DELETE FROM plaid_item_workspaces');
rmSync(path.join(path.dirname(DB_PATH), 'workspaces'), { recursive: true, force: true });
if (dropped) console.log(`Removed ${dropped} visitor demo copies.`);
db.close();
if (args.reseed) execFileSync(process.execPath, ['scripts/seed.js'], { stdio: 'inherit' });
