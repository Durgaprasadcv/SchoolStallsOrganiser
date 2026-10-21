import { createClient } from '@supabase/supabase-js';
import qrcode from 'qrcode-generator';

const URL_ = import.meta.env.VITE_SUPABASE_URL, KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const supabase = createClient(URL_, KEY);
// Stall owners/helpers get their own session store, so a parent who also runs a stall keeps both logins on one phone.
export const staff = createClient(URL_, KEY, { auth: { storageKey: 'stallday-staff' } });

type StallAuth = { access_token: string; refresh_token: string; kind: 'owner' | 'helper'; must_change: boolean; joined: boolean; error?: string };
export const stallAuth = async (body: Record<string, string>): Promise<StallAuth> => {
  try {
    const r = await fetch(`${URL_}/functions/v1/stall-auth`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: KEY, authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) });
    return await r.json();
  } catch { return { error: 'No connection — check your internet and try again.' } as StallAuth; }
};

// Phone photos are 3–10 MB; shrink to ≤800px WebP (JPEG where the browser can't encode WebP) before upload.
export const shrinkPhoto = async (file: File, max = 800): Promise<Blob> => {
  const bmp = await createImageBitmap(file), k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  const enc = (type: string) => new Promise<Blob | null>(res => c.toBlob(res, type, 0.8));
  const b = (await enc('image/webp')) || (await enc('image/jpeg'));
  if (!b) throw new Error('Could not read that photo');
  return b.type === 'image/webp' || b.type === 'image/jpeg' ? b : (await enc('image/jpeg'))!;
};

// ───────── types (mirror schema.sql) ─────────
export type Fair = { id: string; name: string; slug: string; school_upi: string; payment_check: 'owner' | 'customer' };
export type Stall = {
  id: string; fair_id: string; prefix: string; name: string; category: string; kind: 'food' | 'goods'; hours: string | null;
  owner_name: string; owner_role: string | null; upi_id: string | null; about: string | null; photo_path: string | null;
  cause_id: string | null; cut_pct: number; paused: boolean; pause_msg: string | null;
};
export type Item = {
  id: string; stall_id: string; name: string; note: string | null; price: number; stock: number; available: boolean;
  sizes: string[] | null; tags: string[]; photo_path: string | null; sort: number;
};
export type Combo = { id: string; stall_id: string; name: string; item_ids: string[]; price: number };
export type Line = { id?: string; item_id: string | null; combo_id: string | null; name: string; size: string | null; qty: number; price: number };
export type Status = 'verify' | 'hold' | 'pending' | 'ready' | 'done' | 'cancelled';
export type Order = {
  id: string; stall_id: string; token: string; customer_id: string | null; customer_name: string; customer_phone: string | null;
  status: Status; paid_by: string; total: number; donation: number; school_share: number; hold_until: string | null;
  created_at: string; order_lines?: Line[];
};
export type Notice = { id: string; fair_id: string; kind: 'Lost' | 'Found' | 'Notice'; text: string; by_name: string | null; open: boolean; created_at: string };
export type Templates = Record<'invite' | 'receipt' | 'ready' | 'reminder' | 'thankyou', string>;

export const DEFAULT_TEMPLATES: Templates = {
  invite: 'Hi {name}! 👋 You\'re invited to run a stall at the school fair.\n1. Open {link}\n2. Tap "Stall login" → "Join with invite code"\n3. Enter code {code}\nThen add your menu, photos and UPI ID. See you there!',
  receipt: 'Stall Day receipt 🧾\n{stall} · Token {token}\n{items}\nTotal ₹{total} ({paidBy})\n₹{schoolShare} goes to {cause}. Thank you!',
  ready: 'Hi {name}! Your order {token} at {stall} is ready — please collect it. 😊',
  reminder: 'Hi {owner}, thank you for running {stall}! The school\'s share is ₹{due}. Please pay to {schoolUpi} when you can. 🙏',
  thankyou: 'Thank you {owner}! {stall} raised ₹{raised} for {cause} today across {orders} orders. You made the fair special. — Greenfield PTA',
};

// ───────── helpers ─────────
export const PAID: Status[] = ['pending', 'ready', 'done'];
export const digits = (p: string | null | undefined) => (p || '').replace(/\D/g, '');
export const fill = (tpl: string, v: Record<string, string | number>) => tpl.replace(/\{(\w+)\}/g, (m, k) => (v[k] != null ? String(v[k]) : m));
export const lineLabel = (l: { name: string; size?: string | null }) => l.name + (l.size ? ` (${l.size})` : '');
export const time = (ts: string) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
export const photoUrl = (path: string | null) => (path ? supabase.storage.from('photos').getPublicUrl(path).data.publicUrl : '');
export const appUrl = (slug: string) => `${location.origin}/${slug}`;
export const stallUrl = (slug: string, id: string) => `${appUrl(slug)}/s/${id}`;
export const cutLine = (pct: number, cause: string) => (pct >= 100 ? `Every rupee goes to ${cause}` : `${pct}% of sales goes to ${cause}`);
export const menuLabel = (s: Stall) => (s.kind === 'food' ? 'Menu' : 'On sale');

export const wa = (phone: string | null, text: string) => `https://wa.me/${phone ? '91' + digits(phone).slice(-10) : ''}?text=${encodeURIComponent(text)}`;

// UPI deep links. App-specific schemes jump straight into that app; plain upi:// shows Android's chooser.
export const UPI_APPS = [
  { name: 'Google Pay', paidBy: 'GPay', scheme: 'tez://upi/pay' },
  { name: 'PhonePe', paidBy: 'PhonePe', scheme: 'phonepe://pay' },
  { name: 'Paytm', paidBy: 'Paytm', scheme: 'paytmmp://pay' },
  { name: 'Other UPI app', paidBy: 'UPI', scheme: 'upi://pay' },
] as const;
export const upiLink = (o: { pa: string; pn: string; am: number; tn: string }, scheme = 'upi://pay') =>
  `${scheme}?pa=${encodeURIComponent(o.pa)}&pn=${encodeURIComponent(o.pn)}&am=${o.am}&cu=INR&tn=${encodeURIComponent(o.tn)}`;

export const qrSvg = (text: string) => {
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  return 'data:image/svg+xml,' + encodeURIComponent(q.createSvgTag({ cellSize: 8, margin: 2 }));
};

export const TAGS: Record<string, [string, string]> = {
  veg: ['Veg', 'tag tag-accent-2'], vegan: ['Vegan', 'tag tag-accent-2'], jain: ['Jain', 'tag tag-accent-2'], egg: ['Contains egg', 'tag tag-accent'],
  nuts: ['Contains nuts', 'tag tag-accent'], dairy: ['Contains dairy', 'tag tag-accent'], gluten: ['Contains gluten', 'tag tag-accent'], spicy: ['Spicy', 'tag tag-outline'],
};
export const ALLERGENS = ['nuts', 'dairy', 'gluten', 'egg'];

export const statusInfo = (o: Order, kind: Stall['kind']): [string, string] => {
  const food = kind === 'food';
  return ({
    verify: ['Check payment', 'tag tag-accent'], hold: [`On hold till ${o.hold_until ? time(o.hold_until) : ''}`, 'tag tag-outline'],
    pending: [food ? 'Preparing' : 'Packing', 'tag tag-accent'], ready: [food ? 'Ready for pickup' : 'Ready to collect', 'tag tag-accent-2'],
    done: ['Collected', 'tag tag-neutral'], cancelled: [o.paid_by === 'Pay at stall' ? 'Released' : 'Cancelled', 'tag tag-neutral'],
  } as Record<Status, [string, string]>)[o.status];
};

// Postgres raise exception → words a parent understands
export const friendly = (e: { message?: string } | null) => {
  const m = e?.message || '';
  if (m.includes('out of stock')) return 'Something in your order just sold out — check the menu and try again.';
  if (m.includes('paused')) return 'This stall is back soon — ordering is paused for a few minutes.';
  if (m.includes('Failed to fetch') || m.includes('NetworkError')) return 'No connection — check your internet and try again.';
  return m || 'Something went wrong — please try again.';
};
