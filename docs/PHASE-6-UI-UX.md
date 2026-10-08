# The Slush Bar — Phase 6: UI/UX

**Status:** ✅ Approved by owner 2026-09-21 (D9 prototype: no, owner does not want any code yet) · **Date:** 2026-09-21 · Builds on Phases [1](PHASE-1-REQUIREMENTS.md)–[5](PHASE-5-ARCHITECTURE.md)

> **Amended 2026-09-22 — the token scheme changed.** On the owner's instruction, redeemable reward
> tokens were replaced by the **Lucky Draw**: a mobile number's spending (excluding GST) adds up across
> every order, and at ₹2,000 it earns **one** numbered token (`SLB-001`…`SLB-500`) that is a draw entry,
> never spent. Anything below about earning, approving, redeeming, expiring or owing tokens is
> **superseded** by “Lucky Draw tokens” in [REQUIREMENTS.md](REQUIREMENTS.md); the rest of this
> document still stands. What was actually built is in
> [IMPLEMENTATION-NOTES.md](IMPLEMENTATION-NOTES.md).

**Visual references:** `UI UX/reference/poster-*.{webp,png}` (theme source) · `UI UX/stitch_the_slush_bar_platform/` (starting point)

---

## 1. Visual direction: "Poster, but usable"

The poster is loud, hot pink and hand-lettered. That's perfect for **first impressions** (the marketing page, empty states, the confirmation screen) and tiring for **working screens** (menu lists, checkout, staff boards). So:

| Surface | Energy | How |
|---|---|---|
| Marketing page, confirmation, "token earned" | **Full poster** | Brush lettering, pink paint swipes, cup photos, sticker badges, neon "Sip Smile Repeat" |
| Customer menu & product sheet | **Poster accents** | Blush background, flavour-coloured cards for the 5 signature slushes, pink pill buttons; clean white rows for everything else |
| Cart, checkout, payment | **Calm & trustworthy** | White, lots of space, one pink action button, clear totals |
| Admin & counter | **Clean & data-first** | Neutral surfaces, pink only for primary actions and brand; status colours carry the meaning |
| Kitchen screen | **Dark, high contrast** | Readable from 2 m away under bright light and steam |

### 1.1 Colour tokens (from `DESIGN.md`, with contrast fixes)
| Token | Value | Use |
|---|---|---|
| `brand` | `#E6007A` | Buttons, cart bar, active tabs (white text on it = 4.5:1 ✓) |
| `brand-ink` | `#B90061` | **Pink text** on white/blush (small text needs the darker shade) |
| `brand-tint` | `#FFE8F3` | Chips, selected states |
| `surface` | `#FFF7F9` | Page background |
| `card` | `#FFFFFF` | Cards, sheets |
| `ink` | `#1A1118` | Main text |
| `ink-muted` | `#5B3F47` | Secondary text (≥ 7:1 on white) |
| `line` | `#F0D8E4` | Borders |

**Flavour accents.** Chip text is darkened compared with `DESIGN.md` to pass 4.5:1:
| Flavour | Fill / glow | Chip bg | **Chip text** |
|---|---|---|---|
| Blue Lagoon | `#00C0F3` | `#E0F7FA` | `#00628E` |
| Mango Mania | `#FFB300` | `#FFF8E1` | `#7A4B00` |
| Strawberry Splash | `#FF1744` | `#FFEBEE` | `#B3122E` |
| Kiwi Kick | `#64DD17` | `#F1F8E9` | `#2E5E1A` |
| Jamun Twist | `#7B1FA2` | `#F3E5F5` | `#5E1780` |

**Status colours** (admin + tracker, always paired with an icon and a word, never colour alone):
New/Pending `#7A4B00` on amber tint · Confirmed `#00628E` on blue tint · Preparing `#B90061` on pink tint · Ready `#2E5E1A` on green tint · Out for delivery `#5E1780` on violet tint · Cancelled/Rejected `#93000A` on red tint · Completed: grey.

### 1.2 Type
| Role | Font | Notes |
|---|---|---|
| Headings, prices, numbers | **Outfit** 700–900 | Pickup numbers in Outfit 900 |
| Body, labels, inputs | **Plus Jakarta Sans** 500–700 | Minimum 14 px on mobile; inputs 16 px (stops iPhone zoom) |
| Poster accents | **Hand-lettered SVGs** traced from the poster ("Cool Down with SLUSH", "Sip Smile Repeat", "Visit The Slush Bar") | Decorative only, never for information. Small files, no extra font download |

### 1.3 Shape, depth, motion
- **Shape:** cards `rounded-3xl`; buttons and chips fully round; bottom sheets 28 px top corners.
- **Shadows:** pink-tinted as in `DESIGN.md` (Level 1 cards, Level 2 sheets/cart bar, Level 3 dialogs).
- **Motion:** 150–250 ms springy scale on "Add" (the cart bar "gulps"), sheets slide up, steps in the tracker fill like a slush cup.
  - Everything respects the phone's **reduce-motion** setting.
- **Tap targets ≥ 44 px.** Primary actions sit in the **bottom third** of the screen (thumb zone).

### 1.4 Voice
Short, friendly, clear. "Added to cart ✓", "Your slush is blending!", "Sorry, Jamun Twist just sold out. We removed it from your cart." No jargon. Errors always say **what to do next**.

---

## 2. Customer app (`order.<domain>`), mobile-first (360–430 px)

### Screen map
```
QR scan ─► [C1 Menu] ─► [C2 Product sheet] ─► [C3 Cart] ─► [C4 Checkout] ─► Razorpay ─► [C5 Payment check] ─► [C6 Tracker]
               │                                                  └► [C4a Delivery address sheet]
               ├► [C7 Find my order]           States: [C8 Closed] [C9 QR disabled] [C10 Changed items] [C11 Errors/offline]
```

### C1: Menu (home after QR scan)
```
┌──────────────────────────────────┐
│ (logo)  THE SLUSH BAR   [Table 04]│  ← sticky header; table chip locked (dine-in QR)
│                     [⟲ Track order]│     counter QR shows [Takeaway ▾]
├──────────────────────────────────┤
│ ┌ Offer strip (only if an offer) ┐│  ← "Happy hour · 20% off slushes till 6 PM"
│ └────────────────────────────────┘│
│ Meet the Iconic Slushes           │
│ ◄ [Blue][Mango][Strawb][Kiwi][Jam]►│  ← horizontal carousel of the 5 poster cups,
│   cup photo · name · ₹129 · (+)   │     card tinted in its flavour colour
├──────────────────────────────────┤
│ [Slushes][Shakes][Pizza][Mocktail]│  ← sticky category tabs, scroll-spy
│ 🔍 Search                          │
├──────────────────────────────────┤
│ Strawberry Splash        ┌──────┐ │  ← list rows: name, 2-line description,
│ Hill strawberries, ice…  │ img  │ │     "from ₹149" when sizes differ,
│ from ₹149  ★Bestseller   │[ADD]│ │     ADD button overlapping the image
│─────────────────────────└──────┘─│
│ Kiwi Kick   SOLD OUT  (greyed)    │  ← sold-out rows stay visible, not tappable
│ Cheese Burst Pizza  🕓 from 4 PM   │  ← time-limited items show when they're available
├──────────────────────────────────┤
│ ████ 2 items · ₹338   View cart → │  ← sticky pink cart bar (appears after 1st add)
└──────────────────────────────────┘
```
- The first screen loads from the cached menu file; images fade in (fixed-size placeholders, so nothing jumps).
- Tapping **ADD** on an item with no required choices adds it straight away (1 tap). Otherwise it opens C2.
- The quantity stepper replaces ADD once an item is in the cart.

### C2: Product sheet (bottom sheet, ~90% height)
```
┌──────────────────────────────────┐
│ ▔▔▔                          [✕] │
│   [ big cup photo on flavour     │
│     colour glow · -4°C chip ]    │
│ Strawberry Splash                 │
│ Hill strawberries, crushed ice…   │
│ Size ─────────────────────────── │
│ ( Regular 350ml ₹149 )( Mega 500ml ₹189 )   ← segmented pills
│ Ice level  ❄ ─●─ ❄❄ ─○─ ❄❄❄      │  ← stepped slider with snowflake icons
│ Sweetness  🍓 ─○─ 🍓🍓 ─●─ 🍓🍓🍓  │
│ Add-ons (up to 3) ────────────── │
│ ☐ Popping boba            +₹30   │
│ ☐ Fruit jelly             +₹20   │
│ Note for this item (optional)     │
├──────────────────────────────────┤
│  [ − 1 + ]   [  Add · ₹179  ]     │  ← sticky; price updates live
└──────────────────────────────────┘
```
- Required groups show "Required" and scroll into view if skipped.
- Combos show each component with its own choices.

### C3: Cart
```
┌──────────────────────────────────┐
│ ← Your order              Table 04│
│ Strawberry Splash · Mega   ₹219  │
│   +Boba · Less ice · 50% sweet   │
│   [Edit]          [ − 1 + ]       │
│ Blue Lagoon · Regular      ₹129  │
│ ─────────────────────────────── │
│ How do you want it?               │
│ ( Dine-in · T04 )( Takeaway )( Delivery )  ← delivery hidden if off
│ ─────────────────────────────── │
│ Item total                 ₹348  │
│ Happy hour               − ₹30   │
│ To pay                     ₹318  │
├──────────────────────────────────┤
│        [ Continue · ₹318 ]        │
└──────────────────────────────────┘
```

### C4: Checkout (one scrolling page, no multi-step wizard)
```
┌──────────────────────────────────┐
│ ← Checkout                        │
│ Your name   [ Aarav            ]  │
│ Mobile      [+91| 98xxxxxxxx   ]  │  ← numeric keypad; remembered on this phone
│ Note        [ Kids at table…   ]  │  ← optional, 200 chars
│ ─────────────────────────────── │
│ 🎟  Coupon  [ SLUSH10 ] [Apply]   │  ← hidden while offers are switched off
│ 🪙  You have 2 tokens  [Use 1 ▾]  │  ← appears once the mobile is recognised
│     "Show this phone at the counter to redeem"
│ ─────────────────────────────── │
│ Item total                 ₹348  │
│ Discounts                 − ₹60  │
│ Token (1 Regular Slush)  − ₹129  │
│ To pay                     ₹159  │
│ 🔒 Secured by Razorpay · UPI      │
├──────────────────────────────────┤
│   [ Pay ₹159 with UPI  ▸ ]        │  ← opens Razorpay (GPay/PhonePe/Paytm/any UPI)
└──────────────────────────────────┘
```
- Validation happens inline, as you type, and never clears what you entered.
- **C4a Delivery sheet:** map with a draggable pin plus "Use my location" → address fields (house/flat, landmark) → an "✓ We deliver here · ₹30 fee" or "✕ Outside our 5 km area" line.
- **C10 Changed items dialog:** "Kiwi Kick sold out. Removed" / "Mango Mania is now ₹149 (was ₹139)" → [Update & continue].

### C5: Payment check
```
      (cup filling animation)
   Confirming your payment…
   Don't close this page.
   [ I've paid but it's stuck ]   ← after 20 s: asks the server, which asks Razorpay
```
- Failure → "Payment didn't go through. No money was taken." (or "If money was debited, it'll be refunded automatically") + [Try again] [Edit cart].

### C6: Confirmation → live tracker (same screen)
```
┌──────────────────────────────────┐
│  (brush lettering) Order placed!  │
│   ┌────────────┐                  │
│   │  PICKUP    │   SL-1025        │
│   │    #42     │   Table 04       │  ← huge Outfit 900 number
│   └────────────┘                  │
│ ✓ Paid ₹159 via UPI               │
│ ● Order received     2:14 PM      │
│ ● Accepted by the shop            │
│ ◐ Blending your slush · ~6 min    │  ← current step animates
│ ○ Ready: we'll bring it to T04    │
│ ○ Completed                        │
│ [Cancel order] (only while waiting for the shop)
│ ─────────────────────────────── │
│ 🪙 ₹1,450 / ₹2,000 to your next token ███████░░
│ [Download receipt]  [Back to menu]│
└──────────────────────────────────┘
```
- **Ready** triggers a full-screen pink flash, a vibration (if allowed) and a "Ready! Collect at counter · #42" banner.
- **Rejected/cancelled** show the reason and the refund status.
- **Save for later:** the link is stored on the phone and a "Your active order" pill shows on C1 until completed.

### C7: Find my order
Mobile + order number → the tracker opens. After 5 wrong tries: "Please ask at the counter."

### C8–C11: States
- **C8 Closed:** menu still browsable, pink banner "We're closed · Opens 11:00 AM", checkout disabled.
- **C9 QR disabled:** brand illustration + "This table's code isn't active. Please order at the counter."
- **C11 Offline:** "You're offline. Menu shown from your last visit." Checkout disabled.
- **Load failed:** [Retry].

---

## 3. Admin app (`admin.<domain>`)

### Layouts
| Device | Layout |
|---|---|
| Counter PC / tablet (≥ 1024 px) | Left sidebar + main area; the live board fills the screen |
| Kitchen screen | Full-screen, **dark**, no navigation |
| Owner phone | Bottom tabs: **Dashboard · Orders · Tokens · Risk · More** |

### Navigation by role
| Screen | Owner | Manager | Cashier | Kitchen |
|---|---|---|---|---|
| Dashboard | ✓ | ✓ | — | — |
| Live orders board | ✓ | ✓ | ✓ | — |
| Kitchen screen | ✓ | ✓ | — | ✓ |
| Order history & details | ✓ | ✓ | ✓ (today) | — |
| Refunds | ✓ approve all | ✓ approve ≤ limit | request | — |
| Menu | ✓ | ✓ | sold-out toggle | — |
| Offers | ✓ | ✓ (big ones need Owner) | — | — |
| Customers | ✓ | ✓ | lookup | — |
| Tokens | ✓ | ✓ | approve / redeem | — |
| Risk & approvals | ✓ | view | — | — |
| Reports | ✓ | ✓ | — | — |
| QR codes | ✓ | ✓ | — | — |
| Staff & devices, Settings, Audit log | ✓ | — | — | — |

### A1: Login
- **Owner/Manager:** email + password → 6-digit authenticator code (Owner) → Dashboard.
- **Shop device (A1b):** a grid of staff name tiles (initial + colour) → tap your name → big 4-digit PIN pad → your home screen. The top bar always shows "Signed in: Simran · Switch".

### A2: Dashboard (Owner/Manager)
```
┌ Today ▾ ─────────────────────────────────────────────────────────┐
│ [Revenue ₹24,850 ▲18%] [Orders 142] [Avg ₹175] [Pending 3] [Failed pay 2] │
├────────────────────────────┬─────────────────────────────────────┤
│ Sales by hour (bar chart)  │ Top products (ranked bars, flavour colours) │
├────────────────────────────┼─────────────────────────────────────┤
│ Customers: 38 new · 61% repeat │ Tokens: 18 issued · 9 redeemed · 42 outstanding (₹5,418) · 6 expiring in 30d │
├────────────────────────────┴─────────────────────────────────────┤
│ ⚠ Needs attention: 2 token approvals · 1 refund request · 1 risk flag  → │
└──────────────────────────────────────────────────────────────────┘
```

### A3: Live orders board (Cashier home)
```
 NEW (2) 🔔          CONFIRMED (3)       PREPARING (4)      READY (2)        OUT FOR DELIVERY (1)
┌──────────────┐   ┌──────────────┐
│ #42  SL-1025 │   │ #39  T02     │ …
│ Table 04 · 1m│   │ Takeaway · 4m│
│ 2× Strawberry│   │ ...          │
│   Mega +boba │
│   50% sweet  │
│ 📝 Kids at   │
│   table      │
│ 🪙 Verify mob│  ← token badge (must tap to confirm the phone was checked)
│ [✓ Accept][✕]│
└──────────────┘
```
- The card border colour = status. An order older than 5 min in New/Confirmed **pulses amber**. A held order has a red "Review" band and Accept is disabled.
- Tap a card → **A4 Order drawer**: items, customer (masked mobile, tap to reveal = audited), payment (UPI, masked VPA, Razorpay id), timeline, buttons: Print receipt · Reprint KOT · Request refund · Next status.
- A top bar quick action **"Sold out…"** opens a searchable list of toggles.
- **Sounds:** new order = two-tone chime (repeats every 30 s until acknowledged); payment problem = low buzz.

### A5: Kitchen screen (dark)
```
███████████████████████████████████████████████████████████
█ #42 · T04 · 2 min      █ #41 · Takeaway · 4 min  (amber) █
█ 2× STRAWBERRY SPLASH   █ 1× BLUE LAGOON          █
█    MEGA · +BOBA        █    REGULAR · EXTRA ICE  █
█    50% SWEET           █ 1× CHEESE BURST PIZZA   █
█ 📝 Kids at table       █                         █
█   [ START ▶ ]          █   [ READY ✓ ]           █
███████████████████████████████████████████████████████████
```
- Oldest first, huge type, modifiers in yellow. No prices, no phone numbers. A chime plays when the counter accepts an order.

### A6: Order history
Filters (date range, status, type, payment status), search (order number / mobile / name), table with pagination, CSV export (Manager+).

### A7: Refunds
Queue of requests → detail: items with a quantity to refund, auto-calculated amount, reason → **Approve / Decline**. The button reads "Needs Owner approval" above ₹500 or if you requested it yourself.

### A8: Menu
- **Left:** categories (drag to reorder). **Right:** items (drag to reorder), each row with photo, name, price(s), toggles [Available] [Featured] [Sold out].
- **Item editor (A8b):** photo upload (crop + auto WebP), name, description, category, flavour accent colour, sizes table (name · price · token-redeemable ✓), add-on groups (pick existing or create), prep time, availability windows (days + times), Save.
  - A price drop over 50% becomes an Owner approval request, with a "Sent to Owner for approval" toast.
- **Modifier groups (A8c):** reusable groups with options and prices, min/max choices.
- **Preview button:** shows the item exactly as customers will see it.

### A9: Offers
Tabs: Coupons · Combos · Happy hour · First-order (shows "Requires SMS OTP", disabled). Each editor shows a live summary sentence: "10% off, up to ₹50, orders over ₹300, until 31 Oct, 1 use per customer, 200 total".

### A10: Customers
Search by mobile/name → profile: name, masked mobile, first/last visit, orders, total spend, token progress bar, token balance/debt, token list (code, status, expiry), token history (ledger), flags, [Freeze] [Adjust tokens]. Adjusting needs a reason and respects the daily cap.

### A11: Tokens

*Superseded by the Lucky Draw — see the amendment note at the top of this document.*

- **Approvals queue:** customer, orders that earned it, proposed count, [Approve] [Decline + reason].
- **Lookup / scan:** type or scan a token QR → valid / redeemed / expired + owner (masked).
- **Settings link** (Owner).

### A12: Risk & approvals (Owner)
- **Open fraud flags:** rule, severity, evidence, [Clear] [Confirm] [Block identity].
- **Pending Owner approvals:** refund over limit, big coupon, price drop, manual tokens.
- **Reconciliation status:** "Last check 2:10 PM ✓ all 142 payments matched".
- **Audit-chain status:** "✓ Intact (checked 3:00 AM)".

### A13: Reports
Period picker → tabs: Sales · Products · Categories · Hours · Payments & refunds · Tokens · Customers. Each tab has a chart + table + CSV.

### A14: QR codes
Grid of standee previews (poster-styled card: logo, "Scan · Order · Sip", QR, "Table 04"), [Download PNG] [Download print PDF (A6 standee)] [Disable], plus an orders-per-QR count. [+ Add table] [Print all].

### A15: Staff & devices (Owner)
- **Staff list:** role, status, [Reset PIN] [Deactivate].
- **Devices:** name, allowed roles, last seen, [Revoke]. **[Register this device]** shows a one-time code the Owner confirms.

### A16: Settings (Owner)
Grouped cards: Business & hours · Ordering (last-order buffer, late alert) · Delivery · Tokens · Offers master switch · Fraud limits · Receipts & GST (off) · Payments (test/live). Every save asks for confirmation and is audited.

### A17: Audit log
Filterable timeline: who, what, when, before → after.

### A18: Printed receipt (80 mm) & kitchen ticket (KOT)
```
   THE SLUSH BAR                    KOT  #42   SL-1025
 Shop 140, Sector-6 Mkt             TABLE 04 · 2:14 PM
 Bahadurgarh 124507                 ------------------
 Receipt SLB/2026-27/000123         2x STRAWBERRY SPLASH
 SL-1025 · #42 · T04 · 2:14 PM         MEGA
 --------------------------            +BOBA
 2 Strawberry Splash Mega  438         50% SWEET
   +Boba                             NOTE: Kids at table
 --------------------------
 Total                    ₹438
 Paid UPI ✓ (pay_…9XQ)
 Token progress ₹1,450/2,000
   Cool down. Sip. Smile. Repeat.
```

---

## 4. Marketing site (`<domain>`)
Single page, poster come alive:
1. Hero: brush "Cool Down with SLUSH", five cups, "Order at your table: scan the QR" and [View menu].
2. The five slushes with flavour stickers.
3. Four feature icons (Premium flavours, Fresh ingredients, Chilled to perfection, Perfect for every mood).
4. How QR ordering works (3 steps).
5. Tokens: "Every ₹2,000 = 1 free treat".
6. Visit us: address, hours, map link, Instagram.
7. Footer.

It's the **only** place with full poster intensity. It never loads the ordering app's code.

---

## 5. Accessibility & quality bar
- Text contrast ≥ 4.5:1 (the chip colours are fixed above); status is never shown by colour alone.
- Every control has a label; the admin works with the keyboard (board shortcuts: `A` accept, `N` next status, `/` search).
- Font scaling up to 200% without broken layouts. Supports reduce-motion.
- Skeleton loaders instead of spinners on lists; **every** empty state has a friendly message and a next step.
- **Performance budget:** customer app ≤ 150 KB JavaScript (compressed) on first load; images WebP ≤ 60 KB each.

---

## 6. Decisions (approved 2026-09-21; D9 = no)
- **D1** "Poster, but usable": full poster style on the marketing page and celebration moments; calmer styling for menu, checkout and admin.
- **D2** The customer menu uses **list rows with the photo on the right** (quick to scan, like Swiggy/Zomato), with the **5 signature slushes as a flavour-coloured carousel** on top. This replaces Stitch's big desktop grid and marketing hero on the ordering page.
- **D3** Accessible colour fixes: darker pink for small text and darker chip text for Mango/Blue Lagoon etc. They look nearly the same but are readable.
- **D4** Hand-lettered poster phrases as **SVG artwork**, not a script font (sharper, lighter, closer to the poster).
- **D5** **Dark kitchen screen**, for readability in a bright, steamy kitchen.
- **D6** One-page checkout (no multi-step wizard) and **1-tap ADD** for items with no required choices.
- **D7** The new-order chime **repeats every 30 s** until someone acknowledges it.
- **D8** The customer's mobile is **masked** in admin by default; revealing it is logged.
- **D9 (optional):** before coding, I build a **clickable visual prototype** of 6 key screens (C1 Menu, C2 Product sheet, C4 Checkout, C6 Tracker, A3 Live board, A5 Kitchen) for you to try on your phone. It's a design mockup, not the app. Say **yes/no**.
