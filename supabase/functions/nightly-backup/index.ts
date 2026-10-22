// Nightly backup (Supabase free tier has no point-in-time restore — these CSVs are the backup).
// Run by Supabase Cron at 21:00 IST. For every fair with orders: writes orders.csv + stalls.csv to the private
// `backups` bucket at <slug>/<YYYY-MM-DD>/, and emails the admin 7-day download links when RESEND_API_KEY and
// ADMIN_EMAIL are set (Resend free tier; without them the files are still saved — Dashboard → Storage → backups).
// Same columns as the admin panel's Excel buttons. Deploy: supabase functions deploy nightly-backup
import { createClient } from 'npm:@supabase/supabase-js@2';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const PAID = ['pending', 'ready', 'done'];
const csv = (rows: unknown[][]) => '﻿' + rows.map(r => r.map(v => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; }).join(',')).join('\n');
const all = async (q: (a: number, b: number) => PromiseLike<{ data: any[] | null; error: unknown }>) => {   // Supabase caps at 1,000 rows
  const out: any[] = [];
  for (let a = 0; ; a += 1000) { const { data, error } = await q(a, a + 999); if (error) throw error; out.push(...data!); if (data!.length < 1000) return out; }
};
const ist = (ts: string) => new Date(ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
const sum = (xs: { total?: number; amount?: number }[]) => xs.reduce((a, x) => a + (x.total ?? x.amount ?? 0), 0);

Deno.serve(async () => {
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });   // YYYY-MM-DD
  const { data: fairs, error } = await db.from('fairs').select('id, slug, name');
  if (error) return new Response(error.message, { status: 500 });
  const report: { fair: string; orders: number; links?: string[] }[] = [];

  for (const f of fairs || []) {
    const stalls = await all((a, b) => db.from('stalls').select('id, name, owner_name, phone, upi_id, cut_pct').eq('fair_id', f.id).order('prefix').range(a, b));
    const ids = stalls.map(s => s.id), byId = Object.fromEntries(stalls.map(s => [s.id, s]));
    const orders = ids.length ? await all((a, b) => db.from('orders').select('*, order_lines(*)').in('stall_id', ids).order('created_at').range(a, b)) : [];
    if (!orders.length) continue;
    const donations = await all((a, b) => db.from('donations').select('name, amount, created_at').eq('fair_id', f.id).order('created_at').range(a, b));
    const settlements = await all((a, b) => db.from('settlements').select('stall_id, amount').in('stall_id', ids).range(a, b));

    const ordersCsv = csv([
      ['Token', 'Stall', 'Time', 'Customer', 'Phone', 'Items', 'Paid by', 'Status', 'Total (Rs)', 'Donation (Rs)', 'School share (Rs)'],
      ...orders.map(o => [o.token, byId[o.stall_id]?.name, ist(o.created_at), o.customer_name, o.customer_phone,
        o.order_lines.map((i: any) => `${i.qty} x ${i.name}${i.size ? ` (${i.size})` : ''}`).join('; '), o.paid_by, o.status, o.total, o.donation, PAID.includes(o.status) ? o.school_share : 0]),
      ...donations.map(d => ['DONATION', 'School fund (direct)', ist(d.created_at), d.name, '', '', 'UPI', 'done', d.amount, d.amount, d.amount]),
    ]);
    const stallsCsv = csv([
      ['Stall', 'Owner', 'Phone', 'UPI ID', 'Orders', 'UPI (Rs)', 'Cash (Rs)', 'Total (Rs)', 'School %', 'School share (Rs)', 'Settled (Rs)'],
      ...stalls.map(s => {
        const os = orders.filter(o => o.stall_id === s.id && PAID.includes(o.status)), tot = sum(os), cash = sum(os.filter(o => o.paid_by === 'Cash'));
        return [s.name, s.owner_name, s.phone, s.upi_id, os.length, tot - cash, cash, tot, s.cut_pct, os.reduce((a, o) => a + o.school_share, 0), sum(settlements.filter(x => x.stall_id === s.id))];
      }),
    ]);

    const links: string[] = [];
    for (const [name, body] of [['orders.csv', ordersCsv], ['stalls.csv', stallsCsv]]) {
      const path = `${f.slug}/${day}/${name}`;
      const up = await db.storage.from('backups').upload(path, new Blob([body], { type: 'text/csv;charset=utf-8' }), { upsert: true, contentType: 'text/csv;charset=utf-8' });
      if (up.error) return new Response(`${path}: ${up.error.message}`, { status: 500 });
      const { data: signed } = await db.storage.from('backups').createSignedUrl(path, 7 * 24 * 3600, { download: `${f.slug}-${day}-${name}` });
      if (signed) links.push(signed.signedUrl);
    }

    const key = Deno.env.get('RESEND_API_KEY'), to = Deno.env.get('ADMIN_EMAIL');
    if (key && to) try {   // the files are saved either way; a mail hiccup mustn't fail the backup
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: Deno.env.get('BACKUP_FROM') || 'Stall Day <onboarding@resend.dev>', to: [to], subject: `${f.name} backup — ${day}`,
          html: `<p>Tonight's backup of <b>${f.name}</b>: ${orders.length} orders.</p><p><a href="${links[0]}">All orders (Excel)</a><br><a href="${links[1]}">Stall summary (Excel)</a></p><p>Links work for 7 days; the files stay in Supabase → Storage → backups.</p>`,
        }),
      });
      if (!r.ok) console.error('email failed', r.status, await r.text());
    } catch (e) { console.error('email failed', e); }
    report.push({ fair: f.slug, orders: orders.length, links });
  }
  return new Response(JSON.stringify({ day, report }), { headers: { 'Content-Type': 'application/json' } });
});
