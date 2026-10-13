// Prints the advisor's text for every spike, plus any --category asked for.
// Usage: node --env-file-if-exists=.env scripts/advice.js [--as-of YYYY-MM-DD] [--category entertainment]

import { parseArgs } from 'node:util';
import { openDb } from '../src/db.js';
import { detectSpikes } from '../src/spikes.js';
import { adviseCategory } from '../src/advisor.js';
import { aiAvailable, AI_MODEL } from '../src/ai.js';

const { values: args } = parseArgs({
  options: { 'as-of': { type: 'string' }, category: { type: 'string', multiple: true } },
});
const db = openDb();
const report = detectSpikes(db, args['as-of'] ? { asOf: args['as-of'] } : {});
const wanted = new Set([...report.spikes.map((s) => s.category), ...(args.category ?? [])]);

console.log(aiAvailable() ? `Using ${AI_MODEL}.` : 'No GEMINI_API_KEY: using code-written text.');
for (const category of wanted) {
  const entry = report.categories.find((c) => c.category === category);
  if (!entry) {
    console.log(`\n${category}: no spending found.`);
    continue;
  }
  const { advice } = await adviseCategory(db, report, entry);
  const how = advice.source === 'ai' ? `AI${advice.cached ? ', cached' : ''}` : `template${advice.aiError ? `; AI rejected: ${advice.aiError}` : ''}`;
  console.log(`\n[${category}] (${how})`);
  console.log(advice.headline);
  console.log(advice.explanation);
  for (const o of advice.options) console.log(`  - ${o.text}`);
}
db.close();
