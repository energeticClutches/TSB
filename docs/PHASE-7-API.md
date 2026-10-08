# The Slush Bar — Phase 7: API Specification

**Status:** ✅ Approved by owner 2026-09-21 · **Date:** 2026-09-21 · Builds on Phases [1](PHASE-1-REQUIREMENTS.md)–[6](PHASE-6-UI-UX.md)

> **Amended 2026-09-22 — the token scheme changed.** On the owner's instruction, redeemable reward
> tokens were replaced by the **Lucky Draw**: a mobile number's spending (excluding GST) adds up across
> every order, and at ₹2,000 it earns **one** numbered token (`SLB-001`…`SLB-500`) that is a draw entry,
> never spent. Anything below about earning, approving, redeeming, expiring or owing tokens is
> **superseded** by “Lucky Draw tokens” in [REQUIREMENTS.md](REQUIREMENTS.md); the rest of this
> document still stands. What was actually built is in
> [IMPLEMENTATION-NOTES.md](IMPLEMENTATION-NOTES.md).


> This is a **contract**, not code: it defines what each endpoint accepts, returns, who may call it, and how it fails. Implementation follows the approved architecture (Phase 5).

---

## 1. Conventions

### 1.1 Three kinds of API
| Kind | Base URL | Used by | Why |
|---|---|---|---|
| **Public Edge API** | `https://api.<domain>/v1/…` (Supabase Edge Functions behind our domain) | Customer app, Razorpay, scheduled jobs | Customers never touch the database directly |
| **Staff Edge API** | `https://api.<domain>/v1/admin/…` | Admin app | Anything that needs a secret or an outside service (Razorpay refunds, PIN hashing, uploads, PDFs, menu publishing) |
| **Staff database functions (RPC)** | `https://<project>.supabase.co/rest/v1/rpc/<name>` and read-only views | Admin app | Order steps, tokens, menu edits: enforced **inside Postgres** with row locks, role checks (RLS) and automatic audit |
| **Static files** | `https://cdn.<domain>/…` (Cloudflare R2) | Customer app | Menu file and images, never touches the database |

### 1.2 Formats
- JSON, UTF-8. **Money is always integer paise** (`14900` = ₹149). Times are ISO-8601 UTC (`2026-09-21T08:44:00Z`); the apps display IST.
- IDs are UUIDv7 strings. **Customers never see internal IDs**; they only get `public_token`, order number and pickup number.
- Mobile numbers are sent as 10 digits (`9812345678`) and stored as `+91…`. Responses to customers **mask** them (`98xxxxx678`).

### 1.3 Authentication
| Scheme | How it's sent | For |
|---|---|---|
| `none + bot-check` | `cf-turnstile-response` in the body | Checkout, find-order, quote |
| `order-token` | `public_token` in the path (≥ 32 random characters) | Tracker, cancel, receipt |
| `staff-session` | `Authorization: Bearer <JWT>` (Supabase session; 12 h for PIN logins, 7 days for Owner/Manager with refresh) | All staff APIs; the token carries `staff_id`, `branch_id`, `role`, `device_id` |
| `device-cookie` | `__Host-sb_device` HttpOnly, Secure, SameSite=Strict cookie on `admin.<domain>` | Needed **together with** the PIN for PIN logins |
| `razorpay-signature` | `X-Razorpay-Signature` (HMAC-SHA256 of the raw body with the webhook secret) | Webhooks |
| `job-secret` | `X-Job-Secret` header (random secret, only in pg_cron and the server) | Scheduled job endpoints |

### 1.4 Idempotency (safe to repeat)
- `POST /v1/checkout` **requires** an `Idempotency-Key` header: a UUID the app creates once per checkout attempt. The same key with the same body returns the **same** result; the same key with a *different* body returns `409 IDEMPOTENCY_CONFLICT`.
- Every staff state change sends the row's `version`. A stale version returns `409 VERSION_CONFLICT`, and the app refreshes the card.

### 1.5 Error envelope (every error, every API)
```json
{
  "error": {
    "code": "PRICE_CHANGED",
    "message": "Some items changed since you added them.",
    "details": { "changes": [ { "line_id": "l1", "type": "price", "old_paise": 13900, "new_paise": 14900 } ] },
    "request_id": "req_01J9…"
  }
}
```
- `message` is safe to show to a customer. `request_id` also appears in the server logs and Sentry.
- **Fraud and block reasons are never revealed** to customers. They get a generic `ORDER_NOT_ALLOWED`, and the real rule is written to `fraud_flags`.

### 1.6 Error codes
| HTTP | Code | When |
|---|---|---|
| 400 | `BAD_REQUEST` | Malformed JSON |
| 400 | `SIGNATURE_INVALID` | Webhook signature failed |
| 401 | `UNAUTHENTICATED` | Missing/expired session |
| 403 | `FORBIDDEN` | Role not allowed |
| 403 | `BOT_CHECK_FAILED` | Turnstile failed |
| 403 | `ORDER_NOT_ALLOWED` | Blocked identity / frozen for this action (generic) |
| 403 | `DEVICE_NOT_REGISTERED` | PIN login from an unknown device |
| 404 | `NOT_FOUND` | Unknown token/slug (also used instead of 403 where existence shouldn't be revealed) |
| 409 | `SHOP_CLOSED` | Outside ordering hours |
| 409 | `PRICE_CHANGED` / `ITEM_UNAVAILABLE` | With a `changes[]` diff |
| 409 | `COUPON_EXHAUSTED` · `TOKENS_UNAVAILABLE` | Race lost |
| 409 | `IDEMPOTENCY_CONFLICT` · `VERSION_CONFLICT` · `INVALID_TRANSITION` | |
| 409 | `ORDER_ON_HOLD` | Staff tried to accept a held order |
| 410 | `QR_DISABLED` | |
| 422 | `VALIDATION_FAILED` | `details.fields{name: reason}` |
| 422 | `COUPON_INVALID` · `BELOW_MINIMUM` · `OUT_OF_DELIVERY_AREA` · `TOO_MANY_TOKENS` | |
| 423 | `ACCOUNT_LOCKED` | 5 wrong PINs (`details.until`) |
| 202 | `NEEDS_OWNER_APPROVAL` | Not an error: the request became an approval request (`details.approval_id`) |
| 429 | `RATE_LIMITED` | With a `Retry-After` header |
| 503 | `PAYMENTS_UNAVAILABLE` | Razorpay unreachable |
| 500 | `INTERNAL` | Anything else, always with `request_id` |

### 1.7 Rate limits (defaults, editable in settings)
| Endpoint | Limit |
|---|---|
| `POST /checkout` | 5 / 10 min per device, 20 / 10 min per IP |
| `POST /cart/quote` | 60 / 10 min per device |
| Coupon attempts (inside quote/checkout) | 10 / 10 min per device + IP |
| `POST /orders/find` | 5 / 15 min per IP, then Turnstile is required |
| `POST /auth/pin-login` | 5 wrong per staff → 15 min lock; 30 / 10 min per device |
| Staff APIs | 300 / min per session |

### 1.8 Pagination
Lists use a cursor: `?limit=50&cursor=<opaque>` → `{ "items": [...], "next_cursor": "…" | null }`.

---

## 2. Public API (customer app)

### 2.1 `GET cdn/menu/{branch_slug}/latest.json`: menu pointer
**Auth:** none · **Cache:** 30 s
```json
{ "version": 57, "url": "https://cdn.<domain>/menu/bahadurgarh-s6/v57.json", "generated_at": "…" }
```

### 2.2 `GET cdn/menu/{branch_slug}/v{n}.json`: full menu (immutable, cached forever)
```json
{
  "version": 57,
  "branch": { "name": "The Slush Bar", "hours": [{ "weekday": 0, "opens": "11:00", "closes": "23:00" }], "last_order_buffer_min": 15, "delivery_enabled": false },
  "categories": [ { "id": "c1", "name": "Slushes", "sort": 1, "windows": [] } ],
  "products": [ {
    "id": "p1", "category_id": "c1", "kind": "item", "name": "Strawberry Splash",
    "description": "Hill strawberries, crushed ice, fresh lime", "image": "https://cdn…/p1-800.webp",
    "accent": "#FF1744", "featured": true, "sold_out": false, "prep_minutes": 4, "windows": [],
    "variants": [ { "id": "v1", "name": "Regular 350 ml", "price_paise": 14900, "default": true },
                  { "id": "v2", "name": "Mega 500 ml", "price_paise": 18900 } ],
    "modifier_groups": [ { "id": "g1", "name": "Ice level", "kind": "free_option", "min": 1, "max": 1,
                           "options": [ { "id": "o1", "name": "Light", "price_paise": 0 }, … ] } ]
  } ],
  "promotions": [ { "kind": "happy_hour", "label": "20% off slushes", "days_mask": 127, "start": "15:00", "end": "18:00", "targets": { "category_ids": ["c1"] } } ]
}
```
Contains **no** coupon codes, costs, stock levels or anything private. Prices are for display; the server re-prices at checkout.

### 2.3 `GET /v1/qr/{slug}`: resolve a scanned QR
**Auth:** none · **Rate:** 60/min per IP
**200:**
```json
{ "branch_slug": "bahadurgarh-s6", "kind": "table", "table_label": "04", "ordering_open": true, "opens_at": null, "menu_version": 57 }
```
**Errors:** `404 NOT_FOUND`, `410 QR_DISABLED`.

### 2.4 `POST /v1/cart/quote`: authoritative price preview
**Auth:** none (Turnstile optional; required after 20 quotes) · Used when opening the cart/checkout, applying a coupon, entering a mobile (to show tokens), or picking a delivery pin.
**Request:**
```json
{
  "qr_slug": "k7Qm2x",
  "order_type": "dine_in",
  "lines": [ { "line_id": "l1", "product_id": "p1", "variant_id": "v2", "qty": 2,
               "option_ids": ["o1", "o7"], "note": "no straw" } ],
  "coupon_code": "SLUSH10",
  "mobile": "9812345678",
  "tokens_to_use": 1,
  "token_item_line_id": "l3",
  "delivery": { "lat": 28.6921, "lng": 76.9353 },
  "device_id": "d_8f…"
}
```
**200:**
```json
{
  "quote_hash": "qh_3c9…",
  "lines": [ { "line_id": "l1", "unit_price_paise": 21900, "promo_discount_paise": 0, "line_total_paise": 43800, "available": true } ],
  "subtotal_paise": 43800, "promo_discount_paise": 0, "order_discount_paise": 4380,
  "token_discount_paise": 0, "delivery_fee_paise": 0, "tax_paise": 0, "total_paise": 39420,
  "coupon": { "code": "SLUSH10", "status": "applied", "message": "10% off applied" },
  "tokens": { "available": 2, "max_per_order": 2, "redeemable_line_ids": ["l3"], "requires_counter_check": true },
  "delivery": null,
  "eta_minutes": 8,
  "changes": [],
  "ordering_open": true
}
```
- `tokens.available` is shown **only as a count**, never with a name. The quote is rate-limited so it can't be used to look people up.
- A coupon problem doesn't fail the quote: `coupon.status` = `invalid | expired | min_not_met | exhausted` with a message.
- Delivery: `{ "in_area": true, "distance_m": 2140, "fee_paise": 3000, "min_order_paise": 20000 }`.

### 2.5 `POST /v1/checkout`: create the order and the Razorpay payment
**Auth:** none + Turnstile · **Headers:** `Idempotency-Key` (required)
**Request:** same shape as the quote, plus:
```json
{
  "quote_hash": "qh_3c9…",
  "customer": { "name": "Aarav", "mobile": "9812345678" },
  "note": "Kids at table, paper straws",
  "delivery": { "lat": 28.69, "lng": 76.93, "address": "H-12, Sector 6", "landmark": "Near park" },
  "cf-turnstile-response": "…"
}
```
**Server steps:** bot check → rate limits → blocked list → shop open → re-price → compare with `quote_hash` → one DB transaction (order `awaiting_payment` + items + coupon lock + token reservation) → Razorpay order for the **server** total → save the payment row.
**201:**
```json
{
  "public_token": "ot_Zk3…(32+ chars)",
  "total_paise": 39420,
  "payment_expires_at": "2026-09-21T09:14:00Z",
  "razorpay": { "key_id": "rzp_live_…", "order_id": "order_N3…", "amount": 39420, "currency": "INR",
                "name": "The Slush Bar", "prefill": { "contact": "+919812345678", "name": "Aarav" },
                "method": "upi" }
}
```
- **If tokens cover everything (total 0):** `201` with `"razorpay": null`, and the order goes straight to `pending` with a counter mobile check.
- **Errors:** `409 PRICE_CHANGED`/`ITEM_UNAVAILABLE` (with a diff, nothing created) · `409 SHOP_CLOSED` · `409 COUPON_EXHAUSTED` · `409 TOKENS_UNAVAILABLE` · `422 VALIDATION_FAILED` · `422 OUT_OF_DELIVERY_AREA` · `422 BELOW_MINIMUM` · `403 BOT_CHECK_FAILED` · `403 ORDER_NOT_ALLOWED` · `429` · `503 PAYMENTS_UNAVAILABLE` (the order transaction is rolled back).

### 2.6 `POST /v1/orders/{public_token}/payment-check`: "Did my payment go through?"
**Auth:** order-token · Called by the app after Razorpay's handler returns, and by the "I've paid but it's stuck" button.
**Request (optional):** `{ "razorpay_payment_id": "pay_…", "razorpay_signature": "…" }`
**Server:** verifies the checkout signature **and** fetches the payment from the Razorpay API. It never marks an order paid from the browser's word alone, and runs the same "mark paid" function as the webhook (idempotent).
**200:** `{ "payment_status": "successful" | "pending" | "failed", "order_status": "pending", "order_number": "SL-1025", "pickup_number": 42 }`
**Rate:** 1 per 3 s per token.

### 2.7 `GET /v1/orders/{public_token}`: tracker data
**Auth:** order-token
**200:**
```json
{
  "order_number": "SL-1025", "pickup_number": 42, "order_type": "dine_in", "table_label": "04",
  "status": "preparing", "payment_status": "successful", "total_paise": 39420,
  "customer": { "name": "Aarav", "mobile_masked": "98xxxxx678" },
  "items": [ { "name": "Strawberry Splash", "variant": "Mega 500 ml", "qty": 2, "options": ["Light ice", "+Boba"], "line_total_paise": 43800 } ],
  "timeline": [ { "status": "pending", "at": "…" }, { "status": "confirmed", "at": "…" }, { "status": "preparing", "at": "…" } ],
  "eta_minutes": 6,
  "can_cancel": false,
  "refund": null,
  "token_progress": { "progress_paise": 145000, "threshold_paise": 200000 },
  "realtime_channel": "order:ot_Zk3…"
}
```
`token_progress` appears only after completion. No internal IDs, no staff names.

### 2.8 `POST /v1/orders/{public_token}/cancel`
**Auth:** order-token · **Request:** `{ "reason": "Ordered by mistake" }`
**200:** `{ "status": "cancelled", "refund": { "status": "processing", "amount_paise": 39420 } }` (automatic full refund).
**Errors:** `409 INVALID_TRANSITION` ("The shop has already accepted your order. Please speak to the counter.").

### 2.9 `POST /v1/orders/find`
**Auth:** none + Turnstile (after 3 tries) · **Request:** `{ "mobile": "9812345678", "order_number": "SL-1025" }`
**200:** `{ "public_token": "ot_…" }` · **404** if there's no match. The same response and timing whether the mobile or the number is wrong, so nobody can probe which one exists.

### 2.10 `GET /v1/orders/{public_token}/receipt.pdf`
**Auth:** order-token · Only for paid orders · **200** `application/pdf` (generated from the frozen receipt snapshot).

### 2.11 `GET /v1/health`
**Auth:** none · **200** `{ "ok": true, "db": "ok", "razorpay": "ok" }` (used by UptimeRobot; reveals nothing else).

---

## 3. Razorpay webhook

### 3.1 `POST /v1/webhooks/razorpay`
**Auth:** `razorpay-signature` over the **raw** body.

**Processing order:**
1. Verify the signature (constant-time compare). If it fails: store the event with `signature_valid=false` and return `400`. Nothing is acted on.
2. Insert into `webhook_events` (unique `event_id`). If it's already processed, return `200` immediately.
3. Handle the event in **one database transaction**, set `processed_at`, return `200`.
4. If handling fails, return `500`: Razorpay retries (for up to 24 h), and the stored event is re-processed because `processed_at` is still empty.

| Event | Action |
|---|---|
| `payment.captured` / `order.paid` | Check the amount and currency against the payment row → mark paid → assign order number + pickup number → `pending` → store the payer's UPI ID (hashed + masked) → fraud rules → realtime to staff and customer. Late (after expiry) → revive + flag. A second capture on the same order → `DUPLICATE_PAYMENT` automatic refund |
| `payment.failed` | Payment `failed`; the order stays `awaiting_payment` until expiry (the customer can retry) |
| `refund.processed` | Refund `processed` → payment `refunded`/`partially_refunded` → token progress/token reversal → order `refunded` if full |
| `refund.failed` | Refund `failed` → flag on the dashboard |
| `payment.dispute.created` | Payment `disputed` → reverse tokens, freeze customer, `block` flag |
| `payment.dispute.won/lost/closed` | Update the dispute, flag for Owner review |
| Anything else | Stored and ignored |

---

## 4. Staff authentication

| Endpoint | Auth | Request → Response | Notes / errors |
|---|---|---|---|
| Supabase Auth `signInWithPassword` + `mfa.challenge/verify` | none | email, password (+ TOTP code) → session | Owner must have TOTP enrolled; Manager optional |
| `POST /v1/admin/devices` | staff-session (Owner) | `{ "name": "Counter tablet", "allowed_roles": ["cashier"] }` → `{ "device_id", "pairing_code": "483-221", "expires_in": 600 }` | Owner creates it on their phone |
| `POST /v1/auth/device/pair` | none (on the new device) | `{ "pairing_code": "483-221" }` → sets the `__Host-sb_device` cookie, `{ "device_name" }` | One-time code, 10 min, 5 tries |
| `GET /v1/auth/device/staff` | device-cookie | → `{ "staff": [ { "id", "name", "initial", "color", "role" } ] }` | Only staff allowed on this device |
| `POST /v1/auth/pin-login` | device-cookie | `{ "staff_id", "pin": "4821" }` → `{ "session": { "access_token", "expires_at" }, "role", "home": "/board" }` | `403 DEVICE_NOT_REGISTERED`, `401` wrong PIN (`details.attempts_left`), `423 ACCOUNT_LOCKED` |
| `POST /v1/auth/logout` | staff-session | → `204` | Revokes the session |
| `DELETE /v1/admin/devices/{id}` | Owner | → `204` | Revokes the device and all its sessions immediately |

---

## 5. Staff Edge API (needs a secret or an outside service)

| Endpoint | Roles | Request | Response | Errors / notes |
|---|---|---|---|---|
| `POST /v1/admin/refunds` | Cashier+ | `{ "order_id", "kind": "full"\|"partial", "items": [{ "order_item_id", "qty" }], "reason" }` | `201 { "refund_id", "amount_paise", "status": "requested", "needs": "manager"\|"owner" }` | Amount is calculated by the server; can't exceed the refundable remainder |
| `POST /v1/admin/refunds/{id}/decide` | Manager (≤ limit) / Owner | `{ "approve": true, "note" }` | `200 { "status": "processing", "provider_refund_id" }` | `403` if you requested it yourself; `202 NEEDS_OWNER_APPROVAL` above the limit; calls the Razorpay Refunds API with the refund id as its idempotency key |
| `POST /v1/admin/tokens/verify` | Cashier+ | `{ "code": "SLB-7KQ4-M9XD" }` or `{ "qr_payload": "…" }` | `200 { "valid": true, "status": "issued", "expires_at", "customer": { "name", "mobile_masked" } }` | Checks the QR signature; a forged QR gives `valid: false` + flag |
| `POST /v1/admin/uploads/image` | Manager+ | `{ "product_id", "content_type": "image/webp", "bytes": 48213 }` | `200 { "upload_url", "path", "expires_in": 300 }` | WebP/JPEG/PNG only, ≤ 1 MB (already resized in the browser); pre-signed R2 URL |
| `POST /v1/admin/menu/publish` | Manager+ (also automatic after edits) | `{}` | `200 { "version": 58 }` | Builds and uploads `v58.json` + pointer |
| `POST /v1/admin/staff` | Owner | `{ "name", "role", "email"? , "pin"? }` | `201 { "staff_id" }` | PIN rules: 4 digits, not weak, unique in the branch → `422` |
| `POST /v1/admin/staff/{id}/pin` | Owner (or self with old PIN) | `{ "pin", "old_pin"? }` | `204` | Audited |
| `GET /v1/admin/orders/{id}/receipt.pdf` | Cashier+ | — | `application/pdf` | |
| `GET /v1/admin/orders/{id}/print?type=receipt\|kot` | Cashier+ | — | `text/html` sized for 80 mm | Printed silently by the counter PC |
| `GET /v1/admin/reports/{name}.csv?from&to` | Manager+ | — | `text/csv` | `name` ∈ sales, products, categories, hours, payments, tokens, customers |

---

## 6. Staff database API (Postgres functions via RPC)

All run as the logged-in staff member. **Each one checks the role itself** (on top of RLS), locks the rows it changes, checks `version`, writes `order_status_events` / `token_ledger` / `audit_logs` in the same transaction, and raises the error codes from §1.6.

### 6.1 Orders
| Function | Roles | Arguments | Returns | Rules |
|---|---|---|---|---|
| `accept_order` | Cashier+ | `order_id, version, mobile_checked bool` | `{ status, version }` | `pending → confirmed`. `mobile_checked=true` is **required** if tokens are used. `409 ORDER_ON_HOLD` if held |
| `reject_order` | Cashier+ | `order_id, version, reason` | `{ status, refund_id }` | `pending → rejected`; creates a refund request for a Manager; releases tokens |
| `advance_order` | Cashier+ / Kitchen (preparing, ready only) | `order_id, version, to_status` | `{ status, version }` | Only the next allowed step (`order_transitions`) |
| `revert_order_status` | Manager+ | `order_id, version, to_status, reason` | `{ status }` | One step back, audited |
| `clear_order_hold` | Manager+ | `order_id, note` | `{ on_hold: false }` | Reviewer ≠ flagged staff |
| `reveal_customer_mobile` | Cashier+ | `order_id` | `{ mobile }` | Audited every time |
| `mark_sold_out` | Cashier+ | `product_id \| option_id, sold_out bool` | `{ menu_version }` | Triggers a menu publish |

**Read views (RLS-filtered):**
- `v_live_orders`: board cards (prices, masked mobile).
- `v_kitchen_orders`: items and notes only; **no price or mobile columns exist in this view**.
- `v_order_detail`, `v_order_history`: filters for date, status, type, payment, search.

### 6.2 Tokens & customers

*Superseded by the Lucky Draw — see the amendment note at the top of this document.*

| Function | Roles | Arguments | Returns / rules |
|---|---|---|---|
| `approve_token_issuance` | Cashier+ | `issuance_id` | `{ issued: [{ code, expires_at }], debt_settled }`. Recalculates from current progress; `FOR UPDATE` on the customer |
| `decline_token_issuance` | Cashier+ | `issuance_id, reason` | Progress kept |
| `adjust_tokens` | Manager+ | `customer_id, token_delta, progress_delta_paise, reason` | Over the daily cap → `202 NEEDS_OWNER_APPROVAL` |
| `freeze_customer` / `unfreeze_customer` | Manager+ | `customer_id, reason` | |
| `block_identity` | Manager+ | `kind, value (mobile/vpa/device from an order), scope, reason, expires_at?` | Stores the hash only |
| Views `v_customers`, `v_customer_detail`, `v_token_queue`, `v_token_ledger` | Cashier (lookup), Manager+ | | Mobiles masked |

### 6.3 Menu & offers (Manager+; each save bumps `menu_version` and publishes)
`upsert_category`, `archive_category`, `reorder_categories(ids[])`, `upsert_product(payload)`, `archive_product`, `reorder_products(category_id, ids[])`, `upsert_modifier_group(payload)`, `set_product_modifier_groups(product_id, group_ids[])`, `upsert_availability_windows(target, windows[])`, `upsert_coupon`, `upsert_promotion`, `set_offer_active`.
- `upsert_product` with a variant price drop > 50% → `202 NEEDS_OWNER_APPROVAL` (the change is stored as an approval request, not applied).
- `upsert_coupon` over 30% off or with no usage limit → `202 NEEDS_OWNER_APPROVAL`.
- First-order promotion activation → `409` while `first_order_offer_requires_otp` is on.

### 6.4 QR, settings, staff, risk (Owner unless noted)
| Function | Notes |
|---|---|
| `create_qr(kind, table_label?)` (Manager+) | Generates a random slug |
| `set_qr_active(qr_id, active)` (Manager+) | |
| `update_setting(key, value)` | Validated per key; audited (before → after) |
| `set_staff_role(staff_id, role)`, `deactivate_staff(staff_id)` | Revokes sessions |
| `decide_approval(approval_id, approve, note)` | Applies the stored change on approval; `decided_by ≠ requested_by` |
| `review_fraud_flag(flag_id, outcome, note)` | `cleared` / `confirmed` |
| Views `v_dashboard_today`, `v_fraud_flags`, `v_approvals`, `v_reconciliation`, `v_audit_log` (Owner), report functions `report_sales(from,to,grain)`, `report_products`, `report_categories`, `report_hours`, `report_payments`, `report_tokens`, `report_customers` (Manager+) | |

---

## 7. Realtime channels
| Channel | Who can join | Payload | Trigger |
|---|---|---|---|
| `branch:{branch_id}:orders` (private; checked by RLS) | Staff of that branch | `{ "order_id", "status", "version", "on_hold" }` (no customer data) | Any order status/hold change |
| `branch:{branch_id}:alerts` | Manager/Owner | `{ "kind": "refund_request"\|"token_approval"\|"fraud_flag"\|"approval", "count" }` | New item in a queue |
| `order:{public_token}` (broadcast) | Anyone holding the token | `{ "status", "eta_minutes", "pickup_number", "payment_status" }` | Order change |

Clients re-fetch the details over the API after a message. Messages are hints, never the source of truth.

---

## 8. Scheduled job endpoints
| Endpoint | Auth | Schedule | Action |
|---|---|---|---|
| `POST /v1/jobs/reconcile?window=2h` | job-secret | every 10 min | Fetch Razorpay payments for the window; fix or flag mismatches |
| `POST /v1/jobs/reconcile?window=day` | job-secret | 03:00 IST | Full previous day |
| `POST /v1/jobs/expire-payments` | pg_cron (SQL) | 5 min | Expire unpaid checkouts |
| `POST /v1/jobs/nightly` | pg_cron (SQL) | 03:15 IST | Token expiry, daily rollup, hash-chain check, housekeeping |

---

## 9. Versioning & change rules
- Breaking changes create `/v2/…`. `/v1` keeps working until both apps have shipped the update.
- The menu file carries `version`. Its schema changes are additive only.
- Every endpoint above gets automated contract tests (Phase 9).

---

## 10. Decisions (all approved 2026-09-21)
- **API-1** Three API kinds: **Edge API** (customers, Razorpay, secrets), **database functions** (staff actions, with rules inside Postgres), **static files** (menu/images).
- **API-2** API on our own subdomain `api.<domain>`, forwarded to Supabase by a tiny Cloudflare Worker (free tier, 100k requests/day; Supabase's own custom-domain add-on is paid), so the backend provider could be changed later without reprinting QR codes or updating apps.
- **API-3** Customers see **only** `public_token`, order number and pickup number, never internal IDs, staff names or fraud reasons.
- **API-4** "I've paid but it's stuck" checks with Razorpay **server-side**; the browser's success message is never trusted.
- **API-5** New shop devices are paired with a **one-time 6-digit code** created on the Owner's phone (valid 10 min).
- **API-6** Token count is shown at checkout **as a number only** (no name) after the mobile is typed, and rate-limited so it can't be used to look people up.
