# Budget Guardian

An AI agent that watches your PayPal spending, spots sudden spikes, explains what caused them, and plans realistic trade-offs with the exact amount saved. When you approve a plan, it moves the savings with PayPal Payouts. It never acts without your approval.

**Live demo: https://budget-guardian.onrender.com** · [Demo video](https://youtu.be/E3c5bfofLw4) · [Devpost](https://devpost.com/software/budget-guardian-y7nq4k) · Built for the PayPal AI Hackathon · MIT license

## For judges: try it

No sign-up or login is needed. Every visitor gets their **own copy** of the demo, so nothing you do changes what other judges see, and **Settings → Reset the demo** starts over. The demo runs on PayPal's sandbox: no real money moves.

1. **See why spending spiked.** Under *Needs your attention*, each spike shows its cause (more purchases, higher prices, a new subscription), worked out in code, with an AI-written explanation.
2. **Approve the rescue plan.** The AI agent plans how to get back under budget. Open *How the agent planned this* to see every step it took. Approving moves real **sandbox** money to a savings account with PayPal Payouts, then tracks whether you keep the plan.
3. **Check your PayPal account.** Spending is read with PayPal Transaction Search, and the balance is checked before any money moves.
4. **Add a card.**
   - **Statement:** click *Download a sample card statement*, then *Upload a statement*. The AI reads the bank's layout, and code reads every amount.
   - **Plaid:** click *Connect a bank or credit card*, pick any test bank (e.g. First Platypus Bank), and log in with username **`user_transactions_dynamic`** and any password. These are Plaid's public sandbox test credentials. If asked for a phone number, choose to continue without one. If asked for a code, use `1234`.
5. **Get alerts on your phone.** Open the demo on your phone, then *Settings → Turn on alerts*. Spikes arrive as notifications. On iPhone, first use *Share → Add to Home Screen* and open it from there.

To protect the shared sandbox account until judging ends, the demo moves at most $300 a day across all visitors, and 8 approvals per visitor a day.

## What it does

| | |
|---|---|
| **Detect** | Projects each category's month (spent so far + usual spending for the rest of the month) and flags categories heading 30%+ and $25+ above their usual month. |
| **Explain** | Splits each increase exactly into more purchases, higher prices and subscription changes. AI writes the words; code supplies every number. |
| **Plan** | A tool-using AI agent combines savings options across the categories *you* marked as flexible, using your track record of plans kept and missed. It checks each combination with a simulator and proposes a plan with a reason for every choice. |
| **Act, with approval** | You approve; the server recomputes the amount, checks your PayPal balance, and moves the savings with a PayPal Payout that can never be paid twice. |
| **Follow through** | After approving, it tracks spending against what the plan allows: on track, over plan, kept or missed. |
| **Alert** | Device notifications (Web Push) when a category starts spiking or a plan goes off track. |
| **Budget** | Safe to spend for the rest of the month, per day, with bills still to come set aside. |
| **Ingest** | PayPal Transaction Search, banks and cards through Plaid, and CSV statements from any bank. |

## How it's built

**PayPal Developer Platform (sandbox)**

| API | Used for |
|---|---|
| Transaction Search (`/v1/reporting/transactions`) | Reads spending, synced every 15 minutes. Only completed outgoing USD payments count; income, holds and the app's own savings transfers are skipped. |
| Balances (`/v1/reporting/balances`) | Checked before every transfer. Refuses if it would leave less than a cushion (default $50). |
| Payouts (`/v1/payments/payouts`) | Moves approved savings. The approval id is the `sender_batch_id`, so a retry can never pay twice. |
| Orders v2 | Test checkout flow (`/api/create-order`, `/api/capture-order`). |

**AI**

- **Open-weight models through Groq:** Qwen 3.8 (`qwen/qwen3.8-27b`) for explanations, transaction labels and statement layouts, and **gpt-oss-120b** for the rescue planning agent (tool calling).
- **Gemini** takes over automatically when the open model fails. If both fail, code-written text keeps the app working.
- **The AI never does the math.** Code computes every figure; any number in AI text that code didn't supply is rejected; the agent can only choose options code offered; proposals that fail the checks go back to the agent with the reasons.
- **Measured:** 100% category and recurring-charge accuracy labeling the seeded demo history (165 transactions) with Qwen 3.8. The agent plans in about 5 seconds.

**Stack**

- **Server:** Node.js 24 with Express 5, and SQLite (built-in `node:sqlite`). Money is stored as integer cents.
- **Client:** React 18 with Vite.
- **Integrations:** Plaid (banks and cards), Web Push (alerts).
- **Hosting:** Render (Blueprint in `render.yaml`, with a persistent disk). Each visitor's demo is a small SQLite file of its own, attached to a shared database for the PayPal sync and the AI cache.
- **Tests:** 134 tests (`npm test`) and CI on every pull request.

## Run it yourself

Requires Node.js 22.13 or newer.

```bash
npm install
cp .env.example .env   # fill in your keys (below)
npm run seed           # 5 months of demo history into data/budget-guardian.db
npm run build          # builds the dashboard
npm start              # http://localhost:3000
```

What `.env` needs (all values come from free sandbox or developer accounts):

| Setting | Where to get it |
|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | A sandbox app at developer.paypal.com. Use a **US** sandbox Business account so payments work in USD. |
| `SAVINGS_RECEIVER_EMAIL` | A US sandbox **Personal** account that receives the savings. |
| `AI_API_KEY` (optional) | console.groq.com. Any OpenAI-compatible API works with `AI_BASE_URL`. |
| `GEMINI_API_KEY` (optional) | aistudio.google.com. Used as the fallback, or on its own. |
| `PLAID_CLIENT_ID`, `PLAID_SECRET` (optional) | dashboard.plaid.com → Developers → Keys (Sandbox). |

Without any AI key the app still works, with code-written explanations and a rules-based planner. `.env.example` lists every option. To deploy, create a Render Blueprint from this repo and enter the same keys.

**Demo helpers**
- `npm run demo-purchase -- --to <merchant sandbox email> --amount 48.20 --what "Fuel purchase"` makes a PayPal sandbox purchase. PayPal reports it within about 3 hours.
- `npm run plaid-purchase -- --amount 89.40 --what "METRO FUEL 57444"` makes a card purchase on a connected Plaid sandbox account. It arrives in seconds.
- `npm run reset-demo` clears approvals, uploads and visitors' demo copies.

Other commands:
- `npm run spikes`, `npm run advice` and `npm run categorize` print each step from the command line.
- `npm run dev:client` runs the dashboard with live reload (alongside `npm start`).

## License

[MIT](LICENSE)
