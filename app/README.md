# Stall Day app

React + Vite + TypeScript on Supabase. Built from the prototype in `../Stall App.dc.html`; schema in `../schema.sql`.

**Done:** customer app (`/:slug`, `/:slug/s/:stallId`, cart, UPI pay, token, My orders, Lost & found, donate), token board (`/:slug/board`),
stall owner / helper app (`/:slug/owner`: PIN login, join with invite code, orders, items & combos, cash sales, sales & settle-up, end-of-day match-up, stall setup, helpers),
admin panel (`/:slug/admin`: live totals, Excel exports, school % per stall, causes, settle-ups, WhatsApp templates, Lost & found, invite code, invites, PIN resets),
Web Push ("New order" for owners, "Order ready" for customers), 9 pm CSV backup, installable PWA that opens offline.

## One-time Supabase setup (free tier)
1. Create a project at supabase.com (region: Mumbai).
2. SQL editor → paste all of `../schema.sql` → Run. It creates the demo fair (slug `schoolfair`), so `/schoolfair` works straight away.
3. Authentication → Sign In / Providers → turn on **Allow anonymous sign-ins** (customers sign in without a password).
4. Authentication → Rate Limits → raise **anonymous sign-ins** from 30/hour to ~1000/hour. The whole fair shares the school Wi-Fi IP, so the default would lock out parents after the 30th phone.
5. Project settings → API → copy the URL and the `anon` key into `app/.env.local` (see `.env.example`).
6. Deploy the stall login function (needs the [Supabase CLI](https://supabase.com/docs/guides/cli)), from the repo root:
   ```
   supabase login
   supabase link --project-ref ebiqogpviaiqzbzkdvfw
   supabase secrets set STAFF_EMAIL=durgaprasad57@gmail.com
   supabase functions deploy stall-auth --no-verify-jwt
   ```
   `STAFF_EMAIL` is any real inbox: each stall/helper login becomes a hidden auth user `you+owner-<id>@gmail.com`.
   Nothing is ever sent there — the function makes the sign-in link and uses it itself.
7. Admin login: Authentication → Users → **Add user** (email + password, tick *Auto confirm*), then in the SQL editor:
   ```sql
   update auth.users set raw_app_meta_data = raw_app_meta_data || jsonb_build_object('app_role', 'admin',
     'fair_id', (select id from fairs where slug = 'schoolfair')) where email = 'durgaprasad57@gmail.com';
   ```
   Sign in at `/schoolfair/admin`. Change the demo invite code (`FAIR24`) there before sharing the link.
8. **Push notifications** (optional — without them the in-app banners and WhatsApp links still work):
   ```
   npx web-push generate-vapid-keys            # gives a public and a private key
   supabase secrets set VAPID_PUBLIC_KEY=BPP1JO5bRrsBKfW4fYnaQ4HukUWn8OcOmXfwmIm8bwxYClpV-NZGL0XFCdpdBuo2B9Xeb6x-WuNOXYWmWrMiq3U VAPID_PRIVATE_KEY=A1WqlPHNVD_6Dxw0HJPSMMW0t_7tESNSJ84EaaHBbZA VAPID_SUBJECT=mailto:durgaprasad57@gmail.com
   supabase functions deploy push-notify
   ```
   Put the same public key in `VITE_VAPID_PUBLIC_KEY` (`.env.local` and the hosting settings).
   Then Dashboard → Database → **Webhooks** → Create: table `orders`, events *Insert* + *Update*, type *Supabase Edge Functions* → `push-notify`, and add the auth header with the service key.
   On iPhone, alerts only work after **Share → Add to Home Screen** (iOS 16.4+); Android Chrome works in the browser.
9. **Nightly backup:** `supabase functions deploy nightly-backup`, then Dashboard → Integrations → **Cron** → new job, schedule `30 15 * * *`
   (= 21:00 IST), calling the `nightly-backup` Edge Function with the service-key auth header. Files land in Storage → `backups/<slug>/<date>/`.
   To get the links by email, add a free [Resend](https://resend.com) key: `supabase secrets set RESEND_API_KEY=<key> ADMIN_EMAIL=you@gmail.com`
   (with Resend's test sender, mail only goes to the address you signed up to Resend with).

## Run
```
cd app
npm install
npm run dev        # http://localhost:5173/schoolfair
```

## Deploy (Cloudflare Pages, free)
Connect the GitHub repo → root directory `app`, build command `npm run build`, output `dist`, add the `VITE_SUPABASE_*` (and `VITE_VAPID_PUBLIC_KEY`) variables.
Cloudflare Pages serves `index.html` for every route by itself (there's no `404.html`). On Netlify instead, add `public/_redirects` with `/*  /index.html  200`.
Each stall QR encodes `https://<your-domain>/<slug>/s/<stallId>`.

## Weak Wi-Fi & installing
The app is a PWA: after one visit it opens even with no signal and shows "No connection — waiting for Wi-Fi…", then picks up
by itself when the network is back. Orders, stock and payments are never served from cache, so nothing shown is stale.
Owners and the admin can add it to the home screen; the icon reopens the screen they installed it from.
Not built: queueing taps made while offline — an action without signal shows an error and can be tapped again.

## How payment works
Picking a UPI app places the order first (status *Check payment*, stock reserved) so the real token can go in the UPI note.
The customer then taps **Open Google Pay** (browsers only open another app from a tap). *Cancel payment* cancels the order and puts the stock back.
The owner confirms the money arrived before preparing.

## Stall logins
Phone + 4-digit PIN, checked in Postgres (`pin_check`: bcrypt, 5 wrong tries → 10-minute lock). New stalls join with the
admin's invite code (`join_stall`). Helpers are added by the owner with their own PIN and see only Orders and Cash; removing a
helper cuts their access immediately. Owner and customer sessions are stored separately, so one phone can be both.
