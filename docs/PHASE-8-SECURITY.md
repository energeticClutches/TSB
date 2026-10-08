# The Slush Bar — Phase 8: Security Plan

**Status:** ✅ Approved by owner 2026-09-21 · **Date:** 2026-09-21 · Builds on Phases [1](PHASE-1-REQUIREMENTS.md)–[7](PHASE-7-API.md)

> **Amended 2026-09-22 — the token scheme changed.** On the owner's instruction, redeemable reward
> tokens were replaced by the **Lucky Draw**: a mobile number's spending (excluding GST) adds up across
> every order, and at ₹2,000 it earns **one** numbered token (`SLB-001`…`SLB-500`) that is a draw entry,
> never spent. Anything below about earning, approving, redeeming, expiring or owing tokens is
> **superseded** by “Lucky Draw tokens” in [REQUIREMENTS.md](REQUIREMENTS.md); the rest of this
> document still stands. What was actually built is in
> [IMPLEMENTATION-NOTES.md](IMPLEMENTATION-NOTES.md).


This document pulls together every security control into one plan. Fraud controls are detailed in [Phase 4 §8–§12](PHASE-4-DATABASE.md); they're referenced here, not repeated.

---

## 1. What we're protecting
| Asset | Why it matters | Worst case if lost |
|---|---|---|
| **Money flow** (Razorpay account, refunds) | Direct financial loss | Fake "paid" orders, refunds abused |
| **Token balances** | They are a liability worth real money | Free products given away at scale |
| **Customer data** (names, mobiles, delivery addresses, UPI IDs) | Legal duty under India's **DPDP Act 2023**; trust | Leak → legal exposure + reputation |
| **Menu & prices** | Wrong prices = losses | Items sold at ₹1 |
| **Staff & Owner accounts** | They unlock everything above | Full takeover |
| **Audit trail** | Proof of what happened | Fraud can't be proven |
| **Availability** at rush hour | Lost sales | Nobody can order 6–9 PM |

## 2. Who might attack
Opportunistic customers (price/payment/token tricks) · dishonest staff or ex-staff · automated bots (spam, credential stuffing) · someone who steals a phone/tablet or a password · a leaked secret key.

---

## 3. Controls by layer

### 3.1 Identity & access
| Control | Detail |
|---|---|
| **Owner/Manager login** | Email + password (min 12 characters, checked against known-breached passwords) through Supabase Auth |
| **2FA** | **Required for Owner** (authenticator app), recommended for Managers. Recovery codes are printed once and kept in the shop safe |
| **Step-up re-authentication** | Changing settings, staff, payment mode, approving an Owner request or a refund over the limit asks for the **2FA code again** if the last one was > 15 min ago |
| **Shop devices** | Paired with a one-time code (API-5); the device secret sits in an HttpOnly cookie; PIN only works on paired devices |
| **PINs** | 4 digits, unique per branch, weak ones refused, hashed (never stored readably), 5 wrong → 15 min lock |
| **Sessions** | Shop devices: **lock after 5 min idle** (tap name + PIN to resume), 12 h max. Owner/Manager: 7 days with refresh; "sign out everywhere" button |
| **Least privilege** | Four roles (Phase 6 §3). Kitchen can't see prices or phone numbers. Cashier can't change prices, settings or approve their own requests |
| **Enforced twice** | Role checks in the database functions **and** row-level security (RLS) on every table, so a bypassed or buggy screen still can't read or write what the role mustn't |
| **Offboarding** | Deactivating a staff member instantly revokes all their sessions. Checklist in §7 |

### 3.2 Application security (OWASP Top 10 mapping)
| Risk | Control |
|---|---|
| Broken access control / IDOR | RLS on all tables; customers only reach orders by an unguessable 32+ character `public_token`; internal IDs never exposed; "not found" instead of "forbidden" where needed |
| Injection | No hand-built SQL; only parameterised queries and database functions; all input validated against strict schemas (types, lengths, ranges, enums) **on the server** |
| XSS | React escapes output by default; the order note and names are stored as plain text, length-limited, control characters stripped, **never rendered as HTML**; strict Content-Security-Policy (§3.4) |
| CSRF | Staff APIs use bearer tokens (not cookies). The device cookie is `SameSite=Strict`, `__Host-` prefixed, and useless without the PIN |
| Security misconfiguration | Security headers on every response (§3.4); no debug output in production; Supabase anonymous role can **only** call the public functions it needs |
| Vulnerable components | Locked dependency versions, automated dependency alerts (Dependabot) and `npm audit` in CI; no scripts from random CDNs (the Stitch prototype's Tailwind CDN script is **not** carried over) |
| Authentication failures | §3.1 |
| Data integrity failures | Webhook signatures, hash-chained audit log & token ledger, signed token QR codes, GitHub Actions pinned to exact versions |
| Logging failures | §3.6 |
| SSRF | The server only calls fixed hosts (Razorpay, Turnstile, R2); no user-supplied URLs are ever fetched |

### 3.3 Payment security
- **No card or bank data ever touches our systems.** Razorpay's hosted checkout handles it, so we stay outside PCI-DSS scope (only Razorpay's standard merchant attestation is needed).
- **Order amounts are set only by the server** when the Razorpay order is created; the browser can't change them.
- **Paid = signed webhook or a server-to-Razorpay check.** Screenshots and browser "success" callbacks are never enough (FR-16, API-4).
- **Refunds only go back to the original payer** (a Razorpay rule) and need maker–checker approval.
- **Live keys go in only at M6**, after the full test pass. Test and live keys are never in the same environment.
- **Razorpay dashboard:** Owner account with 2FA; developer has a separate, limited team login; webhook secret is different from the API secret.

### 3.4 Browser & network hardening
| Header / setting | Value (summary) |
|---|---|
| HTTPS | Everywhere, TLS 1.2+ (1.3 preferred) via Cloudflare; **HSTS** with preload |
| Content-Security-Policy | Scripts only from our own domain + `checkout.razorpay.com` + `challenges.cloudflare.com`; frames only Razorpay + Turnstile; images from our CDN + map tiles; `frame-ancestors 'none'`; no inline scripts |
| Referrer-Policy | `strict-origin-when-cross-origin`; **`no-referrer` on the tracker**, so the private order link is never leaked to other sites |
| Other | `X-Content-Type-Options: nosniff`, `Permissions-Policy` (location only on the customer app, only when choosing a delivery pin; camera only on admin for token QR scans) |
| Cloudflare | Bot Fight Mode, WAF managed rules (free tier), a rate-limit rule on `/v1/checkout` and `/v1/auth/*`, DNSSEC on the domain |
| Admin app | Separate subdomain, `noindex`, no public links to it; admin code is never shipped in the customer app |

### 3.5 Data protection & privacy (DPDP Act 2023)
| Topic | Plan |
|---|---|
| **Collect only what's needed** | Name + mobile (orders & tokens), address + pin (delivery only), UPI ID (hashed + masked, fraud prevention). No email, no birthday, no marketing profile |
| **Notice** | A one-line notice under the Pay button: "We use your name and mobile to prepare your order and track your rewards. [Privacy]". A short privacy page on the site |
| **No marketing without opt-in** | Notifications are deferred; when added, promotional messages need a separate opt-in checkbox |
| **Masking** | Mobiles masked in admin by default; revealing one is logged. Kitchen never sees them. Customers see only masked data on the tracker |
| **Hashing** | UPI IDs, device IDs and blocked identities are stored as keyed hashes (HMAC with a secret "pepper") |
| **Encryption** | In transit: TLS. At rest: Supabase/R2 encrypt storage by default. 2FA secrets encrypted at the app level. Backups encrypted before upload (§3.7) |
| **Retention** | Customer name/mobile/address are **anonymised after 3 years of inactivity**. Order and payment records are kept as long as Indian tax/accounting rules require (typically **6–8 years**; **confirm with your CA**). Webhook payloads 180 days. Server logs 30 days. Audit log & token ledger: permanent (they hold no raw mobiles) |
| **Deletion requests** | Owner can anonymise a customer from the Admin (name/mobile/address replaced; financial totals kept; unused tokens forfeited, with the customer told first) |
| **Grievance contact** | An email/phone on the privacy page (to be filled in when business contacts are given) |

### 3.6 Logging & monitoring
- **What's logged:** every request id, endpoint, status, timing, role. Security events: failed logins/PINs, lockouts, permission denials, webhook signature failures, rate-limit hits, fraud flags.
- **Never logged:** PINs, passwords, 2FA codes, full mobiles, UPI IDs, Razorpay secrets, session tokens. Logs are scrubbed automatically before they reach Sentry.
- **Alerts (email to Owner + developer):** site down (UptimeRobot), error spike (Sentry), webhook failures, reconciliation mismatch, audit-chain break, 10+ failed Owner logins in an hour, a new device paired.
- **Owner dashboard:** "Security" card shows the last reconciliation, audit-chain status, active devices, and open flags.

### 3.7 Secrets & keys
| Secret | Lives in | Who can see it | Rotation |
|---|---|---|---|
| Razorpay key secret | Supabase function secrets | Nobody after entry | Yearly, and at once if suspected |
| Razorpay webhook secret | Supabase function secrets | Nobody after entry | Yearly |
| Supabase service key | Supabase function secrets only (never in an app) | Nobody after entry | On any suspicion |
| Token-QR signing key | Function secrets, versioned (`sig_version`) | Nobody | Yearly (old QR codes stay valid until they expire) |
| Hashing pepper | Function secrets | Nobody | Never rotated casually (would break matching); only on compromise, with re-hash |
| Turnstile, R2, Resend keys | Function secrets / CI secrets | Nobody after entry | Yearly |
| **Backup encryption key** | **Offline**: printed/USB copy with the Owner + one with the developer | Owner, developer | On developer change |

- Secrets are **never** in the code, the repository, the apps or chat messages. CI blocks any commit containing a secret (secret scanning).
- **Account ownership:** the **Owner owns** the Supabase, Cloudflare, Razorpay, GitHub, Sentry and domain accounts, with 2FA on all of them. The developer is **invited as a team member**. Passwords are never shared.

### 3.8 Availability & recovery
- CDN-served menu keeps working even if the database is down (Phase 5 §8).
- Nightly encrypted backups (30 days) + a monthly automated restore test.
- A staff card at the counter: "If the ordering system is down: take orders at the counter, note them on paper, tell the Owner."

---

## 4. Security built into the process
| When | What |
|---|---|
| Every code change | Type checks, lint, unit + database tests (incl. **RLS tests for every role**), dependency audit, secret scan |
| Every milestone (on staging) | Role-by-role check: each role tries every screen/API it shouldn't have → must fail |
| Before go-live (M6) | Full checklist below + automated **OWASP ZAP** baseline scan + manual tests of every fraud case in Phase 4 §8 + Razorpay test-mode run of all payment/refund/dispute paths |
| Monthly | Dependency updates, restore test, review of active devices/staff, review of Risk screen trends |
| Yearly | Key rotation, access review, optional paid external penetration test once revenue justifies it |

### Go-live security checklist (all must pass)
- [ ] 2FA on Owner in the app **and** on Supabase, Cloudflare, Razorpay, GitHub, domain registrar
- [ ] Anonymous database role can only call the public functions; RLS on for **every** table (automated check)
- [ ] Every role tested against every staff API (automated)
- [ ] Webhook: bad signature rejected; replay ignored; amount mismatch held
- [ ] Security headers score A on securityheaders.com; CSP has no `unsafe-inline` for scripts
- [ ] No secrets in the repository history; test keys removed from production
- [ ] Rate limits and Turnstile active on checkout / find-order / PIN login
- [ ] Backup restored successfully from R2 within the last 7 days
- [ ] Privacy page and checkout notice live
- [ ] All staff PINs set, weak-PIN rule on, shop devices paired, lost-device procedure explained to the Owner

---

## 5. Incident response (one-page runbook for the Owner)
| Situation | Do immediately | Then |
|---|---|---|
| **Phone/tablet stolen** | Admin → Devices → **Revoke**. If it was the Owner's phone: sign out everywhere, reset password, re-enrol 2FA using recovery codes | Review the audit log for that device |
| **Staff member leaves** | Deactivate them (sessions end instantly) | If they knew any shared account password (they shouldn't), change it |
| **Suspicious refunds/tokens** | Risk screen → freeze customer / block identity; switch refunds to Owner-only (setting) | Review the audit log; the evidence is tamper-evident |
| **Payments not matching** | Check the Risk screen's reconciliation card; Razorpay dashboard is the source of truth for money | Developer investigates the webhook logs |
| **Secret key may have leaked** | Developer rotates the key (Razorpay/Supabase) within the hour | Check Razorpay for unknown refunds/transfers |
| **Customer data may have leaked** | Contain (revoke keys/sessions), preserve logs | DPDP Act requires notifying the Data Protection Board and affected customers. Get legal advice |
| **Site down at rush hour** | Take counter orders on paper | UptimeRobot/Sentry alert tells the developer |

---

## 6. Residual risks (accepted, known)
| Risk | Why accepted | Plan |
|---|---|---|
| Tokens tied to an unverified mobile (no OTP) | Budget + DLT setup | Mitigations in Phase 4 §9.4; **SMS OTP first after launch** (R10) |
| Up to 24 h of data loss in a disaster (free tier) | Budget | Razorpay records + reconciliation rebuild paid orders; upgrade trigger in Phase 5 |
| Someone with a shared tracker link can see the order or cancel it while pending | The link is the customer's receipt; cancelling only refunds the original payer | Masked personal data on the tracker |
| A dishonest cashier who also controls the customer's phone | Requires collusion | Per-staff monitoring and fraud rules |

## 7. Staff security basics (printed for the counter)
1. Never share your PIN. Your name is on everything you do.
2. Lock the screen (tap your name) when you step away. It locks itself after 5 minutes.
3. Before accepting a token order, **check the customer's phone number on their own phone**.
4. Never accept "I paid, here's a screenshot". Only a green **Paid** on the board counts.
5. Report anything odd to the Owner.

---

## 8. Decisions (all approved 2026-09-21)
- **S1** **You (the Owner) own every account** (Supabase, Cloudflare, Razorpay, GitHub, domain, Sentry) with 2FA; developers are invited, never given your passwords.
- **S2** **Step-up 2FA** for sensitive actions (settings, staff, payment mode, big approvals).
- **S3** **Shop devices lock after 5 min idle**; sessions last 12 h.
- **S4** **Privacy:** checkout notice + privacy page; anonymise inactive customers after **3 years**; keep financial records per your CA's advice (6–8 years).
- **S5** **Strict browser security policy.** Only Razorpay and Turnstile may run outside scripts on our pages.
- **S6** **Security gates:** automated checks on every change, a role-by-role check each milestone, and the go-live checklist must pass fully before Razorpay goes live.
- **S7** **Backup key held offline** by you and the developer.
- **S8** **Accept the residual risks in §6**, with OTP as the first improvement after launch.
