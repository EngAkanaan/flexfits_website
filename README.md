# FlexFits Online

React/Vite storefront and Supabase-backed admin dashboard for products, checkout, stock reservations, orders, theme content, and financial reporting.

## Features

- Product catalog with search and filters
- Cart and checkout with stock reservation
- Admin inventory and order management
- Dispatch approval with automatic stock updates
- Financial metrics dashboard
- Email notifications for admin and customers

## Project Structure

```
database/        SQL schema, migrations, and security scripts
api/             Vercel serverless functions (Gemini, order email)
public/          Static assets
services/        Data access and external service integrations
App.tsx          Main application UI and flows
types.ts         Shared TypeScript models
```

## Local setup

Requirements: Node.js 18+ and a Supabase project.

```bash
npm install
```

Copy `.env.example` to `.env.local` and replace its placeholders. Variables prefixed with `VITE_` are compiled into the browser bundle and must be treated as public. All other variables listed in `.env.example` are server-only and must be configured in Vercel for Production, Preview, and Development as appropriate.

Use `npm run dev:vercel` when testing Gemini or order-email functions locally. It loads `.env.local` before starting Vercel Dev so rotated server secrets are not left stale. `npm run dev` starts Vite only and does not emulate the `/api` serverless routes.

## Database deployment

For an existing database, apply migrations in numeric order through:

```text
database/migrations/024_security_remediation.sql
```

Migration 024:

- replaces the hardcoded admin check with `admin_users` membership;
- preserves the administrator UUID previously configured in migration 016 when that Auth user exists;
- restricts application and Storage writes to DB-backed administrators;
- protects guest order-item creation with the shopper's active stock reservation;
- removes public access to stock-reservation session tokens;
- grants only the RPC access needed by storefront checkout and admin operations.

To add another administrator, create the user in Supabase Authentication and run:

```sql
INSERT INTO public.admin_users (user_id)
VALUES ('AUTH-USER-UUID-HERE'::uuid)
ON CONFLICT (user_id) DO NOTHING;
```

Disable public user sign-ups in Supabase Auth unless the application deliberately adds a customer-account flow. After applying the migration, run `database/security/verify_security.sql` in the Supabase SQL Editor and confirm its problem queries return no rows and `configured_admin_count` is at least one.

`database/security/rollback_security_remediation.sql` is emergency-only. It deliberately restores weaker authenticated-user and reservation-read behavior; read its warnings before use.

## Deployment environment

Browser-visible:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY` — set this to the project's public `sb_publishable_...` key; RLS remains the authorization boundary
- `VITE_SITE_URL`

Server-only:

- `GEMINI_API_KEY`
- `EMAIL_WEBHOOK_URL`
- `EMAIL_WEBHOOK_SECRET`
- `ORDER_NOTIFICATION_EMAIL`
- `SITE_URL`
- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY` — the server-only `sb_secret_...` key

Never prefix a private value with `VITE_`. The Supabase secret key bypasses RLS and must exist only in the serverless environment. The email function temporarily accepts the legacy `SUPABASE_SERVICE_ROLE_KEY` name as a migration fallback, but new deployments should use `SUPABASE_SECRET_KEY`.

The order email endpoint is not a generic relay: it loads order data using the server-only Supabase credential, derives the recipient/content server-side, and requires either the checkout session token for initial notifications or an authenticated `admin_users` member for status notifications.

## Security headers

`vercel.json` applies CSP, clickjacking protection, MIME sniffing protection, HSTS, a restrictive referrer policy, and a permissions policy. The CSP keeps `style-src 'unsafe-inline'` because the existing React UI uses inline style attributes and the Tailwind CDN injects styles. Script execution does not allow `unsafe-inline` or `unsafe-eval`.

Product and theme images may use externally hosted HTTPS URLs, so `img-src` permits HTTPS. Narrow that directive to exact image domains when the catalog no longer accepts arbitrary external image URLs.

## Required secret rotation

Before production deployment:

1. Rotate the Gemini API key previously injected by Vite; assume it was public.
2. Rotate the old email webhook secret and remove `VITE_EMAIL_WEBHOOK_URL` and `VITE_EMAIL_WEBHOOK_SECRET` from every Vercel environment.
3. Change any real account password that reused the removed hardcoded fallback passwords.
4. Replace any exposed legacy Supabase service-role JWT with a new `sb_secret_...` key, migrate the browser to an `sb_publishable_...` key, and deactivate the legacy keys after verification.
5. Redeploy after rotation, then inspect the generated bundle for the old values.

The Supabase anonymous key is intentionally public. Its safety depends on the RLS policies in migration 024; it must never be replaced with the service-role key in frontend configuration.

## Validation

```bash
npm exec tsc -- --noEmit
npm run build
```

There are currently no lint or automated-test scripts in `package.json`. After building, scan `dist` for server-only variable names, private key formats, removed fallback passwords, direct Google Gemini endpoints, and the email webhook host.
