# Budget Guardian

PayPal AI Hackathon project. Submission deadline: **Nov 12, 2026, 12:00pm PT** (Devpost).

## What it is
An AI agent that watches a user's PayPal spending, detects sudden spikes, explains
**which purchase caused the increase**, and suggests realistic trade-offs with the exact
amount saved. The agent **never acts without explicit user approval**.

## Core flow
1. **Ingest**: PayPal sandbox transactions + a seeded 4-6 months of history (sandbox accounts have none).
2. **Categorize**: LLM labels each transaction (entertainment, fuel, food, shopping, etc.) and flags recurring ones. Output as JSON.
3. **Detect spike**: plain code (NOT the LLM) compares this month's category totals with the user's usual monthly average.
4. **Attribute cause**: find the purchase or category that pushed spending up.
5. **Recommend**: code calculates the savings; the LLM only writes the friendly explanation.
   - Entertainment: "Skip these subscriptions this month and save X."
   - Fuel: "Use public transport 2-3 days this month and save X money and Y kg CO2."
6. **Habit insights**: from past months, show frequent expenses that could be avoided.
7. **Approve**: user taps a button. Nothing happens before this.
8. **Act**: after approval, the agent performs a real PayPal sandbox action (e.g. move saved amount via Payouts, or pause a subscription).

## Target audience
Students and young professionals on a fixed monthly income, where one unplanned purchase disrupts the whole month.

## Tech stack
- Frontend: React
- Backend: Node.js / Express (ES modules)
- Database: SQLite
- AI: LLM API for categorizing and explaining
- Payments: PayPal sandbox REST API, webhooks, Agent Toolkit / MCP server for the action step
- Deploy: Render

## Rules
- Credentials live only in `.env`. Never commit it. The repo is public, so `.gitignore` must include `.env` and `node_modules/`.
- MIT license in the repo.
- Never let the LLM do the math. Spike detection and savings are plain code so numbers stay accurate.
- Keep spike detection category-agnostic, but demo only **entertainment** and **fuel**.
- Let the user mark which categories are flexible. Do not let the AI decide needs vs wants.
- Use USD for the sandbox.
- Finish one flow perfectly before adding anything else.

## Environment variables (.env)
```
PAYPAL_CLIENT_ID=
PAYPAL_CLIENT_SECRET=
PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com
PORT=3000
```

## Current status
- PayPal sandbox app `budget-guardian` created, Transaction Search enabled.
- `server.js` (Express 5, `npm start`) has endpoints: `GET /api/test-token`, `POST /api/create-order`, `POST /api/capture-order/:orderId`.
- Full test order flow verified (Oct 13): create, approve with US Personal sandbox account, capture → COMPLETED, $10.00 USD.
- Uses US sandbox accounts. India sandbox Business accounts fail with `UNSUPPORTED_PAYEE_CURRENCY` for USD.
- Seed script done: `npm run seed` writes 5 months to SQLite (`data/budget-guardian.db`) with a fuel spike in the latest month.

- Spike detector done (`src/spikes.js`, `GET /api/spikes`, `npm run spikes`, `npm test`). Projection = spent so far + usual spending for the rest of the month; spike = 30%+ and $25+ above the usual monthly average.
- Cause step done (`src/causes.js`): splits a spike exactly into more often / higher prices / recurring changes, flags large purchases; included in `GET /api/spikes`.
- Savings + CO2 done (`src/savings.js`): fuel → public transport days (fuel minus fares, kg CO2 at $3.50/gal and 8.887 kg/gal), entertainment → skip subscriptions not billed yet, other flexible categories → cut back. Only for categories the user marked flexible (`category_prefs`, `GET/PUT /api/categories`). `GET /api/savings?category=`.
- AI advice done (`src/advisor.js`, `src/ai.js`, `GET /api/advice`, `npm run advice`): Gemini free tier (default `gemini-flash-lite-latest`) writes text around code-formatted facts; any number not in the facts is rejected; falls back to code-written text on rejection, API error or 15s timeout; validated answers cached in `ai_cache`. Free tier is flaky (503s, 5 req/min on some models), so the demo relies on the cache + fallback.
- Categorizer done (`src/categorizer.js`, `POST /api/categorize`, `npm run categorize [--reset]`): groups transactions by merchant + description (seed data = 32 groups = 1 request), code computes recurring evidence, LLM picks from a fixed category list, invalid labels ignored, complete batches cached, accuracy vs seed labels reported. Not yet run against Gemini: free tier returned 503 / timeouts on Oct 13.
- Habit insights done (`src/habits.js`, `GET /api/habits`, shown in `npm run spikes`): one-off purchases in flexible categories that average 4+/month, appear in 3+ baseline months and average $30 or less, grouped by category + description; shows monthly/yearly cost and what halving saves. Seed now also marks food flexible (demo: coffee $69.22/month, food delivery $201.92/month).
- Approval + PayPal action done (`src/approvals.js`, `src/paypal.js`, `public/index.html`): user approves one option in the page; server recomputes the amount (refuses if it changed), records the approval, then sends a PayPal sandbox Payout to `SAVINGS_RECEIVER_EMAIL` with the approval id as `sender_batch_id`. One plan per category per month. Verified Oct 13: $40.64 and $27.09 payouts SUCCESS (the second exposed the one-plan rule, since fixed).
- React dashboard done (`client/`, Vite + React 18, served by Express from `client/dist`): headline overspend, summary tiles, monthly chart per category (so far + projected vs usual, hover + table view), cause breakdown bar, approve flow, habits, approvals, flexible-category switches. Validated palette, light/dark, works at 375px. Advice endpoint no longer waits for the LLM (template now, AI text on a later load).
- Render-ready (`render.yaml`): web service `0.5c-512mb` ($7/month) in Singapore + 1 GB disk ($0.25/month) at `/var/data` for SQLite, health check `/api/health`, seeds demo data on first start (`seed.js --if-empty`), `DEMO_AS_OF=2026-10-13` pins the demo date (dashboard shows a "Sandbox demo" badge), `ADMIN_TOKEN` protects `POST /api/categorize`. `npm run reset-demo [--reseed]` clears approvals. Rehearsed locally with `NODE_ENV=production`.
- PayPal ingestion done (`src/paypalSync.js`, `GET/POST /api/paypal/*`, `npm run sync`, `npm run demo-purchase`): Transaction Search, last 90 days in 31-day windows, every 15 min + "Sync now". Stores only completed outgoing USD payments (T00xx); skips income, holds/releases (T15xx/T11xx), balance (T1900) and our own savings payouts (T0001 to the savings account / "Budget Guardian" note). Labels: LLM, then name rules for PayPal rows. Rolling demo (`DEMO_ROLLING=1`) replaces the pinned date. Categorizer accuracy measured Oct 14: 100% category, 100% recurring on 180 seeded transactions.
- Monthly budget done (`src/budget.js`, `GET/PUT /api/budget`, `settings` table): safe to spend = budget - spent - recurring still to come; per day over the days left; month-end projection vs budget; flags when the spikes alone cause the overspend. Demo budget $1,100 (usual month ~$965). Headline on the dashboard is now "safe to spend".

## Roadmap
**Week 1 (Oct 13-19):** finish sandbox setup and test order; optionally create US sandbox accounts; repo, license, `.gitignore`.
**Week 2 (Oct 20-26):** seed script (4-6 months of realistic transactions with one clear spike, including fuel and entertainment); LLM categorizer; spike detector and savings calculator; CO2 estimate for fuel.
**Week 3 (Oct 27-Nov 2):** AI advisor explanations; habit insights; approval button and PayPal action; dashboard UI.
**Week 4 (Nov 3-9):** deploy to Render; README with run instructions; demo video under 3 minutes; Devpost write-up.
**Nov 10-11:** submit early.

## Demo video plan (under 3 minutes)
1. Problem: one unplanned purchase wrecks a month (20s)
2. Spike alert (30s)
3. Agent explains the cause and savings: entertainment, then fuel with CO2 (60s)
4. Approve, show the real PayPal sandbox action (40s)
5. Impact and who it helps (20s)

## Judging criteria (equal weight)
Technological Implementation, Design, Potential Impact, Innovation, Presentation.
Aim for the "Best Use of Agentic Commerce" and "Best Use of PayPal + AI" honorable mentions.

## Next task
UI redesign, then deploy (user creates the Render service from `render.yaml`). Then demo video and Devpost write-up. `npm run reset-demo` before recording; make demo purchases ~3 hours ahead (PayPal reporting lag).
