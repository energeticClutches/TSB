# The Slush Bar — Phase 9: Testing Plan

**Status:** ✅ Approved by owner 2026-09-21 · **Date:** 2026-09-21 · Builds on Phases [1](PHASE-1-REQUIREMENTS.md)–[8](PHASE-8-SECURITY.md)

> **Amended 2026-09-22 — the token scheme changed.** On the owner's instruction, redeemable reward
> tokens were replaced by the **Lucky Draw**: a mobile number's spending (excluding GST) adds up across
> every order, and at ₹2,000 it earns **one** numbered token (`SLB-001`…`SLB-500`) that is a draw entry,
> never spent. Anything below about earning, approving, redeeming, expiring or owing tokens is
> **superseded** by “Lucky Draw tokens” in [REQUIREMENTS.md](REQUIREMENTS.md); the rest of this
> document still stands. What was actually built is in
> [IMPLEMENTATION-NOTES.md](IMPLEMENTATION-NOTES.md).


**Goal:** prove that money, tokens and orders are **always** right, the phone experience is fast and easy, and nothing sensitive leaks, *before* a real customer pays.

---

## 1. Test layers
| Layer | What it proves | Tool | Runs |
|---|---|---|---|
| **Unit** | Pricing engine, token maths, money helpers, validation, time windows | Vitest | Every change (CI) |
| **Database** | Constraints, status transitions, RLS per role, database functions, triggers, hash chain, concurrency | pgTAP on a local Supabase | Every change (CI) |
| **API contract** | Every endpoint in Phase 7: success shapes, every error code, auth, rate limits, idempotency | Vitest + HTTP against local Supabase functions | Every change (CI) |
| **End-to-end** | Real journeys in real browsers: scan → pay → track; counter → kitchen; refunds; tokens | Playwright (mobile Chrome, mobile Safari/WebKit, desktop Chrome) with Razorpay **test mode** | Every merge + nightly on staging |
| **Accessibility** | Contrast, labels, keyboard use | axe (inside Playwright) + manual screen-reader pass | Every merge; manual per milestone |
| **Performance** | Lighthouse ≥ 90 mobile, JS ≤ 150 KB, menu first paint < 1.5 s on 4G | Lighthouse CI (4G throttling) | Every merge |
| **Load** | Rush hour: 60 orders in 10 min + 200 people browsing, staff board stays live | k6 against staging | Before go-live and after big changes |
| **Security** | Headers, common web attacks, role bypass, fraud cases | OWASP ZAP baseline + scripted abuse tests + the Phase 8 checklist | Per milestone + before go-live |
| **Owner acceptance (UAT)** | It works the way the shop works | You, on staging, with scripts (§6) | End of each milestone |
| **Soft launch** | Real-world behaviour | Monitoring (§8) | Launch week |

**Coverage targets:**
- `packages/core` (pricing, tokens, money): **100% of branches**.
- Database functions: every function has success, every error, and every role.
- Overall: **≥ 85%** lines. CI blocks merging below that.

---

## 2. Test data & environments
- **Seed menu:** the 5 signature slushes + shakes, pizzas (time-limited 4 PM–11 PM), mocktails, a combo, modifier groups, a sold-out item, an archived item, coupons (valid / expired / exhausted / min-order / high-value), a happy hour, the first-order promo (locked by the OTP rule).
- **Seed people:** one of each role; customers with 0, ₹1,999, ₹3,999 progress; with 2 tokens; with token debt; frozen; blocked.
- **Clock control:** tests can set the "current time" (IST) to check hours, happy hour, midnight crossing, token expiry.
- **Razorpay test mode:** successful UPI and failed UPI test payments; signed webhook fixtures for replay/forgery tests; refunds and disputes simulated with signed test events.
- **Staging** mirrors production settings, with test keys only. Production is never used for testing.

---

## 3. Critical test catalogue

### 3.1 Pricing (unit + API)
| # | Case | Expected |
|---|---|---|
| PR-1 | Regular ₹149 + boba ₹30, qty 2 | ₹358 |
| PR-2 | Mega size switch | Variant price used, add-ons kept |
| PR-3 | Happy hour 20% on slushes only, cart with pizza | Only slush lines discounted |
| PR-4 | Coupon 10% max ₹50 on ₹800 | −₹50 |
| PR-5 | Coupon below minimum | `min_not_met`, no discount |
| PR-6 | Coupon + first-order both eligible | Coupon replaces first-order (approved decision 5) |
| PR-7 | Token on a Regular slush during happy hour | Token line ₹0; no happy-hour discount on it |
| PR-8 | Tokens cover the full order | Total ₹0, no Razorpay, counter mobile check |
| PR-9 | Browser sends a lower price | Ignored; server price used |
| PR-10 | Price changed between cart and checkout | `409 PRICE_CHANGED` with diff; nothing created |
| PR-11 | Item sold out between cart and checkout | `409 ITEM_UNAVAILABLE`; nothing created |
| PR-12 | Required option missing / too many add-ons | `422 VALIDATION_FAILED` |
| PR-13 | Delivery inside/outside radius, below minimum | Fee added / `OUT_OF_DELIVERY_AREA` / `BELOW_MINIMUM` |
| PR-14 | Rounding: 15% of ₹149 | Whole paise, rounding rule consistent in preview and server |
| PR-15 | `total = subtotal − discounts + fee + tax` | Generated column always matches; never negative |

### 3.2 Token maths (unit + database), your rules exactly

*Superseded by the Lucky Draw — see the amendment note at the top of this document.*

| # | Case | Expected |
|---|---|---|
| TK-1 | Completed order, eligible ₹2,000 | Proposal: 1 token; progress → ₹0 after approval |
| TK-2 | Eligible ₹4,000 in one order | 2 tokens |
| TK-3 | Eligible ₹6,000 | 3 tokens |
| TK-4 | ₹3,999 | 1 token, **₹1,999 carried** |
| TK-5 | ₹1,500 then ₹600 (two orders) | 1 token after the 2nd, ₹100 carried |
| TK-6 | ₹1,000 order with a ₹200 coupon | **₹1,000** counts (menu value before discounts) |
| TK-7 | Order with a token item + delivery fee | Neither counts |
| TK-8 | Order pending approval, 2nd order completes | Same proposal updated, not two |
| TK-9 | Staff declines | Progress kept, reason logged |
| TK-10 | Refund of an order that earned an **unused** token | That token reversed, progress restored correctly |
| TK-11 | Refund after the token was **used** | Token debt +1; next approval settles the debt first |
| TK-12 | Partial refund of ₹500 eligible | Progress −₹500 (can trigger TK-10/11 if it goes below 0) |
| TK-13 | Token at 6 months + 1 minute | Expired; can't be reserved |
| TK-14 | Reserve 2 tokens, order cancelled | Both released to ISSUED |
| TK-15 | Max per order = 2, request 3 | `422 TOO_MANY_TOKENS` |
| TK-16 | Threshold changed to ₹1,500 in settings | New rule applies to the next calculation; history untouched |
| TK-17 | Order cancelled/rejected | Never proposes a token (only Completed/Delivered do) |
| TK-18 | Frozen customer | Can order; no earning or redemption |
| TK-19 | Ledger rebuild | Recomputing balances from `token_ledger` equals the cached balances for every customer |

### 3.3 Order lifecycle (database)
- Every allowed transition succeeds; **every disallowed one** (e.g. `pending → ready`, `completed → preparing`) raises `INVALID_TRANSITION`, even with a direct SQL update.
- Customer cancel only in `pending` → automatic full refund created.
- Reject → refund request waiting for a Manager; tokens released.
- `revert_order_status` Manager-only, one step, audited.
- Stale `version` → `VERSION_CONFLICT`.
- Held order can't be accepted.
- Order number and pickup number: sequential without gaps under 50 simultaneous payments; pickup resets at IST midnight.

### 3.4 Payments & the edge cases from your list
| # | Scenario | Expected |
|---|---|---|
| PY-1 | Normal UPI success | `pending` order within seconds; board chime; tracker "Paid ✓" |
| PY-2 | UPI failure | Order stays hidden; customer can retry; nothing on the board |
| PY-3 | **Customer pays, webhook never arrives** | Reconciliation (≤ 10 min) or "I've paid" check creates the order |
| PY-4 | **Webhook arrives late** (after the customer left the page) | Order still appears; tracker link works from history |
| PY-5 | **Browser closed during payment** | Payment still completes the order; "Your active order" pill on return |
| PY-6 | **Page refreshed during payment** | Same order, no duplicate (idempotency key) |
| PY-7 | **Double-tap Pay / two tabs** | One order, one Razorpay order |
| PY-8 | **Paid twice** for one order | Second payment refunded automatically; flag `DUPLICATE_PAYMENT` |
| PY-9 | Webhook replayed 5× | Processed once |
| PY-10 | Forged webhook (bad signature) | `400`, stored as invalid, no effect |
| PY-11 | Amount mismatch in webhook | Order held, `AMOUNT_MISMATCH` flag |
| PY-12 | **Paid after 30-min expiry** | Revived with a "Late payment" badge; flagged if tokens/coupon lost |
| PY-13 | **Razorpay down** | `503 PAYMENTS_UNAVAILABLE`, "order at counter" message, no half-created order |
| PY-14 | Refund full / partial / failed | Correct payment status, token reversal, dashboard flag on failure |
| PY-15 | Dispute opened | Payment `disputed`, tokens reversed, customer frozen |
| PY-16 | Network drop right after Pay | Customer returns → "Checking payment…" resolves correctly |
| PY-17 | **Duplicate orders** (same cart submitted twice with new keys) | Two genuine orders are allowed (two payments); the rate limit and `max_paid_orders_per_mobile_per_day` apply |

### 3.5 Other edge cases from your list
| Case | Test |
|---|---|
| Item unavailable while in cart | PR-11 + menu update visible within 30 s |
| Price changes after adding to cart | PR-10 |
| Token issued, order later refunded | TK-10/11 |
| Multiple devices placing orders | Same mobile on 2 phones → both orders fine; token reservation race (§3.7) |
| Network failure | Offline menu from cache; checkout disabled offline; staff board reconnects and resyncs |
| **Admin accidentally changes the price** | Drop > 50% → Owner approval; audit shows old → new; revert restores |
| QR code disabled | Scan → C9 page; checkout with that QR → `410` |
| Customer loses the confirmation | Find-my-order (mobile + number) → tracker |
| Payment gateway downtime | PY-13 |
| Order placed seconds before closing | Accepted until closing − buffer; after that `SHOP_CLOSED` |
| Time windows across midnight | Item available 10 PM–1 AM works on both sides of midnight |

### 3.6 Security & role tests (automated matrix)
- **For each of the 5 callers** (anonymous, Kitchen, Cashier, Manager, Owner) × **each** database function/view/table and staff API: allowed ones succeed, **everything else is denied**. Kitchen reading a price or mobile column must fail at the database level.
- PIN: wrong ×5 → lock; PIN on an unpaired device → denied; weak/duplicate PIN refused.
- Owner action without recent 2FA → step-up required.
- Tracker token guessing: 10,000 random tokens → all `404`, rate limited.
- XSS payloads in the note/name → rendered as text on the board, kitchen, receipt and PDF.
- SQL-injection strings in every input → treated as data.
- Headers/CSP verified; the tracker page sends no referrer.
- Secret scan of the repository; no Razorpay secret reachable from any app bundle.
- Maker–checker: the same person requesting and approving → denied.

### 3.7 Concurrency (fraud-critical)
| Race | Expected |
|---|---|
| 2 phones reserve the same last token at the same moment | Exactly one succeeds |
| 5 checkouts race for the last coupon use | Exactly one gets it |
| 2 cashiers accept the same order | One succeeds; the other gets `VERSION_CONFLICT` |
| Webhook + "I've paid" check at the same moment | Order marked paid once; one order number |
| 50 simultaneous captures | 50 unique, gapless order numbers |
| Refund approval clicked twice | One Razorpay refund (idempotency key) |

### 3.8 Fraud rules (each rule in Phase 4 §10)
A test that **triggers** each rule (flag created, correct severity/action) and one that **doesn't** (no false alarm). Plus: audit-chain tampering by a direct database edit → nightly check raises `AUDIT_CHAIN_BROKEN`.

### 3.9 Printing & devices
- Receipt and kitchen ticket at 80 mm: long item names wrap; ₹ symbol prints; Hindi characters (in case of customer names) don't break the layout.
- Silent printing from the counter PC; printer offline → "retry" toast; PDF always works.

---

## 4. Device & browser matrix
| Where | Devices / browsers |
|---|---|
| Customer app | Android Chrome (a low-end phone ~₹8–10k **and** a mid-range one), iPhone Safari (older + current iOS), Samsung Internet; UPI app handoff to GPay, PhonePe, Paytm on real phones in test mode |
| Admin | Chrome on Windows (counter PC), Android tablet Chrome, iPad Safari, Owner's phone |
| Kitchen | The actual kitchen tablet/TV at the actual distance and lighting |
| Network | 4G throttled, flaky (drops), offline |

---

## 5. Performance & load targets
| Metric | Target |
|---|---|
| Customer Lighthouse (mobile, 4G) | Performance ≥ 90, Accessibility ≥ 95, Best practices ≥ 95 |
| Menu visible after QR scan (4G) | < 1.5 s (first visit), < 0.8 s (repeat) |
| Checkout API | p95 < 800 ms (excluding Razorpay) |
| Webhook → staff board | p95 < 2 s |
| Staff action → kitchen screen | p95 < 1 s |
| Rush simulation (60 orders/10 min, 200 browsers, 5 staff screens) | No errors, targets above hold, stays within free-tier limits |

---

## 6. Owner acceptance (UAT) per milestone
A short script you run on staging on your phone and the counter device, then tick ✓/✗:

| Milestone | You try |
|---|---|
| M1 | Log in with 2FA; pair the counter tablet; create a cashier with a PIN; lock/unlock; change business hours |
| M2 | Add "Strawberry Splash" with 2 sizes, add-ons and a photo; mark something sold out; try a 60% price drop (should ask for approval) |
| M3 | Scan a table QR on your phone; order 2 items; pay with a Razorpay **test** UPI; see the tracker; cancel another order while pending |
| M4 | Accept/reject on the board; kitchen Start/Ready; print a receipt + kitchen ticket; request and approve a partial refund; disable a QR |
| M5 | Place orders totalling ₹2,000 on one mobile; approve the token; redeem it at checkout with the phone check; refund an order and watch the token reverse; create a coupon; run happy hour; test delivery |
| M6 | Read the dashboard and reports; export CSV; check the Risk screen; review the go-live checklist |

A milestone is **done** only when the automated suites are green **and** your UAT script is fully ✓ (or the ✗ items are agreed as later fixes).

---

## 7. Your acceptance criteria → where they're proven
| Your criterion | Proven by |
|---|---|
| Scan QR, open mobile menu, browse, view products | E2E journey J1 + UAT M3 |
| Add to cart, modify quantities, customise | PR-1/2/12, J1 |
| Checkout, pay with UPI, **verified automatically** | PY-1…PY-16 |
| Order created, order/token number, view status | PY-1, §3.3, J1 |
| Secure admin login | §3.6, UAT M1 |
| Dashboard, live orders, change status, payment status | J2 (counter → kitchen), UAT M4/M6 |
| Invoices (receipts) generate/print/download | §3.9, UAT M4 |
| Manage menu, upload images | UAT M2, API contract tests |
| Customers, tokens, reports, QR codes, business rules | TK-1…TK-19, UAT M5/M6 |
| Token: ₹2,000 → 1, ₹4,000 → 2, ₹6,000 → 3 | **TK-1, TK-2, TK-3** |

---

## 8. Bugs, release gates, soft launch
- **Severity:** **S1** money/tokens wrong, data leak, can't order → fix before anything else, blocks release. **S2** a feature broken with a workaround → blocks milestone sign-off. **S3** cosmetic/minor → scheduled.
- **Release gate** for production: all automated suites green, zero open S1/S2, Phase 8 go-live checklist fully ✓, load test passed, your M6 UAT ✓.
- **Regression:** every bug fixed gets a test that would have caught it.
- **Soft-launch week** (dine-in + takeaway only; approved Phase 3):
  - **Watched daily:** payment success rate (target ≥ 97%), reconciliation mismatches (target 0), orders stuck in Pending > 10 min, errors in Sentry, time from paid to ready, customer drop-off between cart and payment.
  - **Daily 10-minute check-in with you**, then turn on delivery and offers from Admin when the week is clean.

---

## 9. Decisions (all approved 2026-09-21)
- **T1** Test layers and tools as in §1, with **100% branch coverage** on pricing and token maths and ≥ 85% overall; CI blocks merging below that.
- **T2** Razorpay **test mode only** until the go-live gate passes; nothing is tested on production.
- **T3** **You run a short UAT script** at the end of each milestone; a milestone is done only with your ✓.
- **T4** Bug severity rules and the **release gate** in §8.
- **T5** Real-device testing on at least one **low-end Android**, one iPhone, and the actual counter/kitchen devices.
- **T6** Soft-launch monitoring targets (payment success ≥ 97%, zero reconciliation mismatches) before enabling delivery and offers.
