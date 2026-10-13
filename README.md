# Budget Guardian

An AI agent that watches your PayPal spending, spots sudden spikes, explains which purchases caused them, and suggests realistic trade-offs with the exact amount saved. It never acts without your approval.

Built for the PayPal AI Hackathon. Work in progress.

## Run locally

Requires Node.js 22.13 or newer.

```bash
npm install
cp .env.example .env   # then fill in your PayPal sandbox Client ID and Secret
npm run seed           # 5 months of demo transactions into data/budget-guardian.db
npm start              # http://localhost:3000
```

Use US sandbox accounts (Business for the app, Personal for the buyer) so payments work in USD.

## License

MIT
