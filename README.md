# Handoff: Stall Day — school fair stall app

> **Status:** the real app is built in [`app/`](app/README.md) (React + Vite + Supabase) — customer app, token board, stall owner/helper app,
> admin panel, Web Push, the 9 pm backup and offline start. Setup, deploy and run steps are in **[app/README.md](app/README.md)**.
> Not built: retrying taps made while offline (they show an error and can be tapped again).
> This file is the original design brief; where it differs from what was built, the notes below say so.

## Overview
A web app for a school charity fair. Parents run stalls (food, clothes, crafts, anything). Customers scan a stall QR, order, pay the owner directly by UPI, get a token, and get pinged when it's ready. Owners manage orders, stock, cash sales and helpers. A school admin sees live totals, sets the school's share per stall, collects settle-ups, posts lost & found, and exports everything to Excel.

**Hard constraint: near-zero running cost.** No payment gateway, no SMS/OTP, no paid WhatsApp API. It's for a charity and it's a bookkeeping tool.

## About the design files
`Stall App.dc.html` is a **design reference built in HTML** — a working, clickable prototype showing intended look and behaviour with all state held in memory. Do **not** ship it. Recreate it as a real app (recommended stack below). Open it in a browser (keep `support.js` and `_ds/` beside it) to click through every flow; the customer phone, owner phone, admin panel and token board are all live on one page and talk to each other.

Demo logins inside the prototype (the real app's demo stalls use the same phones/PINs; its admin is a Supabase user — see app/README): owner `98450 11111` / PIN `1111` (also 22222/2222, 33333/3333), helper `98450 44444` / `4444`, admin password `fair2024`, stall invite code `FAIR24`.

## Fidelity
**High-fidelity.** Colours, type, radii, spacing and copy are final. Recreate the UI closely, mobile-first (customer + owner screens are designed at 360px wide).

---

## Recommended stack (all free tiers)
| Need | Use | Why |
|---|---|---|
| Frontend | React + Vite (or Next.js static export), PWA | Installable from the browser, no app store |
| Hosting | Cloudflare Pages / Netlify / Vercel free | Free HTTPS + custom domain |
| Database + realtime | **Supabase** free tier (Postgres + Realtime + Storage) | Orders appear on owner phone instantly; one school fair is far under limits |
| Photos | Supabase Storage, resize to ≤800px WebP client-side before upload | Keeps under 1 GB free storage |
| Push notifications | Web Push (VAPID) via a Supabase Edge Function | Free; "New order" for owners, "Order ready" for customers |
| QR codes | `qrcode-generator` (client-side SVG) | No service needed |
| WhatsApp | `https://wa.me/91<number>?text=<encoded>` links | Free; a human taps Send |
| UPI | `upi://pay?pa=<upi>&pn=<name>&am=<amount>&cu=INR&tn=<note>` deep link | Money goes straight to owner; zero fees |
| Excel export | Client-side CSV with UTF-8 BOM (`\ufeff`) | Opens correctly in Excel incl. ₹ |

Alternative: Firebase (Firestore + Hosting + FCM) works equally well if the developer prefers it.

---

## Before going live — the six must-dos

### 1. Save data online
Supabase tables (Postgres). **Built:** the real schema is [`schema.sql`](schema.sql) — it adds `fairs.slug`, `fairs.payment_check`, PIN lockout columns, frozen `orders.school_share` and more. The sketch below was the starting point:

```sql
fairs(id, name, school_upi, invite_code, admin_email, created_at)
causes(id, fair_id, name)
stalls(id, fair_id, prefix char(1), name, category, kind 'food'|'goods', hours, owner_name, owner_role,
       phone, pin_hash, upi_id, about, photo_url, cause_id, cut_pct int, paused bool, pause_msg,
       closeout jsonb, created_at)
helpers(id, stall_id, name, phone, pin_hash)
items(id, stall_id, name, note, price int, stock int, available bool, sizes text[], tags text[], photo_url, sort)
combos(id, stall_id, name, item_ids uuid[], price int)
customers(id, fair_id, name, phone, created_at)              -- no password
orders(id, stall_id, token text, customer_id null, customer_name, customer_phone,
       status 'verify'|'hold'|'pending'|'ready'|'done'|'cancelled',
       paid_by 'GPay'|'PhonePe'|'Paytm'|'UPI'|'Cash'|'Pay at stall',
       total int, donation int, hold_until timestamptz, taken_by_helper uuid null, created_at)
order_lines(id, order_id, item_id null, combo_id null, name, size, qty, price)
settlements(id, stall_id, amount int, method 'UPI'|'cash', created_at)
donations(id, fair_id, name, amount int, created_at)          -- direct-to-school
notices(id, fair_id, kind 'Lost'|'Found'|'Notice', text, by_name, by_phone, open bool, created_at)
templates(fair_id, key 'invite'|'receipt'|'ready'|'reminder'|'thankyou', body)
```
- Tokens: `<stall prefix>-<2-digit running number per stall>` (A-01, A-02…). Generate inside a Postgres function in one transaction so two phones can't get the same token.
- Stock: decrement in the same transaction as order insert (combos decrement each part). Restore on hold release/cancel. Reject the order if any stock would go below 0.
- Amounts are whole rupees (int).

### 2. Live updates across phones
- Owner orders screen subscribes to Supabase Realtime on `orders where stall_id = X`. New row → in-app banner "New order — KOT" + Web Push if app is in background.
- Customer "My orders" subscribes to their own orders. Status → `ready` → banner "Your order is ready" + Web Push.
- Token board (`/:slug/board` page for a TV/laptop) runs signed out, so it can't read or subscribe to `orders`. It **polls** the `board_tokens` view (no phone numbers) and `notices_public` every ~5 s, filtered by `fair_id`. Realtime can't stream views, and a 5 s delay is fine for a pickup screen.
- Customer stall list / menu: customers can't read `stalls` (RLS), so Realtime on it never reaches them. Re-fetch `stalls_public` every ~15 s and on tab focus to show/clear the "Back soon" banner. `place_order` rejects paused stalls server-side, so a stale banner can't let an order through — show its error as "Back soon".
- Expired holds: call `supabase.rpc('release_expired_holds')` when the stall menu and owner Orders screen load (granted to everyone; it only releases holds past `hold_until` and puts the stock back). Optionally also run it every minute with pg_cron.
- Admin panel subscribes to orders, settlements, donations.
- Fallback if push permission is denied: the owner gets a one-tap **"Ready" on WhatsApp** link (already in design).

### 3. Hosting
- One deployed site, e.g. `https://<fair>.pages.dev` or a custom domain.
- Routes all start with the fair's `slug` (`fairs.slug`, e.g. `schoolfair`): `/:slug` (all stalls), `/:slug/s/:stallId` (stall menu — this is what each stall QR encodes), `/:slug/owner`, `/:slug/admin`, `/:slug/board`. This matches the prototype's `APP_URL + '/s/' + id`.
- The prototype's placeholder `APP_URL` (`https://stallday.app/greenfield`) is gone: the app builds QR codes, invite links and the price list from the address it's served on.

### 4. Privacy & security
- **Logins (free, no OTP):**
  - Customer: name + WhatsApp number, stored on the device (localStorage) + a `customers` row. No password.
  - Stall owner / helper: WhatsApp number + 4-digit PIN. Store a bcrypt/argon hash only. Rate-limit (5 tries → 10-minute lockout). Admin can reset to `0000`, which forces a change on next login.
  - New stalls join with the admin's invite code; code can be regenerated.
  - Admin: Supabase Auth email + password (free).
  - **Built:** the `stall-auth` Edge Function checks the PIN in Postgres and returns a real Supabase session (one hidden auth user per stall/helper, `app_role` + `stall_id` in `app_metadata`) — no hand-signed JWTs, refresh works normally.
- **Row Level Security:**
  - Customers can read stalls (via the `stalls_public` view, no phone/PIN columns), items, combos and open notices (via `notices_public`, no phone numbers), insert their own orders, and read only their own orders.
  - Owner reads/writes only their stall's rows; sees customer name + phone only on their own orders.
  - Helper: same stall, but **only** orders + cash sales; no items, sales totals, settings.
  - Admin reads everything for the fair.
- Customer phone numbers: never shown on the token board; auto-delete or anonymise 30 days after the fair (scheduled function).
- Show a one-line notice on the customer entry screen: number used only for this order's updates.

### 5. Backup
- Admin "Download all orders (Excel)" and "Stall summary (Excel)" are already designed — build them as client-side CSV (columns listed in the prototype's `exportOrders` / `exportStalls`).
- Plus a scheduled Edge Function at 9 pm on fair day that writes both CSVs to a Storage bucket and emails the admin the link.
- Supabase free tier has no point-in-time restore — the CSV snapshot is the backup.

### 6. Test run
**Supabase free projects pause after 7 days without use** (data is kept). 1–2 days before every fair and before the rehearsal: log in to the Supabase dashboard → project → **Resume**. Then open the app once to confirm it loads.

Run a 30-minute rehearsal with 2–3 stalls, ~10 parents:
- [ ] Supabase project resumed and app loads; `stall-auth` function deployed; admin can log in at `/<slug>/admin`.
- [ ] Scan each printed QR on Android + iPhone; menu opens.
- [ ] UPI deep link opens GPay, PhonePe, Paytm with amount + UPI ID filled.
- [ ] Owner confirms payment → Mark ready → customer gets push / banner.
- [ ] Two orders at the same second get different tokens.
- [ ] Stock hits 0 → item shows Sold out everywhere.
- [ ] Helper login can't open Items / Sales / Stall.
- [ ] Pause orders → customers can browse but not order.
- [ ] End-of-day match-up + settle-up + Excel export all add up.
- [ ] Weak school Wi-Fi: app still loads (PWA cache) and recovers when the signal is back; a failed tap shows an error and can be retried.
- [ ] Push: owner taps "Get new-order alerts", a test order buzzes their phone with the screen off; customer gets "Your order is ready".
- [ ] Backup: after 21:00 IST the day's CSVs are in Storage → `backups` (and in the admin's inbox if Resend is set up).

---

## Screens / views (see prototype for exact layout & copy)

**Customer (mobile)**
1. Entry (after scanning stall QR) — name, WhatsApp number → stall menu.
2. Stalls — list of stalls (photo/initial, category, hours, % to school, "Back soon" tag), Lost & found card + report form, "Just want to give?" donation card (₹20/50/100 → UPI to school).
3. Stall menu — stall photo, category, owner, cause line, "Back soon" banner when paused, allergy filter (food stalls: hide Nuts/Dairy/Gluten/Egg), Combos, items (photo, note, diet/allergy tags, price, "Only N left", size chips for clothes, Add / − qty +), sticky cart bar.
4. About the stall — owner photo/initial, role, about text, UPI ID, % + cause.
5. Cart — lines, total, "₹X goes to {cause}", optional extra donation (No thanks/₹10/₹20/₹50), Pay with UPI, and for non-food stalls "Hold for 15 min · pay at the stall".
6. Pay sheet — choose GPay / PhonePe / Paytm / Other → hand-off screen showing To, UPI ID, Amount, Note (token) → "Payment done".
7. Success — big token, queue position or hold time, receipt lines, Receipt on WhatsApp, Meet the owner, More stalls.
8. My orders — token, stall, status tag; "Not {name}?" to switch person.

**Stall owner (mobile)** — bottom nav: Orders · Items · Cash · Sales · Stall (helpers see only Orders · Cash)
1. Login / Join with invite code.
2. Orders — Pending / Ready / Done tabs (pending oldest first; new orders ringed), pause/resume orders, helper banner.
3. Order detail — token, status, customer name + tel link, Receipt / "Ready" WhatsApp links, items, actions by status: Payment received → Mark ready · notify → Handed over; holds: Paid cash · handed over / Release hold.
4. Items — combos manager, item list with photo, stock −/+, On sale/Hidden toggle, Edit; item editor (photo, name, description, food & allergy tags, price, stock, sizes for non-food).
5. Cash sale — tap items to add, Record ₹X cash.
6. Sales — total, UPI vs cash, To school / You keep, Settle with school (UPI link to school), End-of-day match-up (enter UPI app total + cash counted → matches / ₹ short / ₹ extra, note, Close the day), Thank-you card (share on WhatsApp), best sellers.
7. Stall — stall photo, name, category (Food/Clothes/Crafts/Other + free text), hours, UPI ID, owner name, role, about, cause picker, school share (read-only), real QR + download, Print price list, Helpers (add/remove with PIN), Log out.

**Admin (desktop/tablet)**
- Login · totals (sales, raised for school, orders, UPI/cash/donations, waiting) · Excel exports · per-stall table (school % −/+, cause, day-closed status) · Causes editor · Settle-ups (owed/received/pending, record UPI/cash, WhatsApp reminder + thank-you) · WhatsApp message templates (invite, receipt, ready, reminder, thank-you with `{placeholders}`) · Lost & found / announcements · Stall logins (invite code, invite by WhatsApp or copy for group, invite list with joined status, reset PIN).

**Token board (TV, `/:slug/board`)** — "Ready for pickup", fair QR, open notices as pills, per-stall ready tokens (large) and preparing list.

## Key business rules
- Payment check default: **owner confirms** UPI ("verify" status) before preparing. Configurable per fair (`fairs.payment_check`; no admin screen for it yet — change it in the Supabase table editor).
- **Built:** picking a UPI app places the order first (stock reserved, real token in the UPI note), then the customer taps "Open Google Pay". Backing out cancels the order and returns the stock.
- School share per order = `round((total − donation) × cut_pct / 100) + donation`. Direct donations count 100% to school.
- **Built:** the share is frozen on each order when it's placed, so an admin's school % change applies to new orders only (the prototype recalculated past orders).
- Sales totals count statuses pending, ready, done only (not verify, hold, cancelled).
- Settle-up due = school share − settlements received.
- End-of-day difference shown separately for UPI and cash.

## Design tokens (Organic design system — `_ds/.../styles.css`)
- Ground `#f5ead8`, surface `#ebddc5`, text `#201e1d`, accent (terracotta) `#c67139`, accent-2 (sage) `#7a8a5e`.
- Ramps used: neutral-300 `#dcd3c4`, neutral-400 `#c0b6a5`, neutral-700 `#645c50`; accent-100 `#fff2eb`, -200 `#ffe1d0`, -700 `#8c491a`, -800 `#643312`; accent-2-100 `#f0fae1`, -200 `#e1eecc`, -700 `#56633f`, -800 `#3d472b`, -900 `#272e1b`.
- Type: Caprasimo (headings, 400) over Figtree (body). Sizes used: 72/56/44/40/36/32/30/26/24/22 display; 18/17/16/15/14/13/12/11 body.
- Spacing: 4.4 / 8.8 / 13.2 / 17.6 / 26.4 / 35.2 px (`--space-1…8`).
- Radius: 8 / 16 / 28 px, pills 999px. Shadows `--shadow-sm/md/lg` (in stylesheet).
- Components: `.btn` (primary/secondary/ghost/icon/block), `.tag` (accent/accent-2/neutral/outline), `.input`, `.field`, `.card`, `.table` — all defined in `styles.css`.
- Icons: none used in the prototype; if added, Lucide at stroke-width 2.75.

## Assets
No bundled images. Stall and item photos are uploaded by owners. QR codes are generated at runtime.

## Files
- `app/` — the real app (see [app/README.md](app/README.md)).
- `supabase/functions/stall-auth/` — Edge Function for stall owner / helper PIN login and joining with the invite code.
- `schema.sql` — Supabase migration: tables, enums, RLS policies, `place_order` / `set_order_status` (atomic tokens + stock), PIN login functions, reporting views, realtime, photo storage policies, PII purge, keep-alive `ping()`, seed data matching the prototype, and an outline of the Edge Functions still to write.
- `Stall Day preview.html` — single self-contained file of the prototype; double-click to open, works offline.
- `screenshots/` — key screens and states.
- `Stall App.dc.html` — the full prototype (template + logic class at the bottom; the logic holds the data model, seed data, and every rule above).
- `support.js` — runtime needed to open the prototype locally.
- `_ds/organic-…/styles.css` + `_ds_bundle.js` — design system tokens and component classes.
