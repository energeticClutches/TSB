# The Slush Bar — Phase 1: Requirements Specification

**Status:** ✅ Approved by owner 2026-09-21 · **Date:** 2026-09-21 · **Source of truth for answers:** [REQUIREMENTS.md](REQUIREMENTS.md)

> **Amended 2026-09-22 — the token scheme changed.** On the owner's instruction, redeemable reward
> tokens were replaced by the **Lucky Draw**: a mobile number's spending (excluding GST) adds up across
> every order, and at ₹2,000 it earns **one** numbered token (`SLB-001`…`SLB-500`) that is a draw entry,
> never spent. Anything below about earning, approving, redeeming, expiring or owing tokens is
> **superseded** by “Lucky Draw tokens” in [REQUIREMENTS.md](REQUIREMENTS.md); the rest of this
> document still stands. What was actually built is in
> [IMPLEMENTATION-NOTES.md](IMPLEMENTATION-NOTES.md).


---

## 1. Purpose
A web-based QR ordering system for The Slush Bar (Shop No. 140, Sector-6 Market, Bahadurgarh, Haryana 124507). It covers the customer menu, Razorpay UPI payments, receipts, a digital token/reward programme, and a separate Admin Panel for staff.

## 2. Scope

| In scope | Out of scope (for now) |
|---|---|
| QR ordering: dine-in, takeaway, delivery (own rider) | Walk-in / cash counter billing (POS) |
| Razorpay UPI with automatic webhook verification | Cash payments, static UPI QR |
| Live order tracking page | WhatsApp / SMS / email / push notifications |
| Digital tokens with printable codes | SMS OTP (added once DLT registration is done) |
| Admin Panel: orders, menu, offers, customers, tokens, reports, QR codes, settings | GST invoices (switch built in, **off**) |
| PDF receipts + thermal printing | Multiple branches (database ready, UI single-shop) |
| | Hindi language, third-party delivery |

## 3. Users & roles

| Role | Login | Can do |
|---|---|---|
| **Customer** | None (name + mobile at checkout) | Browse, order, pay, track, view tokens |
| **Owner / Super Admin** | Email + password + 2FA | Everything, including staff, settings and payment config |
| **Manager** | Email + password | Orders, refunds, menu, offers, customers, token approvals/adjustments, reports |
| **Cashier / Counter** | 4-digit PIN on a shop device | Live orders, accept/reject, status updates, print, approve tokens, redeem tokens |
| **Kitchen** | 4-digit PIN on a shop device | Order queue only: Preparing → Ready. No prices or customer data |

## 4. Functional requirements

### 4.1 QR entry
- **FR-1** Each table has its own QR code (e.g. `/t/04`), which opens the menu with the table locked in. There is also one counter/takeaway QR.
- **FR-2** Every order records which QR code it came from. A disabled QR code shows a friendly "please order at counter" page.
- **FR-3** The menu can be browsed at any time. Checkout is open only during business hours (default 11:00 AM – 11:00 PM, last order 15 min before close).

### 4.2 Menu (customer)
- **FR-4** Mobile-first menu: category tabs, search, featured items, and sold-out items shown greyed out.
- **FR-5** Product sheet: sizes (each with its own price), paid add-ons, free options (ice level, sweetness), quantity, and a live price.
- **FR-6** Time-based items appear only during their set time windows.
- **FR-7** Combos are shown as products. Happy-hour prices apply automatically during their set hours.

### 4.3 Cart & checkout
- **FR-8** A cart bar at the bottom stays visible. Quantities can be edited and items removed.
- **FR-9** Order type: Dine-in (table taken from the QR code), Takeaway, or Delivery.
- **FR-10** Checkout needs name + mobile. Delivery also needs an address and a map pin, plus a check that the pin is within the delivery radius.
- **FR-11** Coupon code field. First-order offer applied automatically, based on the mobile number.
- **FR-12** Optional order note (sanitised, character limit).
- **FR-13** Token redemption at checkout (up to the admin-set maximum per order), after verifying the customer's mobile. See §4.7.
- **FR-14** **The server recalculates every price.** Prices sent by the phone are never trusted. If an item sold out or a price changed while it sat in the cart, the customer sees what changed and must re-confirm before paying.

### 4.4 Payment
- **FR-15** A Razorpay Checkout order is created on the server. The customer pays by UPI (GPay, PhonePe, Paytm, BHIM, or any UPI app).
- **FR-16** An order becomes *Paid* **only** after a Razorpay webhook with a verified signature, or a server-side payment check. Never on the phone's word, and never from a screenshot.
- **FR-17** Payment states: `created → pending → successful | failed`, plus `refunded` and `partially_refunded`.
- **FR-18** Payment handling is safe to repeat: duplicate webhooks, page refreshes and multiple tabs never create two orders or two charges.

### 4.5 Order lifecycle
- **FR-19** Statuses: `Pending (paid, awaiting accept) → Confirmed → Preparing → Ready → Completed`
  - Delivery: `Ready → Out for delivery → Delivered`
  - Exits: `Rejected`, `Cancelled`, `Refunded`
- **FR-20** Every paid order must be accepted by staff.
- **FR-21** The customer can cancel only while the order is *Pending*. This triggers an automatic full refund.
- **FR-22** When staff reject a paid order, the refund waits for a Manager or Owner to approve it. Full and partial refunds are supported.
- **FR-23** Every order gets an order number (e.g. `SL-1025`) and a short pickup number shown large.

### 4.6 Customer order tracking
- **FR-24** The confirmation screen opens a tracking page (`/order/{id}` with a secure link). It shows payment status, a status stepper, an ETA and the pickup number, and updates live.
- **FR-25** Lost link: the customer can find their recent orders by mobile number and order number.
- **FR-26** Receipt downloadable as a PDF from the tracking page.

### 4.7 Tokens (every value is editable in Admin)

*Superseded by the Lucky Draw — see the amendment note at the top of this document.*

- **FR-27** Each customer has a progress balance (₹) and a token balance, keyed to their mobile number.
- **FR-28** Earning is **cumulative**, and the **remainder carries forward**. Eligible amount = **menu value before discounts**. Items paid for with tokens don't count. Delivery fees don't count.
- **FR-29** When an order is completed, the system **proposes** the tokens earned. A Cashier, Manager or Owner **approves** them before they are issued.
- **FR-30** Each issued token has a unique code/QR, can be printed, and **expires 6 months after issue**.
- **FR-31** Redemption: several tokens per order, up to the admin-set maximum. The redemption value/type is configurable (**value not decided yet**).
- **FR-32** Refunds reverse both the earned spend and any tokens. If a token was already used, the balance goes negative and is recovered from future earnings.
- **FR-33** Tokens can't be transferred or cashed out. Manual adjustments need a reason and are written to the audit log.
- **FR-34** Mobile check for earning/redeeming: at launch, the cashier checks the customer's mobile when approving. Built so SMS OTP can be plugged in later.

### 4.8 Admin Panel
- **FR-35** Separate app area (`/admin`), all behind login and role checks.
- **FR-36 Dashboard:** today's revenue, orders by status, average order value, failed payments, top products, sales by hour, repeat-customer rate, tokens issued/redeemed/outstanding/expiring.
- **FR-37 Live orders board (counter):** columns by status, a chime and flashing card for new orders, orders older than X min highlighted. Updates live without refreshing.
- **FR-38 Kitchen screen:** large order cards and item modifiers only. Buttons: Preparing / Ready.
- **FR-39 Order history:** search (order number, mobile, name), filters (date, status, type, payment), details, receipt reprint, cancel, and refund requests.
- **FR-40 Menu:** categories and items (add/edit/delete/reorder), images, sizes, add-ons, free options, prep time, time windows, sold-out/available, featured.
- **FR-41 Offers:** coupons (% or ₹, minimum order, maximum discount, validity dates, usage limits), combos, happy hour, first-order offer.
- **FR-42 Customers:** list, profile, order history, total spend, token progress and balance, token history.
- **FR-43 Tokens:** approval queue, issue/redeem, look up by code or mobile, adjustments, settings, audit log.
- **FR-44 Reports:** daily/weekly/monthly sales, by product, by category, by hour, payment/refund summary, token liability, customer report. CSV export.
- **FR-45 QR codes:** create per table or counter, download PNG/PDF, print standees, enable/disable, orders per QR code.
- **FR-46 Staff:** add/remove staff, assign roles, reset PINs (Owner only).
- **FR-47 Settings:** business info and hours, last-order buffer, delivery radius/fee/minimum, token rules, receipt header/footer, GST switch (off), Razorpay mode (test/live).
- **FR-48 Audit log:** price changes, refunds, token changes, settings changes, staff changes. Records who, what, when, old → new.

### 4.9 Receipts & printing
- **FR-49** Numbered receipts ("Receipt", not "Tax Invoice", while GST is off). PDF download.
- **FR-50** Thermal print of the receipt and the kitchen ticket (KOT), 80 mm, from the counter device. Printer model to be recommended in Phase 5.

## 5. Business rules — configurable defaults

| Rule | Default | Status |
|---|---|---|
| Token threshold | ₹2,000 | ✅ |
| Counting | Cumulative, remainder carried | ✅ |
| Eligible amount | Menu value before discounts | ✅ |
| Token expiry | 6 months from issue | ✅ |
| Token issuing | Staff approval | ✅ |
| Max tokens per order | 2 | 🟡 |
| Token redemption value | *Not decided* | ❓ |
| Business hours | 11:00 AM – 11:00 PM daily | ✅ |
| Last order buffer | 15 min | 🟡 |
| Delivery radius / fee / minimum | *To be set* | ❓ |
| Late-order highlight | 5 min in Pending/Confirmed | 🟡 |
| GST | Off | ✅ |

## 6. Non-functional requirements
- **Performance:** customer menu Lighthouse mobile ≥ 90, first content on screen in under 1.5 s on 4G. Staff screens update in under 1 s.
- **Offline:** the menu is cached so it can be browsed on a patchy signal. Checkout needs a connection.
- **Accessibility:** text contrast ≥ 4.5:1, tap targets ≥ 44 px, admin usable by keyboard.
- **Security:** see Phase 8. Headlines: all secrets on the server, webhook signatures verified, role checks enforced at the database level, rate limits, audit trail.
- **Cost:** runs on free tiers at launch (under ₹500 a month), excluding Razorpay fees.
- **Operability:** a non-technical owner manages everything from Admin. Automatic database backups.

## 7. Edge cases to handle (designs in Phases 4–8)
Customer pays but the order isn't created · payment fails after the order is created · duplicate payment · browser closed during payment · late webhook · page refresh during payment · item sold out while in cart · price changes while in cart · token issued then order refunded · partial refunds · multiple tabs or devices · duplicate orders · network failure · admin enters a wrong price · QR code disabled · confirmation link lost · Razorpay downtime · order placed seconds before closing · delivery pin outside the radius · coupon used beyond its limit (two people redeeming at the same moment) · token redeemed twice at the same moment · expired token redeemed.

## 8. Deferred (fill in later; nothing blocks the design)
Legal name, phone/WhatsApp/email/Instagram, domain, delivery values, token redemption value, brand files (high-res logo, poster, photos), menu card, printer purchase.

## 9. Decisions (all approved 2026-09-21)
1. **Max tokens per order default = 2** (changeable).
2. **Last order 15 min before close.**
3. **Mobile check for tokens:** cashier checks at launch; SMS OTP added later.
4. **Coupons and happy hour don't reduce token earning** (follows from "menu value before discounts").
5. **Token-paid items and delivery fees don't count toward earning.**
6. **Tokens are proposed when the order is *Completed*** (not when paid), so cancelled or rejected orders never generate one.
