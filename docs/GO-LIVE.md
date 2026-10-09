# Going live

Everything below is done **once**, in order, by the developer with the Owner present for the
account steps. Nothing here needs a paid service. Design references: docs/PHASE-5-ARCHITECTURE.md,
docs/PHASE-8-SECURITY.md §4.

## 1. What runs where

| Piece | Where | Address |
|---|---|---|
| Marketing page (`apps/site`) | Cloudflare Pages project `slush-site` | `theslushbar.in` |
| Customer ordering (`apps/customer`) | Cloudflare Pages project `slush-order` | `order.theslushbar.in` |
| Staff app (`apps/admin`) | Cloudflare Pages project `slush-admin` | `admin.theslushbar.in` |
| API + database | Supabase project (Mumbai) | `/v1/*` on both apps, proxied by `_redirects` |
| Scheduled jobs | Supabase `pg_cron` → the Edge API | — |

Each app has its own `public/_headers` (security headers) and `_redirects` (SPA routing and the
`/v1/*` proxy). **Edit the `:project` placeholder in both `_redirects` files** to the real Supabase
project ref before the first deploy.

## 2. Build settings for each Cloudflare Pages project

| Setting | site | order | admin |
|---|---|---|---|
| Build command | `npm run build -w apps/site` | `npm run build -w apps/customer` | `npm run build -w apps/admin` |
| Output directory | `apps/site/dist` | `apps/customer/dist` | `apps/admin/dist` |
| Environment | `PUBLIC_ORDER_URL` | `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_DEMO=false` | same as order, plus `VITE_ORDER_URL` |

Setting `VITE_SUPABASE_URL` switches demo mode off; `VITE_DEMO=false` makes sure of it, and the
build then contains none of the demo code.

### Hosting on Vercel instead of Cloudflare Pages

Each app has a `vercel.json` (generated from its `public/_headers`, so the security policies are
identical: CSP, HSTS, no-referrer on order links, and so on). Vercel ignores `_headers` and
`_redirects`; those stay in the repo for the Cloudflare route.

Create **one Vercel project per app**, all from this repository, each with its **Root Directory**
set to the app's folder. Everything else (framework, install from the repo root, build command,
output folder, Node 24) is read from that app's `vercel.json` and `package.json`.

| Vercel project | Root Directory | Environment variables |
|---|---|---|
| `slush-bar-order` | `apps/customer` | none needed while it runs in demo mode; later `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` (both public), `VITE_DEMO=false` |
| `slush-bar-site` | `apps/site` | `PUBLIC_ORDER_URL` = the ordering app's URL, `SITE_URL` = this site's own URL |
| `slush-bar-admin` | `apps/admin` | none in the dashboard: demo-mode values live in `apps/admin/vercel.json` (`build.env`) |

Pushes to `main` redeploy automatically once the project is connected to the GitHub repository.

**Current deployments (demo mode, Vercel Hobby, no backend):**

| Project | Address | Root Directory |
|---|---|---|
| `site` (marketing page) | https://site-eight-amber-41.vercel.app | `apps/site` |
| `slush-bar-order` (ordering app) | https://slush-bar-order.vercel.app | `apps/customer` |

Both build from `main`, so every push to `main` redeploys them. `site` has two variables set in
the Vercel dashboard, `PUBLIC_ORDER_URL` and `SITE_URL`; the ordering app needs none while it
runs in demo mode (simulated payments, nothing leaves the browser).

**Search engines are told to ignore both public sites for now.** While the ordering app is a demo
with simulated payments, the marketing page and the ordering app send `X-Robots-Tag: noindex,
nofollow` (in their `vercel.json`), so Google doesn't send real customers to a shop that can't
take their order yet. **Remove that header from both files at launch**, or the shop will never
appear in search results. The Cloudflare `_headers` files don't carry it.

**The staff app is a protected demo, deliberately not on a public address.** Vercel's free plan
only puts a login in front of *preview* deployments; a project's main `*.vercel.app` production
address stays public (checked from a signed-out browser). The admin demo has a role picker and no
sign-in, so it must never be served from there. `apps/admin/vercel.json` therefore:

- turns off deployments for `main` (`git.deploymentEnabled`), so a push to `main` can never
  publish it;
- builds only the `admin-demo` branch (`ignoreCommand` on `VERCEL_GIT_COMMIT_REF`; any other
  branch, or an unset value, skips the build);
- sets `VITE_DEMO=true` and `VITE_ORDER_URL` in `build.env` (public values);
- allows `'wasm-unsafe-eval'` in its Vercel CSP only, because the demo's in-browser Postgres
  (PGlite) is WebAssembly. It does not allow `eval()`, and the Cloudflare `_headers` stay strict.

The demo lives at `https://slush-bar-admin-git-admin-demo-energeticclutches-projects.vercel.app`
and only a signed-in member of the Vercel team can open it. Everyone else is redirected to
Vercel's login. The demo database exists only in each visitor's own browser; it holds no real
data. To refresh it after `main` moves:

```bash
git push origin main:admin-demo
```

**When the admin goes live on Supabase,** remove `git`, `ignoreCommand`, `build.env` and
`'wasm-unsafe-eval'` from `apps/admin/vercel.json`, deploy it from `main`, and give it a real
protection plan (the free plan cannot protect a production address).

**The `/v1/*` API proxy is deliberately not in the Vercel config yet.** On Cloudflare it forwards
to the Supabase Edge Function, and there is no Supabase project to point at. When there is, add
this to `apps/customer/vercel.json` (and the admin's), *before* the catch-all rewrite:

```json
{ "source": "/v1/(.*)", "destination": "https://<project-ref>.supabase.co/functions/v1/api/v1/$1" }
```

**Plan limits:** Vercel's free Hobby plan is for personal, non-commercial use. A shop's ordering
site is commercial, so a live shop belongs on a paid plan, or on Cloudflare Pages, whose free
plan allows commercial use.

## 3. Database and API

Follow "Setting up Supabase" in [IMPLEMENTATION-NOTES.md](IMPLEMENTATION-NOTES.md), then:

```bash
npx supabase db push                     # every migration
npx supabase functions deploy api --no-verify-jwt
npx supabase secrets set PIN_JWT_PRIVATE_JWK='…' RAZORPAY_KEY_ID='…' RAZORPAY_KEY_SECRET='…' \
  RAZORPAY_WEBHOOK_SECRET='…' IDENTITY_PEPPER="$(openssl rand -hex 32)" JOB_SECRET="$(openssl rand -hex 32)" \
  TURNSTILE_SECRET='…'
```

In Razorpay → Settings → Webhooks, add `https://<project>.supabase.co/functions/v1/api/v1/webhooks/razorpay`
with the same webhook secret and these events: `payment.captured`, `payment.failed`, `order.paid`,
`refund.processed`, `refund.failed`, `payment.dispute.created`, `payment.dispute.won`,
`payment.dispute.lost`, `payment.dispute.closed`.

## 4. Scheduled jobs

Run once in the Supabase SQL editor (replace the URL and secret):

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Helper so the secret is written once.
create or replace function app.call_job(p_path text) returns void
language sql security definer set search_path = '' as $$
  select net.http_post(
    url := 'https://<project>.supabase.co/functions/v1/api/v1/jobs/' || p_path,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-job-secret', '<JOB_SECRET>'),
    body := '{}'::jsonb) is not null
$$;

select cron.schedule('slush-expire-payments', '*/5 * * * *', $$select app.call_job('expire-payments')$$);
select cron.schedule('slush-reconcile',       '*/10 * * * *', $$select app.call_job('reconcile?window=2h')$$);
select cron.schedule('slush-reconcile-day',   '30 21 * * *',  $$select app.call_job('reconcile?window=day')$$);  -- 03:00 IST
select cron.schedule('slush-nightly',         '45 21 * * *',  $$select app.call_job('nightly')$$);               -- 03:15 IST
```

(pg_cron runs in UTC; 21:30 UTC = 03:00 IST.) What each one does:

| Job | What it does |
|---|---|
| `expire-payments` | Closes checkouts nobody paid for, releasing their coupon slots |
| `reconcile` | Asks Razorpay what it captured, repairs anything a missed webhook left behind, records the comparison on the Risk screen |
| `nightly` | Runs the pattern fraud rules, checks both tamper-evident histories, removes abandoned checkouts over 30 days old |

## 5. Test-mode run before switching to live keys

With Razorpay **test** keys, on staging, do each of these once and check the result on the staff app:

- [ ] Pay an order → it appears on the board with a pickup number
- [ ] Pay, then close the app before the webhook → "I've paid but it's stuck" completes it
- [ ] Pay twice for one order → the second payment is refunded automatically
- [ ] Pay a wrong amount (Razorpay dashboard) → the order is held and flagged
- [ ] Reject an order → the refund request appears; approve it as a different person → refunded
- [ ] Partial refund of one item → the payment shows "partly refunded"
- [ ] Open a dispute in the Razorpay test dashboard → the customer is frozen and the order held
- [ ] Lucky Draw: take one mobile past ₹2,000 → a numbered token appears; order again → no second token; refund that order → the spending drops and the token is flagged for review
- [ ] Coupons: use the last slot of a limited coupon from two phones at once → only one succeeds
- [ ] Delivery: a pin outside the radius is refused

## 6. Go-live security checklist (Phase 8 §4)

Automated — `npm test` must be green (they run in CI on every change):

- [x] Row-level security on **every** table, checked by a test that fails if a new table misses it
- [x] The anonymous role can't read any table or call any internal function
- [x] Every staff function refuses a caller with no session
- [x] Webhooks: bad signature rejected, replay ignored, amount mismatch held
- [x] Refunds: maker–checker, Owner limit, retry never pays twice
- [x] Hash chains verified after tampering attempts

By hand, before switching on live keys:

- [ ] 2FA on the Owner in the app **and** on Supabase, Cloudflare, Razorpay, GitHub and the domain registrar
- [ ] `_redirects` in both apps point at the real Supabase project
- [ ] Security headers: A grade on securityheaders.com for all three sites; no `unsafe-inline` for scripts
- [ ] No secrets in the repository (`git log -p | grep -i secret` and a scan of `.env*` files)
- [ ] Razorpay **live** keys set as Edge Function secrets; test keys removed
- [ ] Turnstile keys are the live ones; rate limits tried on checkout, find-order and PIN login
- [ ] Cloudflare: Bot Fight Mode on, WAF managed rules on, rate-limit rule on `/v1/checkout` and `/v1/auth/*`, DNSSEC on
- [ ] A backup has been restored successfully within the last 7 days (Supabase → Database → Backups)
- [ ] Privacy page reachable from checkout; the shop's email is filled in on it
- [ ] Every staff PIN set, shop devices paired, and the Owner knows how to revoke a lost device
- [ ] The table standees are printed with the **final** web address in the QR codes

## 7. If something goes wrong

| Problem | Do this |
|---|---|
| Orders aren't arriving | Risk screen → money check. If Razorpay shows payments we don't, the reconcile job repairs them within 10 minutes; press it manually with the job secret if needed |
| Payments are failing | Razorpay dashboard → is the account live and the webhook healthy? Customers see "please order at the counter" automatically |
| A device is lost | Admin → Devices → Revoke. Sessions on it stop instantly |
| Prices look wrong | Audit log shows every change with who and when; a price put back within a day is flagged on the Risk screen |
| Something looks tampered with | Risk screen → tamper check. If it says broken, take a backup copy of the database and call the developer before making changes |

## 8. Rolling back

Cloudflare Pages keeps every deployment: open the project → Deployments → "Rollback to this
version" (instant). Database migrations are forward-only; if one needs undoing, write a new
migration. The Edge Function can be redeployed from any git commit with
`npx supabase functions deploy api --no-verify-jwt`.
