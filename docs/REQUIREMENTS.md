# The Slush Bar — Running Requirements Specification

Status: **Phase 1 approved 2026-09-21 · Phase 2 approved · Phase 3 approved · Phase 4 decisions approved · Phase 4 + Revision 2 approved · Phase 5 approved · Phase 6 approved · Phase 7 approved · Phase 8 approved · Phase 9 approved · Implementation: M1–M6 code complete & tested locally, runnable in demo mode (2026-09-22); going live waits on the Owner's accounts (docs/GO-LIVE.md).** Last updated: 2026-09-22

Legend: ✅ confirmed by owner · 🟡 my default, needs approval · ❓ open

## Business
- ✅ Name: The Slush Bar
- ✅ Address: Shop No. 140, The Slush Bar, Market, Sector-6, Bahadurgarh, Haryana – 124507, India
- ✅ Hours: every day, 11:00 AM – 11:00 PM (the Stitch mock-up's 11:30 PM is wrong). Ordering is closed outside these hours; hours are editable in Admin.
- ✅ Google categories: dessert shop, bistro, café, continental restaurant, ice cream shop.
- ❓ Legal name (for invoices), phone, WhatsApp, email, Instagram, domain.

## Scope
- ✅ The system handles **QR orders only**. Walk-in/cash counter billing stays outside the system.
  - Consequence: walk-in customers cannot earn tokens, and reports cover QR sales only.
- ✅ One shop now; the database is designed so more branches can be added later.
- ✅ Maintained by a non-technical owner, so every business rule must be editable from the Admin Panel.
- ✅ Budget: free tiers / under ₹500 a month (excluding gateway fees).
- ✅ No fixed deadline; quality over speed.
- ✅ English only.

## Ordering
- ✅ Order types: dine-in (table), takeaway/pickup, delivery.
- ✅ QR codes: one per table (table auto-filled) plus a counter/takeaway QR.
- ✅ Serving: dine-in is served to the table; takeaway is collected at the counter.
- ✅ Delivery by own staff/rider: Out for delivery → Delivered. Area = radius in km (map pin); flat fee. Radius, fee and minimum order are set in Admin.
- ✅ Checkout: name + mobile required. No customer account.
- ✅ Staff must accept each order: Pending → Confirmed → Preparing → Ready → Completed (delivery: Ready → Out for delivery → Delivered). Plus Rejected/Cancelled/Refunded.
- ✅ The customer can cancel only before staff accept; this triggers an automatic refund.
- ✅ If staff reject a paid order, a manager must approve the refund.
- 🟡 Refunds: full and partial (e.g. one item out of stock).
- 🟡 Prep time: a per-item prep time in Admin; the ETA uses the longest item plus the queue.
- ✅ Customer notifications (WhatsApp/SMS/email) deferred; the live on-screen order tracker is the MVP.

## Payments
- ✅ Razorpay (the owner has, or prefers, an account), UPI with automatic webhook verification. Screenshots are never proof.
- Payment states: created, pending, successful, failed, refunded, partially refunded.

## Billing / GST
- ✅ Not GST-registered, so prices are charged as-is. A GST switch (rate, inclusive/exclusive, GSTIN) is built into Admin and turned off.
- ✅ Invoices: PDF download plus thermal print. The owner needs a printer recommendation.
- Invoice numbers generated automatically.

## Menu
- ✅ 100% veg (no markers needed).
- ✅ Sizes with different prices, paid add-ons, time-based items.
- ✅ Offers at launch: coupon codes (% or ₹ off), combo products, happy-hour pricing, first-order offer.
- Sold-out toggle, featured items, reordering: all from Admin.

## Lucky Draw tokens (threshold and campaign size configurable in Admin)
*Replaces the earlier redeemable-token scheme, on the owner's instruction (22 Sep 2026).*

- ✅ A customer **is their verified mobile number**. Each number has one running total: its **loyalty spend**.
- ✅ Every successful eligible order adds its value **excluding GST** to that total. Loyalty spend is
  cumulative across visits and is **never reset**.
- ✅ The delivery fee doesn't count either — only what was paid for the drinks, after discounts.
- ✅ The moment the total reaches **₹2,000** (i.e. more than ₹1,999), the customer is issued **one Lucky
  Draw token, automatically**. There is no staff approval step.
- ✅ **One token per mobile number per campaign, permanently.** After that, later orders keep adding to the
  loyalty spend but can never earn a second token. Enforced by a unique constraint in the database, not
  by the front end, and issued inside a transaction so two simultaneous orders can't duplicate it.
- ✅ The campaign has **500 tokens**, numbered **SLB-001 … SLB-500**, handed out in order. When they run
  out, loyalty spend still accumulates but no token is issued.
- ✅ Tokens are **draw entries only**: never spent, never a discount, no expiry inside the campaign.
- ✅ Refund: the money comes back out of the loyalty spend. An already-issued token is **not** taken away
  automatically — if the refund drops them under ₹2,000 the token is flagged and a manager decides
  whether to cancel it by hand (the number is then retired, never reissued).
- ✅ A customer sees their own total and what's left to go; the shop sees the whole draw on one screen.
- Full, tamper-evident audit log of every change to loyalty spend. No transfers and no cash-out (🟡).

## Staff & admin
- ✅ Roles: Owner/Super Admin, Manager, Cashier/Counter, Kitchen (queue only, no prices or customer data).
- ✅ Owner/Manager log in with email + password (+2FA 🟡); counter and kitchen staff use a 4-digit PIN on shop devices.
- ✅ Devices: counter tablet, counter PC, kitchen screen, owner's phone.
- ✅ Staff alerts: sound + flashing card on staff screens.
- ✅ Dashboard priorities: revenue & orders, top products & peak hours, customers & repeat rate, the Lucky Draw.

## Design
- ✅ Poster theme and imagery (see `UI UX/reference/`), Stitch designs as a starting point.

## Open items
1. ❓ Remaining business details: legal name, phone, WhatsApp, email, Instagram, domain.
2. ❓ OTP channel. Only the first-order offer waits on it now; the Lucky Draw needs no OTP because nothing is ever handed over at the counter. SMS OTP once DLT registration is done.
4. ❓ Delivery: radius, fee, minimum order (starting values).
5. ❓ Printer recommendation (to follow).
6. ❓ Brand assets: high-res logo, poster, product photos; menu card.
7. ❓ Does GST-exclusive-at-checkout matter once registered? (switch exists)
