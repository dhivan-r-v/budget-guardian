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
AI explanations: the LLM turns the spike, cause and savings numbers into friendly text (it never computes amounts). Then habit insights, the approval button and the PayPal action.
