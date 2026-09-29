# FlexFits Online

Modern e-commerce storefront and admin dashboard for managing products, orders, inventory, and dispatch workflow.

## Features

- Product catalog with search and filters
- Cart and checkout with stock reservation
- Admin inventory and order management
- Dispatch approval with automatic stock updates
- Financial metrics dashboard
- Email notifications for admin and customers

## Tech Stack

- TypeScript
- React 19 + Vite
- Supabase (PostgreSQL)
- Tailwind CSS
- Vercel

## Installation

### Prerequisites

- Node.js 18+

## Usage

- Open the storefront to browse products and place orders.
- Open the admin panel to manage inventory, orders, and dispatch actions.

## Project Structure

```
database/        SQL schema and database functions
public/          Static assets
services/        Data access and external service integrations
App.tsx          Main application UI and flows
types.ts         Shared TypeScript models
```

## Notes

- The app supports local fallback storage when Supabase is unavailable.
- Production deployment is configured for Vercel.
