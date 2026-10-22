// Web Push for Stall Day, called by a Database Webhook on `orders` (INSERT + UPDATE).
//   new customer order        → every phone logged in to that stall: "New order — KOT"
//   status becomes 'ready'    → that customer's phones: "Your order is ready"
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:you@example.com). Deploy: supabase functions deploy push-notify
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT') || 'mailto:admin@example.com', Deno.env.get('VAPID_PUBLIC_KEY')!, Deno.env.get('VAPID_PRIVATE_KEY')!);
const ok = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

type O = { id: string; stall_id: string; token: string; customer_id: string | null; customer_name: string; status: string; total: number };

Deno.serve(async req => {
  const { type, record: o, old_record: old } = (await req.json()) as { type: string; record: O; old_record: O | null };
  if (!o?.customer_id) return ok({ skipped: 'cash sale' });   // walk-up cash: nobody to tell

  const isNew = type === 'INSERT', isReady = type === 'UPDATE' && o.status === 'ready' && old?.status !== 'ready';
  if (!isNew && !isReady) return ok({ skipped: type });

  const { data: st } = await db.from('stalls').select('name, fairs(slug)').eq('id', o.stall_id).single();
  const slug = (st?.fairs as unknown as { slug: string } | null)?.slug || '';
  const msg = isNew
    ? { subject: `stall:${o.stall_id}`, title: o.status === 'hold' ? 'New hold request' : 'New order — KOT', body: `${o.token} · ${o.customer_name} · ₹${o.total}`, url: `/${slug}/owner/o/${o.id}` }
    : { subject: `customer:${o.customer_id}`, title: 'Your order is ready', body: `Token ${o.token} — collect at ${st?.name || 'the stall'}`, url: `/${slug}/o/${o.id}` };

  const { data: subs } = await db.from('push_subscriptions').select('id, endpoint, keys').eq('subject', msg.subject);
  const payload = JSON.stringify({ title: msg.title, body: msg.body, url: msg.url, tag: `${o.id}-${o.status}` });
  let sent = 0;
  await Promise.all((subs || []).map(s => webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, { TTL: 900, urgency: 'high' })
    .then(() => { sent++; })
    .catch(async (e: { statusCode?: number; body?: string; message?: string }) => {
      if (e.statusCode === 404 || e.statusCode === 410) await db.from('push_subscriptions').delete().eq('id', s.id);   // phone unsubscribed
      else console.error('push failed', e.statusCode, e.body || e.message);
    })));
  return ok({ subject: msg.subject, sent, of: subs?.length || 0 });
});
