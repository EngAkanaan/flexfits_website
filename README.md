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

## Reservation System Setup

The cart now uses a first-come, first-served reservation model with a 10-minute timer per cart line.

1. Open Supabase SQL Editor.
2. Run the full schema file from [database/schema.sql](database/schema.sql).
3. Verify reservation table exists: `stock_reservations`.
4. Verify SQL functions exist:
	- `reserve_product_stock_fcfs`
	- `release_stock_reservation`
	- `extend_stock_reservation`
	- `cleanup_expired_stock_reservations`
	- `commit_checkout_reservations`
5. Optional scheduler:
	- The schema includes a safe `pg_cron` setup block to run cleanup every minute.
	- If your Supabase tier blocks `pg_cron`, cleanup still works via app-triggered best-effort calls.

### Functional Behavior

- Add to cart reserves stock immediately.
- Each cart item has its own countdown timer.
- Expired items are auto-removed and released.
- Checkout commits only valid reservations.
- If an item just expired during checkout, the app attempts a one-time 2-minute extension.
