# The Slush Bar — Phase 3: Feature List

**Status:** ✅ Approved by owner 2026-09-21 (soft launch: yes · optional picks: none) · **Date:** 2026-09-21 · Builds on [Phase 1](PHASE-1-REQUIREMENTS.md) and [Phase 2](PHASE-2-USER-FLOWS.md)

> **Amended 2026-09-22 — the token scheme changed.** On the owner's instruction, redeemable reward
> tokens were replaced by the **Lucky Draw**: a mobile number's spending (excluding GST) adds up across
> every order, and at ₹2,000 it earns **one** numbered token (`SLB-001`…`SLB-500`) that is a draw entry,
> never spent. Anything below about earning, approving, redeeming, expiring or owing tokens is
> **superseded** by “Lucky Draw tokens” in [REQUIREMENTS.md](REQUIREMENTS.md); the rest of this
> document still stands. What was actually built is in
> [IMPLEMENTATION-NOTES.md](IMPLEMENTATION-NOTES.md).


**How to read this:**
- **MVP** = everything needed before the first real customer pays. It contains every in-scope item from Phase 1, because you asked for offers, delivery and tokens at launch.
- **Phase 2** = things you've explicitly deferred.
- **Optional** = ideas you didn't ask for. **None of them will be built unless you pick them.**

Because MVP is large, it's built in **6 milestones**. Each one ends in something you can click through and test.

---

## MVP (launch)

### M1: Foundation
| # | Feature | FR |
|---|---|---|
| 1 | Poster-themed design system (colours, fonts, buttons, cards, bottom sheets) | — |
| 2 | Database, settings store, audit log | FR-47, FR-48 |
| 3 | Staff accounts & roles (Owner, Manager, Cashier, Kitchen) | FR-46 |
| 4 | Owner/Manager login (email + password), Owner 2FA | — |
| 5 | Shop-device registration + staff PIN login, idle lock, PIN lockout | — |
| 6 | Business info & hours settings, last-order buffer | FR-3, FR-47 |

### M2: Menu
| # | Feature | FR |
|---|---|---|
| 7 | Categories: add/edit/reorder/archive | FR-40 |
| 8 | Items: image upload, description, sizes with prices, featured, prep time | FR-40 |
| 9 | Add-on groups (paid) + free options (ice, sweetness) | FR-5, FR-40 |
| 10 | Time windows per item/category | FR-6 |
| 11 | Sold-out toggle (Cashier quick toggle + full edit for Manager) | FR-40 |
| 12 | Price-typo guard and price-change audit | Phase 2 §2.6 |

### M3: Customer ordering (with test payments)
| # | Feature | FR |
|---|---|---|
| 13 | Table/counter QR entry, disabled-QR page | FR-1, FR-2 |
| 14 | Mobile menu: category tabs, search, featured, sold-out state | FR-4 |
| 15 | Product bottom sheet with live price | FR-5 |
| 16 | Cart (saved on phone), sticky cart bar | FR-8 |
| 17 | Checkout: dine-in / takeaway, name + mobile, note | FR-9, FR-10, FR-12 |
| 18 | Server re-pricing + "something changed" re-confirm | FR-14 |
| 19 | Razorpay UPI (test mode), webhook verification, safe retries | FR-15 – FR-18 |
| 20 | Confirmation screen, order and pickup number | FR-23 |
| 21 | Live tracker, customer cancel while Pending, find-my-order | FR-21, FR-24, FR-25 |
| 22 | Menu cached for patchy signal (offline browsing) | NFR |

### M4: Staff operations
| # | Feature | FR |
|---|---|---|
| 23 | Live orders board (columns, chime, late-order pulse, live updates) | FR-37 |
| 24 | Accept / reject with reason; forward-only status steps | FR-19, FR-20 |
| 25 | Kitchen screen (Start / Ready, no prices or phone numbers) | FR-38 |
| 26 | Refund requests + Manager approval, full & partial refunds | FR-22 |
| 27 | Order history: search, filters, details | FR-39 |
| 28 | Receipts: numbering, PDF download, 80 mm thermal receipt + kitchen ticket (KOT) | FR-26, FR-49, FR-50 |
| 29 | QR code manager: create, standee preview, PNG/PDF download, enable/disable | FR-45 |

### M5: Tokens, customers, offers, delivery

*Superseded by the Lucky Draw — see the amendment note at the top of this document.*

| # | Feature | FR |
|---|---|---|
| 30 | Customer records by mobile: profile, orders, total spend | FR-42 |
| 31 | Token engine: cumulative progress, remainder carry, eligible = menu value before discounts | FR-27, FR-28 |
| 32 | Token approval queue, unique codes, printable token slip, 6-month expiry job | FR-29, FR-30 |
| 33 | Token redemption at checkout: reserve → redeem / release, max per order, "Verify mobile" badge | FR-13, FR-31, FR-34 |
| 34 | Token reversal on refund (negative balance allowed), manual adjustments, token log | FR-32, FR-33 |
| 35 | Coupons (% / ₹, minimum order, maximum discount, dates, usage limits) | FR-11, FR-41 |
| 36 | Combos, happy-hour pricing, first-order offer | FR-7, FR-11, FR-41 |
| 37 | Delivery: address + map pin, radius check, flat fee, delivery minimum, Out for delivery → Delivered | FR-10, FR-19 |

### M6: Dashboard, reports, launch
| # | Feature | FR |
|---|---|---|
| 38 | Dashboard: revenue, orders by status, AOV, failed payments, top products, sales by hour, repeat rate, token figures | FR-36 |
| 39 | Reports: sales (day/week/month), product, category, hour, payments/refunds, tokens, customers + CSV export | FR-44 |
| 40 | Customer marketing page `/` (poster hero, 5 slushes, visit us) | — |
| 41 | Security hardening, rate limits, backups, error monitoring | Phase 8 |
| 42 | Full test pass (Phase 9), Razorpay switched to live, printer set up, QR standees printed | — |

---

## Phase 2 (deferred by you; the design leaves room for each)
| Feature | Why deferred | Ready in the design by |
|---|---|---|
| SMS OTP for tokens | DLT registration + SMS cost | Pluggable "verify mobile" step |
| Customer notifications (WhatsApp / SMS / email) | Cost + Meta/DLT setup | Event log of every status change |
| GST tax invoices | Not registered yet | GST switch, rate, GSTIN fields |
| Counter POS (walk-in / cash billing) | Scope: QR orders only | Orders have a `source` field; cash payment type reserved |
| Multiple branches | One shop now | Every record carries a `branch_id` |
| Owner WhatsApp alerts / daily summary | Notifications deferred | Same event log |
| Hindi menu | English only for now | Text fields can take translations later |

## Optional (not requested; only if you pick them)
| Idea | Value | Effort |
|---|---|---|
| "Order again" / favourites on the tracker | Faster repeat orders | S |
| Customer-facing TV screen: "Now serving #42" | Fewer counter questions at rush hour | S |
| Installable app icon (full PWA install prompt) | Home-screen shortcut for regulars | S |
| Inventory / syrup stock tracking with low-stock alerts (from the original PRD) | Fewer sold-out surprises | M |
| Customer ratings & feedback after an order | Quality insight | S |
| Customer token-wallet page (balance, codes, expiry) without ordering | Engagement | S |
| Scheduled / pre-order for later pickup | Busy-hour smoothing | M |
| Staff performance (prep time per staff) | Ops insight | S |
| Automated daily backup download to owner's Google Drive | Peace of mind | S |

---

## Decisions (all approved 2026-09-21)
1. **The MVP includes everything in scope from Phase 1**, including delivery, all offer types and tokens. It's built as the 6 milestones above, and you review after each one.
2. **Soft launch:** when M1–M6 are done, run 1 week live with **dine-in + takeaway only**, then switch delivery and offers on from Admin. This keeps the first real-money week simple. You can say no and launch everything at once.
3. **Phase 2 list is exactly what you deferred.** Nothing added.
4. **Optional list:** pick any you want added to the MVP (or none).
