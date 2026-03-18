# FlexFits Online

E-commerce storefront and admin dashboard for FlexFits.

## Features

- Product catalog with filters and category browsing
- Cart and checkout flow
- Admin order dispatch workflow
- Automatic inventory updates on dispatch
- Order email notifications (admin + customer)
- Supabase-backed data storage

## Local Development

Prerequisites:

- Node.js 18+

Install and run:

```bash
npm install
npm run dev
```

Build production bundle:

```bash
npm run build
```

## Environment Variables

Create `.env.local` with values for your setup:

```env
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
VITE_EMAIL_WEBHOOK_URL=...
VITE_EMAIL_WEBHOOK_SECRET=...
VITE_SITE_URL=http://localhost:3000
GEMINI_API_KEY=... # optional
```
