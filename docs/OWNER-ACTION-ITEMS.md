# The Slush Bar: Owner action items

Everything the build needs **from you**. Tick items off as you go. Development continues without
them: they're only needed to connect the website to real services and go live.

Last updated: 2026-09-21

**Legend:** 🔴 Needed before the live test (staging) · 🟠 Needed before launch · 🟢 Later / optional

---

## 1. Accounts to create (in your name, with 2FA on every one)

Create them yourself and invite the developer. **Never share your passwords.** (Security decision S1)

| # | Account | What to do | Why it's needed | Priority |
|---|---|---|---|---|
| A1 | **Supabase** (supabase.com) | Sign up, turn on 2FA. Create a project named `slush-bar-staging`, region **Mumbai (ap-south-1)**. Invite the developer under Project → Team. Later, create a second project for production | Database, logins, live order updates | 🔴 |
| A2 | **GitHub** (github.com) | Sign up, turn on 2FA. Create an organisation (e.g. `theslushbar`) and invite the developer | Stores the code; runs the automatic tests | 🔴 |
| A3 | **Cloudflare** (cloudflare.com) | Sign up, turn on 2FA, invite the developer | Hosts the website, images and bot protection (free plan) | 🔴 |
| A4 | **Razorpay** (razorpay.com) | Sign up, turn on 2FA. Stay in **Test mode** for now and invite the developer with a limited team role. Complete **KYC** (business documents, bank account) before launch | UPI payments. Test mode needs no KYC | 🔴 test · 🟠 KYC |
| A5 | **Domain name** | Buy one, e.g. `theslushbar.in` (~₹700–1,000/year), from any registrar. Then point it to Cloudflare | Web address for the QR codes and website | 🟠 |
| A6 | **Sentry** + **UptimeRobot** | Free sign-ups, 2FA, invite the developer | Alerts if something breaks or the site goes down | 🟠 |
| A7 | **Resend** (resend.com) | Free sign-up, 2FA | Password-reset and invitation emails | 🟠 |

---

## 2. Business details

| # | Item | Where it's used | Priority |
|---|---|---|---|
| B1 | **Shop phone number** | Website, receipts, privacy page | 🟠 |
| B2 | **WhatsApp number** (if different) | Website "contact us" | 🟢 |
| B3 | **Email for the business** | Privacy page (grievance contact, required by the DPDP Act), receipts | 🟠 |
| B4 | **Instagram / social handles** | Website footer | 🟢 |
| B5 | **Legal name for receipts** (e.g. "The Slush Bar" or the proprietor/firm name) | Every receipt | 🟠 |
| B6 | **Exact shop location** (Google Maps link) | Delivery radius, "Get directions" button | 🟠 (🔴 if delivery is on at launch) |

---

## 3. Decisions still open

| # | Decision | Options | Current setting | Priority |
|---|---|---|---|---|
| D1 | **What does the Lucky Draw win?** | The prize, when you'll draw it, and how you'll tell the winner. The app only hands out the numbered tokens — the draw itself is yours to run | 500 tokens, one per mobile, ₹2,000 of spending each. Prize not decided | 🟠 |
| D2 | **Delivery: radius, fee, minimum order** | e.g. 5 km, ₹30 fee, ₹200 minimum | Delivery is off (it comes on after the first live week) | 🟢 |
| D3 | **How long to keep financial records** | Ask your CA (usually 6–8 years) | Kept indefinitely until confirmed | 🟠 |
| D3b | **Switch on offers** (Admin → Settings → Offers) and create your first coupon / happy hour | The system is ready; nothing shows to customers until the switch is on | Off | 🟢 |
| D4 | **GST registration** | When registered, share the GSTIN; the GST switch is already built in | Off | 🟢 |

---

## 4. Brand & content

| # | Item | Notes | Priority |
|---|---|---|---|
| C1 | **Logo, original file** (AI, PSD, SVG or high-resolution PNG) | The site uses a placeholder until then | 🟠 |
| C2 | **Poster, original high-resolution file** | The current copy is a low-resolution screenshot | 🟠 |
| C3 | **Product photos**, ideally one per item on a plain background | Otherwise cups are cropped from the poster as placeholders | 🟠 |
| C4 | **Menu card**: every item, size, price, add-on | You can also type it straight into Admin → Menu once it's live | 🔴 for the real menu (a demo menu is used until then) |

---

## 5. Equipment

| # | Item | Recommendation | Priority |
|---|---|---|---|
| E1 | **80 mm thermal receipt printer** with **USB + LAN** | e.g. TVS RP 3230 / RP 3160 Gold (budget) or Epson TM-T82X (premium). Check local prices | 🟠 |
| E2 | **Counter tablet or PC** | Any recent Android tablet or Windows PC with Chrome | 🟠 |
| E3 | **Kitchen screen** | A tablet or TV with a browser, readable from 2 m | 🟠 |
| E4 | **Table QR standees** | Printed from Admin → QR codes (A6 size). Print them only **after the domain (A5) is final**: the web address is inside each QR code | 🟠 |
| E5 | **Set the counter PC's default printer to the thermal printer** | Then "Print receipt" / "Reprint KOT" print in one click | 🟠 |

---

## 6. After launch (Phase 2)

| # | Item | Why | Priority |
|---|---|---|---|
| L1 | **DLT registration** for SMS (Jio/Airtel/Vi portal) + an SMS provider (MSG91 or 2Factor) | Needed for SMS OTP. It closes the last token-fraud gap and allows the first-order offer | 🟢 (first thing after launch) |
| L2 | **WhatsApp Business API** (Meta-verified) | Only if you want WhatsApp order notifications | 🟢 |

---

## 6b. Before the first customer scans a code
| # | What | Why |
|---|---|---|
| G1 | Developer works through [docs/GO-LIVE.md](GO-LIVE.md) with you | Accounts, deployment, scheduled jobs, and the security checklist |
| G2 | You try the test-mode run in §5 of that document (10 minutes, with the developer) | You see money, refunds and rewards behave before real customers do |
| G3 | Razorpay **live** keys are switched on last | Everything is proven in test mode first |

## 7. What happens once section 1 is done

The developer connects the website to your accounts (about an hour, following
[IMPLEMENTATION-NOTES.md](IMPLEMENTATION-NOTES.md)). Then you test each milestone on your own phone
using the short scripts in [PHASE-9-TESTING.md §6](PHASE-9-TESTING.md).
