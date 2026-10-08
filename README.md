# The Slush Bar: QR ordering, billing, Lucky Draw & admin

QR table ordering with Razorpay UPI, a live kitchen board, the ₹2,000 Lucky Draw and a separate
Admin Panel for **The Slush Bar**, Shop No. 140, Sector-6 Market, Bahadurgarh.

The design is in [`docs/`](docs/) (Phases 1–9, all approved). Start with
[`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md).

## Status

| Milestone | State |
|---|---|
| **M1–M6: all milestones** | Code complete and tested locally; runs fully in **demo mode** (below). Going live needs the Owner's Supabase/Razorpay/Cloudflare accounts: see [docs/GO-LIVE.md](docs/GO-LIVE.md) |

## Layout

```
apps/admin        Staff & owner app (React + Vite)        → admin.<domain>
apps/customer     Customer QR ordering app                → order.<domain>   (M3)
apps/site         Marketing site (Astro, static)          → <domain>
packages/core     Shared rules: money, mobile, PIN, hours, settings, error codes
packages/ui       Poster-themed design system (design tokens, buttons, fields, PIN pad)
supabase/         Database migrations, seed, Edge Function API, database tests
docs/             Design phases 1–9 + implementation notes
```

## Try it now (demo mode, no accounts needed)

```bash
npm install
npm run dev -w apps/customer   # customer ordering: http://localhost:5174/t/table-04
npm run dev -w apps/admin      # staff app: http://localhost:5173
npm run dev -w apps/site       # marketing page: http://localhost:4321
```

- **Customer app:** a simulated payment sheet and a kitchen that moves the order along by itself.
- **Staff app:** pick Owner, Manager, Cashier or Kitchen. The **real database** (every migration and
  security rule) runs inside the browser, saved between visits. Use **+ Customer order** in the blue
  demo bar to create paid orders, then accept, make and refund them. **Reset demo** starts again.

Demo mode switches off automatically once a Supabase project is configured in `.env.local`, and
production builds contain none of the demo code.

## Running the checks

```bash
npm install
npm run typecheck
npm test
```

`npm test` runs the core unit tests and every database/API test against the **real migrations**
inside an in-process Postgres (PGlite), so no Docker is needed.

## Connecting a real backend

Follow [`docs/IMPLEMENTATION-NOTES.md`](docs/IMPLEMENTATION-NOTES.md) → "Setting up Supabase".
The Owner creates and owns every account (approved decision S1).
