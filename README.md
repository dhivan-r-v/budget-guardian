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

1. **Detect.** Plain code projects each category's month (spent so far + usual spending for the rest of the month) and flags categories heading 30%+ and $25+ above their usual month.
2. **Explain.** Code splits the increase exactly into more purchases, higher prices and subscription changes. An LLM writes the friendly text around those figures; any number it adds or changes is rejected.
3. **Suggest.** Only for categories you mark as flexible: public transport days for fuel (money and kg CO2), skipping subscriptions not billed yet, cutting back. Habits show small, frequent purchases and what halving them saves.
4. **Approve, then act.** Nothing happens until you approve one plan. The server recomputes the amount, records the approval, and only then moves it to your savings account with a PayPal Payout, which can never be paid twice.

`npm test` runs the test suite. `npm run spikes`, `npm run advice` and `npm run categorize` print each step from the command line.

## License

MIT
