# Implementation notes

A running log of implementation-level decisions. None of them changes a business rule. Where the
build differs from a design document, the reason is given here.

## Differences from the design documents

| Design said | Built | Why | Same guarantee? |
|---|---|---|---|
| Phase 4: staff `totp_secret_enc` column | Supabase Auth MFA stores the 2FA secret | It's already encrypted and managed by Supabase; storing it twice adds risk | Yes |
| Phase 4 R8: Argon2id PIN hash + keyed "fingerprint" for uniqueness | bcrypt (pgcrypto) PIN hash, checked inside Postgres; uniqueness checked by comparing against the branch's active PIN hashes | Keeps PIN checks inside the database with no extra secret to manage. A 4-digit PIN is protected by the device binding + 5-try lockout, not hash strength | Yes |
| Phase 8 §3.1: printed 2FA recovery codes | The owner is asked to add the authenticator to a **second phone** | Supabase Auth has no built-in recovery codes; a second enrolled device is Supabase's recommended recovery path | Yes |
| Phase 7 §1.1: API at `api.<domain>` | The admin app calls **same-origin `/v1/*`**, forwarded to the Edge Function (Vite proxy in dev, a Cloudflare route in production) | Keeps the shop-device cookie first-party (`__Host-`, `SameSite=Strict`). The customer app can still use `api.<domain>` | Yes (stronger for cookies) |
| Phase 5: PIN sessions "issue the same kind of signed session" | The `api` Edge Function signs ES256 tokens with a key that is **imported as the project's JWT signing key** | Supabase's supported way to mint custom tokens; no legacy shared secret | Yes |
| Phase 7 O1: menu published as a JSON file on R2 | `GET /v1/menu` builds the snapshot from the database, with an ETag and a 30-second shared cache (`s-maxage=30`); Cloudflare caches it at the edge | No second copy to fall out of date and no R2 write step on every edit. Sold-out changes show within 30 s | Yes |
| Phase 5: menu images on R2 | Images go to the Supabase Storage bucket `menu` (public read; staff-only write; resized to WebP in the browser before upload) | One less account and key for the owner to manage. Easy to move to R2 later if bandwidth grows | Yes |
| Phase 6 C11: live tracker over Realtime | Realtime broadcast, **plus a 20-second status check** as a backup | Phones on patchy signal miss socket messages; the check guarantees the tracker catches up | Yes (more reliable) |
| Phase 7 §5: `POST /v1/admin/refunds` (Edge) to request a refund | `public.request_refund` database function (RPC); only **approve/retry** go through the Edge API (`/v1/admin/refunds/:id/decide`, `/retry`), because only they need the Razorpay secret | Fewer moving parts; the amount is still worked out by the database, never the browser | Yes |
| Phase 7 §5: print endpoints `GET /v1/admin/orders/{id}/print` and `receipt.pdf` | Receipts and kitchen tickets are built in the admin app from the frozen receipt and printed from a hidden 80 mm page; customers get a receipt page with **Print / Save as PDF** (`GET /v1/orders/:token/receipt` returns the receipt data) | No PDF library on the server or on phones; the browser's print does the job on every device | Yes |
| Phase 4 §2.9: receipt timing not stated | A receipt number is issued when the shop **accepts** the order (numbers never skip: rejected orders never get one) | Matches "one receipt per sale" and keeps the sequence gap-free | n/a |
| Phase 8 S3: 5-minute idle lock on shop devices | Applies to the counter screens. The **kitchen screen is exempt** (it only signs out when its 12-hour PIN session ends) | A quiet kitchen must keep seeing new orders; the kitchen view shows no prices or phone numbers | Yes, for what it shows |
| Phase 2 §2.4: rejected order → refund request for a Manager | The request is created by the system (not the cashier who rejected), so **any** Manager/Owner can approve it, including one who rejected it | The money can only go back to the original payer, so there's nothing for a colluding staff member to gain; avoids a customer waiting when only one manager is on shift | Yes |
| (unspecified) loyalty spend when an order is partly refunded before completion | Counted = eligible spend minus money already refunded on that order | Simple and never over-credits | n/a |
| Phase 7 §2.2 menu promotions | Happy hours are added to `GET /v1/menu` (and to its ETag), so the cart shows them before checkout. Coupons are never in the menu | Nothing private in the public menu | Yes |
| Phase 7 §5: `GET /v1/admin/reports/{name}.csv` | Reports are read as JSON by the staff app, which writes the CSV in the browser (with a byte-order mark so Excel shows ₹ and Indian names correctly) | No second code path for the same numbers; downloads work offline from an open page | Yes |
| Phase 4 O4: `daily_sales_rollup` table | Reports query the orders directly, with indexes on `(branch_id, paid_at)` | At ~300 orders a day a year of data is well under a second; a rollup can be added later without changing the screens | Yes |
| Phase 4 §10: pattern rules "every 10 minutes" | They run in the 10-minute reconciliation job **and** again in the nightly job | Same beat as specified, plus a daily catch-up if the 10-minute job was down | Yes |
| Phase 6 A12: "Block identity" | Blocking is done **from a flagged order** (mobile, UPI id or phone), never by typing a number in | The raw value is never entered or stored: the block is a hash taken from the order | Yes (stronger) |
| **Owner change, 22 Sep 2026: the whole token scheme** | Redeemable reward tokens were replaced by the **Lucky Draw**: cumulative loyalty spend per mobile (excluding GST), one numbered token (`SLB-001`…`SLB-500`) at ₹2,000, never spendable. See docs/REQUIREMENTS.md → "Lucky Draw tokens" | The owner's instruction. It removes redemption, expiry, token debt, the approval queue and the counter mobile-check entirely: far less to get wrong, and nothing the shop has to hand over | Replaced, not weakened |
| (new) Lucky Draw: what stops two orders taking one number | The campaign row is **locked** before a number is taken, and `(campaign, customer)` is **unique** | Two simultaneous payments can't duplicate a customer's token or push the campaign past 500 | Yes |
| (new) Lucky Draw: a refund after the token was issued | The spend comes back out, but the token is **not** cancelled automatically — it is flagged (`TOKEN_AFTER_REFUND`) and a manager can void it by hand, which retires that number for good | The rules promise the entry is permanent; taking it back silently would break that, but the shop still has a lever against the refund trick | n/a |
| (new) | **Automated go-live checks** in the test suite: row-level security on every table, the anonymous role locked out of every table and internal function, and every staff function refusing a caller with no session | A new table or function that forgets its rules fails CI instead of reaching production | n/a |
| (new) | **Demo mode** for the admin app: the real migrations run in the browser (PGlite, saved in IndexedDB) and the real Edge API runs in-process with a fake Razorpay; a role picker replaces sign-in | Lets the owner try every staff screen before accounts exist; it's a build-time switch, so production builds contain none of it (no WebAssembly, no `eval`) | n/a |
| (new) | **Demo mode** for the customer app (`VITE_DEMO=true`, or no Supabase URL): a local copy of the menu, the real pricing engine, a simulated payment sheet and a simulated kitchen | Lets the owner try the full ordering flow before any accounts exist. The demo code is a separate chunk and is never loaded on the live site | n/a |

## How staff sessions work
- **Owner / Manager** sign in with Supabase Auth (email + password, plus 2FA, which is required for the Owner). A database hook (`custom_access_token_hook`) adds `staff_id`, `branch_id` and `staff_role` to their token.
- **Cashier / Kitchen** tap their name on a paired device and enter a PIN. The `api` function checks it (`app.pin_login`), records a `staff_sessions` row and returns a 12-hour token.
- **Every database request re-checks the token against the tables** (`app.current_staff()`): active staff, current role, live session and device, and for the Owner a completed 2FA. Deactivating someone or revoking a device takes effect on their very next click.

## Testing without Docker
`supabase/tests/harness.ts` runs every migration inside PGlite, with a small shim for Supabase's roles and `auth` schema. Row-level security, grants, triggers and functions are all tested for real.
- **Limitation:** PGlite is a single connection, so true concurrency races (Phase 9 §3.7) will be tested against the staging database.

## Setting up Supabase (Owner does steps 1–3; developer does 4–8)
1. Create a Supabase account in the Owner's name, with 2FA. Create a project named **slush-bar-staging** in region **Mumbai (ap-south-1)**. Later, create a second project for production.
2. Create a GitHub account/organisation for the Owner, with 2FA, and invite the developer.
3. Create Cloudflare and Razorpay accounts (Razorpay **test mode** only for now), with 2FA.
4. Generate a signing key with `npx supabase gen signing-key --algorithm ES256`. Import it under Auth → JWT Signing Keys and rotate it into use. Store the same private JWK (with its `kid`) as the Edge Function secret `PIN_JWT_PRIVATE_JWK`.
5. Link the project and apply the database: `npx supabase link`, then `npx supabase db push`. Run `supabase/seed/seed.sql` once.
6. Enable the hook: Auth → Hooks → Custom Access Token → `public.custom_access_token_hook`.
7. Turn on Auth → MFA (TOTP). Turn off public sign-ups; staff are invited only.
8. Create the Owner: invite the Owner's email from the Supabase dashboard, then run `select app.bootstrap_owner('<auth user id>', '<name>', '<email>', (select id from public.branches where slug = 'bahadurgarh-s6'));`.
9. Deploy the API with `npx supabase functions deploy api --no-verify-jwt`. The function does its own auth: PIN login has no JWT yet. Then copy `apps/admin/.env.example` to `.env.local`.

## Trying it locally (demo mode)
`npm run dev -w apps/customer`, then open `http://localhost:5174/t/table-04` (a table QR), `/t/counter` (counter QR) or `/t/disabled` (a switched-off QR). With `VITE_DEMO=true` (the default in `.env.example`), orders are "paid" with a simulated button and move through the kitchen steps by themselves over about 90 seconds.
- Staff app: `npm run dev -w apps/admin`, open `http://localhost:5173`, pick a role. The blue demo bar has **+ Customer order** (a pretend customer orders and pays through the real checkout API), **+ Regular customer (earns a Lucky Draw number)** (a few completed orders on one mobile, so the spending crosses ₹2,000 and a number appears under Lucky Draw) and **Reset demo**. The demo shop has offers switched on, coupon **SLUSH10** and a 3–6 PM happy hour.
- Customer site demo: mobile **98765 43210** starts with ₹1,750 of loyalty spend, so one order earns the Lucky Draw token; coupon **SLUSH10** (10% off orders over ₹200). Open `/menu` without a QR code to try **delivery** with the map pin. Refunds are "confirmed by Razorpay" 4 seconds after approval.
- Customer bundle: 88.5 KB gzipped JavaScript (target ≤150 KB). `@slush/core` is marked `sideEffects: false` so the settings validator (zod) stays out of the customer bundle.

## Reports and figures
- "Sales" counts orders that were **paid and not rejected, cancelled or expired**. Refunds are shown separately and subtracted in "Net".
- The Lucky Draw has no money value on the books: the tokens are draw entries, not credit, so there is no liability figure. The Reports tab shows how many of the 500 numbers have gone and how far customers have got.
- All times are Indian Standard Time; a "day" runs midnight to midnight IST.

## Open items carried forward
- Set `VITE_ORDER_URL` (admin) to the final customer web address **before printing QR standees** (the address is inside every QR code).
- Code-split the admin app by page (currently ~205 KB gzipped; it's a staff tool on shop Wi-Fi, so this is housekeeping, not a blocker).
- Replace the placeholder logo in `packages/ui/src/Logo.tsx` with the traced poster logo (waiting on the original file).
- Pin GitHub Actions to commit SHAs.
