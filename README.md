# Budget Guardian

An AI agent that watches your PayPal spending, spots sudden spikes, explains which purchases caused them, and suggests realistic trade-offs with the exact amount saved. It never acts without your approval.

Built for the PayPal AI Hackathon. Work in progress.

## Run locally

Requires Node.js 22.13 or newer.

```bash
npm install
cp .env.example .env   # then fill in your PayPal sandbox keys and savings account
npm run seed           # 5 months of demo transactions into data/budget-guardian.db
npm run build          # builds the React dashboard
npm start              # http://localhost:3000
```

Use US sandbox accounts (Business for the app, Personal for the buyer and for `SAVINGS_RECEIVER_EMAIL`) so payments work in USD. `GEMINI_API_KEY` is optional: without it, explanations are written by code instead of AI.

To work on the dashboard with live reload, run `npm start` and `npm run dev:client` together, then open http://localhost:5173.

## How it works

0. **Ingest.** Spending comes from your PayPal account (Transaction Search, synced every 15 minutes) on top of seeded history. Only completed outgoing payments count: money coming in, PayPal's holds and Budget Guardian's own savings transfers are skipped. An LLM labels each new merchant (100% category and recurring accuracy on the 180 seeded transactions), with name rules as a fallback.
1. **Detect.** Plain code projects each category's month (spent so far + usual spending for the rest of the month) and flags categories heading 30%+ and $25+ above their usual month.
2. **Explain.** Code splits the increase exactly into more purchases, higher prices and subscription changes. An LLM writes the friendly text around those figures; any number it adds or changes is rejected.
3. **Suggest.** Only for categories you mark as flexible: public transport days for fuel (money and kg CO2), skipping subscriptions not billed yet, cutting back. Habits show small, frequent purchases and what halving them saves.
3b. **Rescue plan (AI agent).** When the month heads over budget, a planning agent (Gemini function calling) works out how to get back under. Its tools return exact figures from code: the budget, spikes and causes, recent purchases, savings options per category, and which past plans you kept or missed. It combines options, checks combinations with a simulate tool, and proposes a plan with a reason for each choice. Code checks the proposal (only offered options, one per category, no figure the tools did not return) and sends it back to the agent if it fails. The dashboard shows the plan and every step the agent took; you approve it in one go or pick plans per category. Without the AI, a rules planner proposes the plan.
4. **Approve, then act.** Nothing happens until you approve one plan. The server recomputes the amount, checks your PayPal balance (it refuses if the move would leave less than `MIN_BALANCE_AFTER_SAVINGS`, default $50), records the approval, and only then moves it to your savings account with a PayPal Payout, which can never be paid twice.
5. **Follow through.** Each approval records what the plan leaves for the category until month end (or which subscriptions to skip). The dashboard shows spending since you approved against that: on track, over plan, then kept or missed when the month ends.
6. **Alert.** Turn on alerts in Settings and spikes show up as notifications on that device (Web Push, no email, no app store). After each sync, each device gets an alert once when a category starts spiking and when an approved plan goes over. The text is written by code, so every number is exact. Works in Chrome, Edge and Firefox on desktop and Android; on iPhone (iOS 16.4+), add Budget Guardian to the Home Screen first.

To show a live purchase in the sandbox: `npm run demo-purchase -- --to <merchant sandbox email> --amount 48.20 --what "Fuel purchase"`, then `npm run sync` (PayPal can take up to ~3 hours to report it).

`npm test` runs the test suite. `npm run spikes`, `npm run advice` and `npm run categorize` print each step from the command line.

## License

MIT
