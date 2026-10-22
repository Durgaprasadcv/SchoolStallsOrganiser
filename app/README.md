# Stall Day app

React + Vite + TypeScript on Supabase. Built from the prototype in `../Stall App.dc.html`; schema in `../schema.sql`.

**Done:** customer app (`/:slug`, `/:slug/s/:stallId`, cart, UPI pay, token, My orders, Lost & found, donate), token board (`/:slug/board`),
stall owner / helper app (`/:slug/owner`: PIN login, join with invite code, orders, items & combos, cash sales, sales & settle-up, end-of-day match-up, stall setup, helpers),
admin panel (`/:slug/admin`: live totals, Excel exports, school % per stall, causes, settle-ups, WhatsApp templates, Lost & found, invite code, invites, PIN resets).
**Next:** Web Push, nightly backup, PWA offline.

## One-time Supabase setup (free tier)
1. Create a project at supabase.com (region: Mumbai).
2. SQL editor → paste all of `../schema.sql` → Run. It creates the demo fair (slug `schoolfair`), so `/schoolfair` works straight away.
3. Authentication → Sign In / Providers → turn on **Allow anonymous sign-ins** (customers sign in without a password).
4. Authentication → Rate Limits → raise **anonymous sign-ins** from 30/hour to ~1000/hour. The whole fair shares the school Wi-Fi IP, so the default would lock out parents after the 30th phone.
5. Project settings → API → copy the URL and the `anon` key into `app/.env.local` (see `.env.example`).
6. Deploy the stall login function (needs the [Supabase CLI](https://supabase.com/docs/guides/cli)), from the repo root:
   ```
   supabase login
   supabase link --project-ref <your-project-ref>
   supabase secrets set STAFF_EMAIL=you@gmail.com
   supabase functions deploy stall-auth --no-verify-jwt
   ```
   `STAFF_EMAIL` is any real inbox: each stall/helper login becomes a hidden auth user `you+owner-<id>@gmail.com`.
   Nothing is ever sent there — the function makes the sign-in link and uses it itself.
7. Admin login: Authentication → Users → **Add user** (email + password, tick *Auto confirm*), then in the SQL editor:
   ```sql
   update auth.users set raw_app_meta_data = raw_app_meta_data || jsonb_build_object('app_role', 'admin',
     'fair_id', (select id from fairs where slug = 'schoolfair')) where email = 'you@example.com';
   ```
   Sign in at `/schoolfair/admin`. Change the demo invite code (`FAIR24`) there before sharing the link.

## Run
```
cd app
npm install
npm run dev        # http://localhost:5173/schoolfair
```

## Deploy (Cloudflare Pages, free)
Connect the GitHub repo → root directory `app`, build command `npm run build`, output `dist`, add the two `VITE_SUPABASE_*` variables.
`public/_redirects` sends every route to the app. Each stall QR encodes `https://<your-domain>/<slug>/s/<stallId>`.

## How payment works
Picking a UPI app places the order first (status *Check payment*, stock reserved) so the real token can go in the UPI note.
The customer then taps **Open Google Pay** (browsers only open another app from a tap). *Cancel payment* cancels the order and puts the stock back.
The owner confirms the money arrived before preparing.

## Stall logins
Phone + 4-digit PIN, checked in Postgres (`pin_check`: bcrypt, 5 wrong tries → 10-minute lock). New stalls join with the
admin's invite code (`join_stall`). Helpers are added by the owner with their own PIN and see only Orders and Cash; removing a
helper cuts their access immediately. Owner and customer sessions are stored separately, so one phone can be both.
