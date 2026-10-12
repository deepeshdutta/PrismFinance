# PrismFinance

Personal Wealth & Investment Intelligence Platform

**Mobile-first**, multi-user (starting with 5), privacy-centric net worth tracker with focused dashboards and charts.

## Vision
Centralized view of assets, liabilities, cash flow, and portfolio performance. Clean UI prioritizing key metrics and graphs over clutter.

## Stack
- Frontend: Vite + React + Tailwind CSS + Recharts
- Auth & Database: Supabase (to be provisioned)
- Hosting: Cloudflare Pages (`prismfinance.pages.dev`)

## Local Development
```bash
npm install
npm run dev
```

## Deployment
Connect this repo to Cloudflare Pages. Build command: `npm run build`, output: `dist`.

## Next Steps
1. Create Supabase project and add env vars.
2. Implement auth (email OTP / Cloudflare Access compatible).
3. Build schema for accounts, transactions, holdings, liabilities.
4. Develop dashboard cards and charts.
