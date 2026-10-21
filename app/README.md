# Stall Day app

React + Vite + TypeScript on Supabase. Built from the prototype in `../Stall App.dc.html`; schema in `../schema.sql`.

**Done:** customer app (`/:slug`, `/:slug/s/:stallId`, cart, UPI pay, token, My orders, Lost & found, donate) and the token board (`/:slug/board`).
**Next:** owner/helper app (`/:slug/owner`), admin (`/:slug/admin`), Web Push, nightly backup, PWA offline.

## One-time Supabase setup (free tier)
1. Create a project at supabase.com (region: Mumbai).
2. SQL editor → paste all of `../schema.sql` → Run. It creates the Greenfield demo fair, so `/greenfield` works straight away.
3. Authentication → Sign In / Providers → turn on **Allow anonymous sign-ins** (customers sign in without a password).
4. Authentication → Rate Limits → raise **anonymous sign-ins** from 30/hour to ~1000/hour. The whole fair shares the school Wi-Fi IP, so the default would lock out parents after the 30th phone.
5. Project settings → API → copy the URL and the `anon` key into `app/.env.local` (see `.env.example`).

## Run
```
cd app
npm install
npm run dev        # http://localhost:5173/greenfield
```

## Deploy (Cloudflare Pages, free)
Connect the GitHub repo → root directory `app`, build command `npm run build`, output `dist`, add the two `VITE_SUPABASE_*` variables.
`public/_redirects` sends every route to the app. Each stall QR encodes `https://<your-domain>/<slug>/s/<stallId>`.

## How payment works
Picking a UPI app places the order first (status *Check payment*, stock reserved) so the real token can go in the UPI note.
The customer then taps **Open Google Pay** (browsers only open another app from a tap). *Cancel payment* cancels the order and puts the stock back.
The owner confirms the money arrived before preparing.
