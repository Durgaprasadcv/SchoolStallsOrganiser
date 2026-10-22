import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';
import {
  DEFAULT_TEMPLATES, PAID, adminDb as db, appUrl, digits, downloadCsv, fetchAll, fill, friendly, lineLabel, time, wa,
  type Fair, type Notice, type Order, type Stall, type Templates,
} from './lib';

type AStall = Stall & { phone: string; pin_must_change: boolean; closeout: { upi_actual: string; cash_actual: string; closed: boolean } | null };
type Settlement = { id: string; stall_id: string; amount: number; method: 'UPI' | 'cash'; created_at: string };
type Donation = { id: string; name: string | null; amount: number; created_at: string };
type Invite = { id: string; name: string | null; phone: string; created_at: string };
type ANotice = Notice & { by_phone: string | null };
type Data = { stalls: AStall[]; orders: Order[]; settlements: Settlement[]; donations: Donation[]; causes: { id: string; name: string }[]; notices: ANotice[]; invites: Invite[]; tpl: Templates; code: string };

const STALL_COLS = 'id,fair_id,prefix,name,category,kind,hours,owner_name,owner_role,phone,pin_must_change,upi_id,cause_id,cut_pct,paused,closeout';
const Card = ({ children }: { children: ReactNode }) =>
  <div className="stack" style={{ background: 'var(--color-bg)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-6)', boxShadow: 'var(--shadow-md)', gap: 'var(--space-4)' }}>{children}</div>;
const H3 = ({ children }: { children: ReactNode }) => <h3 className="display" style={{ fontSize: 26 }}>{children}</h3>;
const sum = (os: { total?: number; amount?: number }[]) => os.reduce((a, o) => a + (o.total ?? o.amount ?? 0), 0);

export default function Admin() {
  const { slug = '' } = useParams();
  const [fair, setFair] = useState<Fair | null | undefined>(undefined);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => { db.from('fairs').select('id,name,slug,school_upi,payment_check').eq('slug', slug).maybeSingle().then(({ data }) => setFair(data)); }, [slug]);
  useEffect(() => {
    db.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = db.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);
  if (fair === null) return <Shell><Card><H3>Fair not found</H3></Card></Shell>;
  if (!fair || session === undefined) return <Shell />;
  const m = session?.user.app_metadata || {}, isAdmin = !!session && m.app_role === 'admin' && m.fair_id === fair.id;
  return isAdmin ? <Panel fair={fair} setFair={setFair} /> : <Shell><Login fair={fair} wrongAccount={!!session} /></Shell>;
}

const Shell = ({ children, right }: { children?: ReactNode; right?: ReactNode }) => (
  <div style={{ minHeight: '100dvh', background: 'var(--color-surface)', padding: 'var(--space-6) var(--space-4)' }}>
    <div className="stack" style={{ maxWidth: 760, margin: '0 auto', gap: 'var(--space-4)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', minHeight: 44 }}><span className="tag tag-neutral">School admin</span><span style={{ fontSize: 14 }}>Whole-fair view, live</span><div style={{ flex: 1 }} />{right}</div>
      {children}
    </div>
  </div>
);

function Login({ fair, wrongAccount }: { fair: Fair; wrongAccount: boolean }) {
  const [email, setEmail] = useState(''), [pw, setPw] = useState(''), [err, setErr] = useState(wrongAccount ? `That account isn't an admin for ${fair.name}.` : ''), [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    const { data, error } = await db.auth.signInWithPassword({ email: email.trim(), password: pw });
    setBusy(false);
    if (error) return setErr(error.message.includes('Invalid login') ? 'Wrong email or password.' : friendly(error));
    if (data.user?.app_metadata.app_role !== 'admin' || data.user.app_metadata.fair_id !== fair.id) setErr(`That account isn't an admin for ${fair.name}.`);
  };
  return (
    <form onSubmit={submit} className="stack" style={{ background: 'var(--color-bg)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-6)', boxShadow: 'var(--shadow-md)', gap: 'var(--space-4)', maxWidth: 400 }}>
      <H3>Admin login</H3>
      <p style={{ margin: 0, fontSize: 15, lineHeight: 1.5 }}>Only the fair organisers see sales, settle-ups and stall logins.</p>
      <div className="field"><label htmlFor="ae">Admin email</label><input id="ae" className="input" type="email" autoComplete="username" value={email} onChange={e => { setErr(''); setEmail(e.target.value); }} /></div>
      <div className="field"><label htmlFor="ap">Password</label><input id="ap" className="input" type="password" autoComplete="current-password" value={pw} onChange={e => { setErr(''); setPw(e.target.value); }} /></div>
      {err && <span className="err" role="alert">{err}</span>}
      <button className="btn btn-primary btn-block" disabled={busy}>Log in</button>
    </form>
  );
}

function Panel({ fair, setFair }: { fair: Fair; setFair: (f: Fair) => void }) {
  const [d, setD] = useState<Data | null>(null), [note, setNote] = useState('');
  const flash = (m: string) => { setNote(m); setTimeout(() => setNote(''), 3500); };
  const load = useCallback(async () => {
    try {
      const f = fair.id, ids = (await db.from('stalls').select('id').eq('fair_id', f)).data?.map(s => s.id) || [];
      const [stalls, orders, settlements, donations, causes, notices, invites, tpl, code] = await Promise.all([
        db.from('stalls').select(STALL_COLS).eq('fair_id', f).order('prefix').then(r => (r.data || []) as unknown as AStall[]),
        fetchAll<Order>((a, b) => db.from('orders').select('*, order_lines(*)').in('stall_id', ids).order('created_at').range(a, b)),
        fetchAll<Settlement>((a, b) => db.from('settlements').select('*').in('stall_id', ids).order('created_at').range(a, b)),
        fetchAll<Donation>((a, b) => db.from('donations').select('id,name,amount,created_at').eq('fair_id', f).order('created_at').range(a, b)),
        db.from('causes').select('id,name').eq('fair_id', f).order('name').then(r => r.data || []),
        db.from('notices').select('*').eq('fair_id', f).order('created_at', { ascending: false }).then(r => (r.data || []) as ANotice[]),
        db.from('invites').select('*').eq('fair_id', f).order('created_at', { ascending: false }).then(r => (r.data || []) as Invite[]),
        db.from('templates').select('key,body').eq('fair_id', f).then(r => ({ ...DEFAULT_TEMPLATES, ...Object.fromEntries((r.data || []).map(t => [t.key, t.body])) }) as Templates),
        db.rpc('admin_invite_code', { f }).then(r => (r.data as string) || ''),
      ]);
      setD({ stalls, orders, settlements, donations, causes, notices, invites, tpl, code });
    } catch (e) { flash(friendly(e as Error)); }
  }, [fair.id]);

  useEffect(() => {
    load();
    const ch = db.channel('admin').on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'settlements' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'donations' }, load).subscribe();
    const t = setInterval(load, 15000);
    return () => { db.removeChannel(ch); clearInterval(t); };
  }, [load]);

  const run = async (p: PromiseLike<{ error: { message?: string } | null }>, ok?: string) => {
    const { error } = await p; if (error) return flash(friendly(error)); if (ok) flash(ok); load();
  };
  if (!d) return <Shell />;

  const byId = Object.fromEntries(d.stalls.map(s => [s.id, s])), causeName = (s: AStall) => d.causes.find(c => c.id === s.cause_id)?.name || 'School fund';
  const paid = d.orders.filter(o => PAID.includes(o.status));
  const direct = sum(d.donations), stallRows = d.stalls.map(st => {
    const os = paid.filter(o => o.stall_id === st.id), total = sum(os), owed = os.reduce((a, o) => a + o.school_share, 0);
    const hist = d.settlements.filter(x => x.stall_id === st.id), received = sum(hist), due = Math.max(0, owed - received);
    const c = st.closeout, dd = c?.closed ? (parseInt(c.upi_actual, 10) || 0) + (parseInt(c.cash_actual, 10) || 0) - total : 0;
    const close: [string, string] = !c?.closed ? ['Day not closed', 'tag tag-outline'] : dd === 0 ? ['Closed · matches', 'tag tag-accent-2'] : [`Closed · ₹${Math.abs(dd)} ${dd < 0 ? 'short' : 'extra'}`, 'tag tag-accent'];
    return { st, os, total, owed, hist, received, due, close };
  });
  const totals = {
    total: sum(paid), school: paid.reduce((a, o) => a + o.school_share, 0) + direct, count: paid.length,
    cash: sum(paid.filter(o => o.paid_by === 'Cash')), donations: direct + paid.reduce((a, o) => a + o.donation, 0),
    waiting: d.orders.filter(o => ['verify', 'hold', 'pending'].includes(o.status)).length,
  };
  const owedAll = stallRows.reduce((a, r) => a + r.owed, 0), recAll = stallRows.reduce((a, r) => a + r.received, 0), dueAll = stallRows.reduce((a, r) => a + r.due, 0);

  const exportOrders = () => downloadCsv('stall-day-orders.csv', [
    ['Token', 'Stall', 'Time', 'Customer', 'Phone', 'Items', 'Paid by', 'Status', 'Total (Rs)', 'Donation (Rs)', 'School share (Rs)'],
    ...d.orders.map(o => [o.token, byId[o.stall_id]?.name, new Date(o.created_at).toLocaleString('en-IN'), o.customer_name, o.customer_phone,
      (o.order_lines || []).map(i => `${i.qty} x ${lineLabel(i)}`).join('; '), o.paid_by, o.status, o.total, o.donation, PAID.includes(o.status) ? o.school_share : 0]),
    ...d.donations.map(x => ['DONATION', 'School fund (direct)', new Date(x.created_at).toLocaleString('en-IN'), x.name, '', '', 'UPI', 'done', x.amount, x.amount, x.amount]),
  ]);
  const exportStalls = () => downloadCsv('stall-day-summary.csv', [
    ['Stall', 'Owner', 'Phone', 'UPI ID', 'Orders', 'UPI (Rs)', 'Cash (Rs)', 'Total (Rs)', 'School %', 'School share (Rs)', 'Settled (Rs)'],
    ...stallRows.map(r => { const cash = sum(r.os.filter(o => o.paid_by === 'Cash')); return [r.st.name, r.st.owner_name, r.st.phone, r.st.upi_id, r.os.length, r.total - cash, cash, r.total, r.st.cut_pct, r.owed, r.received]; }),
  ]);

  return (
    <Shell right={<button className="btn btn-ghost" onClick={() => db.auth.signOut()}>Lock</button>}>
      {note && <div className="toast" role="status" style={{ background: 'var(--color-accent-2-700)' }}><span style={{ fontSize: 14 }}>{note}</span></div>}
      <Card>
        <div className="wrap" style={{ gap: 'var(--space-6)' }}>
          {[['Total sales', `₹${totals.total}`, ''], ['Raised for school', `₹${totals.school}`, 'var(--color-accent-2-700)'], ['Orders', String(totals.count), '']].map(([l, v, c]) =>
            <div key={l} className="stack"><span style={{ fontSize: 13 }}>{l}</span><span style={{ fontFamily: 'var(--font-heading)', fontSize: 36, lineHeight: 1.1, color: c || undefined }}>{v}</span></div>)}
        </div>
        <span style={{ fontSize: 13 }}>UPI ₹{totals.total - totals.cash} · Cash ₹{totals.cash} · Donations ₹{totals.donations} · {totals.waiting} waiting now</span>
        <div className="wrap">
          <button className="btn btn-secondary" onClick={exportOrders}>Download all orders (Excel)</button>
          <button className="btn btn-ghost" onClick={exportStalls}>Stall summary (Excel)</button>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>Stall</th><th style={{ textAlign: 'right' }}>Sales</th><th style={{ textAlign: 'center' }}>School %</th><th style={{ textAlign: 'right' }}>To school</th></tr></thead>
            <tbody>{stallRows.map(r => (
              <tr key={r.st.id}>
                <td><strong>{r.st.name}</strong><br /><span style={{ fontSize: 13 }}>{r.os.length} orders · {r.st.category} · for {causeName(r.st)}</span><br /><span className={r.close[1]} style={{ marginTop: 4 }}>{r.close[0]}</span></td>
                <td style={{ textAlign: 'right' }}>₹{r.total}</td>
                <td><div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                  <button className="btn btn-ghost" style={{ padding: '0 8px', minHeight: 0 }} aria-label={`Lower school share for ${r.st.name}`} onClick={() => run(db.from('stalls').update({ cut_pct: Math.max(0, r.st.cut_pct - 5) }).eq('id', r.st.id))}>−</button>
                  <strong>{r.st.cut_pct}%</strong>
                  <button className="btn btn-ghost" style={{ padding: '0 8px', minHeight: 0 }} aria-label={`Raise school share for ${r.st.name}`} onClick={() => run(db.from('stalls').update({ cut_pct: Math.min(100, r.st.cut_pct + 5) }).eq('id', r.st.id))}>+</button>
                </div></td>
                <td style={{ textAlign: 'right' }}><strong>₹{r.owed}</strong></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        <span style={{ fontSize: 12 }}>A new school % applies to orders from now on; earlier orders keep the share the customer was shown.</span>
        <Causes d={d} run={run} fairId={fair.id} />
      </Card>

      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          <H3>Settle-ups</H3><span style={{ fontSize: 14 }}>Received ₹{recAll} of ₹{owedAll} · <strong>₹{dueAll} pending</strong></span>
        </div>
        <span style={{ fontSize: 14, lineHeight: 1.5 }}>Customers pay stall owners directly, so each stall passes the school's share on at the end of the day.</span>
        <SchoolUpi fair={fair} onSaved={u => { setFair({ ...fair, school_upi: u }); flash('School UPI ID saved'); }} />
        {stallRows.map(r => {
          const vars = { owner: r.st.owner_name, stall: r.st.name, cause: causeName(r.st) };
          const record = (method: 'UPI' | 'cash') => run(db.from('settlements').insert({ stall_id: r.st.id, amount: r.due, method }), `₹${r.due} from ${r.st.name} recorded`);
          return (
            <div key={r.st.id} className="stack" style={{ gap: 'var(--space-2)', padding: 'var(--space-4)', borderRadius: 'var(--radius-lg)', background: 'var(--color-surface)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
                <div className="stack" style={{ gap: 2 }}><strong>{r.st.name}</strong><span style={{ fontSize: 13 }}>{r.st.owner_name} · owes ₹{r.owed} ({r.st.cut_pct}%)</span></div>
                <span className={r.due === 0 ? 'tag tag-accent-2' : 'tag tag-accent'}>{r.due === 0 ? (r.owed ? 'Settled' : 'Nothing due') : r.received ? `₹${r.due} pending` : 'Not settled'}</span>
              </div>
              <a href={wa(r.st.phone, fill(d.tpl.thankyou, { ...vars, raised: r.owed, orders: r.os.length }))} target="_blank" rel="noopener" style={{ fontSize: 13, fontWeight: 600, alignSelf: 'flex-start' }}>Send thank-you on WhatsApp</a>
              {r.hist.map(h => <span key={h.id} style={{ fontSize: 13 }}>✓ ₹{h.amount} by {h.method} at {time(h.created_at)}</span>)}
              {r.due > 0 && (
                <div className="wrap">
                  <button className="btn btn-primary" onClick={() => record('UPI')}>₹{r.due} received · UPI</button>
                  <button className="btn btn-secondary" onClick={() => record('cash')}>Received · cash</button>
                  <a className="btn btn-ghost" style={{ textDecoration: 'none' }} target="_blank" rel="noopener" href={wa(r.st.phone, fill(d.tpl.reminder, { ...vars, due: r.due, schoolUpi: fair.school_upi }))}>Remind on WhatsApp</a>
                </div>
              )}
            </div>
          );
        })}
      </Card>

      <TemplatesCard d={d} run={run} fairId={fair.id} />
      <NoticesCard d={d} run={run} fairId={fair.id} />
      <LoginsCard d={d} run={run} fair={fair} flash={flash} />
    </Shell>
  );
}

type Run = (p: PromiseLike<{ error: { message?: string } | null }>, ok?: string) => Promise<void>;

function Causes({ d, run, fairId }: { d: Data; run: Run; fairId: string }) {
  const [draft, setDraft] = useState('');
  return (
    <div className="stack" style={{ gap: 'var(--space-2)', padding: 'var(--space-4)', borderRadius: 'var(--radius-lg)', background: 'var(--color-accent-2-100)' }}>
      <strong>Causes</strong>
      <span style={{ fontSize: 13 }}>What the money is raised for. Each stall picks one in its Stall tab.</span>
      <div className="wrap">{d.causes.map(c => (
        <span key={c.id} className="tag tag-accent-2" style={{ gap: 6 }}>{c.name} · {d.stalls.filter(s => s.cause_id === c.id).length}
          <button aria-label={`Remove cause ${c.name}`} style={{ border: 'none', background: 'none', cursor: 'pointer', font: 'inherit', padding: 0, color: 'inherit' }} onClick={() => run(db.from('causes').delete().eq('id', c.id))}>×</button></span>
      ))}</div>
      <form style={{ display: 'flex', gap: 'var(--space-2)' }} onSubmit={e => { e.preventDefault(); run(db.from('causes').insert({ fair_id: fairId, name: draft.trim() })); setDraft(''); }}>
        <input className="input" style={{ flex: 1, minWidth: 0 }} aria-label="New cause" placeholder="e.g. Smart classroom projector" value={draft} onChange={e => setDraft(e.target.value)} />
        <button className="btn btn-primary" disabled={!draft.trim() || d.causes.some(c => c.name.toLowerCase() === draft.trim().toLowerCase())}>Add</button>
      </form>
    </div>
  );
}

function SchoolUpi({ fair, onSaved }: { fair: Fair; onSaved: (u: string) => void }) {
  const [v, setV] = useState(fair.school_upi);
  const save = async () => { const u = v.trim(); if (!u || u === fair.school_upi) return setV(fair.school_upi); const { error } = await db.from('fairs').update({ school_upi: u }).eq('id', fair.id); if (!error) onSaved(u); };
  return <div className="field"><label htmlFor="su">School UPI ID (owners pay here)</label><input id="su" className="input" autoCapitalize="none" value={v} onChange={e => setV(e.target.value)} onBlur={save} /></div>;
}

const TPL_META: [keyof Templates, string, string, string][] = [
  ['invite', 'Stall invite', 'Sent by admin to new stall owners', '{name} {link} {code}'],
  ['receipt', 'Receipt', 'Sent to the customer', '{name} {stall} {token} {items} {total} {paidBy} {schoolShare} {cause}'],
  ['ready', 'Order ready', 'Sent by the stall owner when food is ready', '{name} {token} {stall}'],
  ['reminder', 'Settle-up reminder', 'Sent by admin to stall owners', '{owner} {stall} {due} {schoolUpi} {cause}'],
  ['thankyou', 'Thank-you', 'Sent by admin after the fair', '{owner} {stall} {raised} {cause} {orders}'],
];
function TemplatesCard({ d, run, fairId }: { d: Data; run: Run; fairId: string }) {
  const [v, setV] = useState(d.tpl);
  const save = (k: keyof Templates, body: string) => body !== d.tpl[k] && run(db.from('templates').upsert({ fair_id: fairId, key: k, body }), 'Message saved');
  return (
    <Card>
      <H3>WhatsApp messages</H3>
      <span style={{ fontSize: 14, lineHeight: 1.5 }}>Edit the wording once here — every stall uses it. Words in {'{curly brackets}'} are filled in automatically.</span>
      {TPL_META.map(([k, title, who, vars]) => (
        <div key={k} className="field">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 'var(--space-2)', flexWrap: 'wrap' }}><label htmlFor={'t-' + k}>{title}</label><span style={{ fontSize: 12 }}>{who}</span></div>
          <textarea id={'t-' + k} className="input" style={{ borderRadius: 'var(--radius-md)', minHeight: 84, resize: 'vertical', fontSize: 14 }} value={v[k]} onChange={e => setV({ ...v, [k]: e.target.value })} onBlur={() => save(k, v[k])} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12 }}>{vars}</span>
            {v[k] !== DEFAULT_TEMPLATES[k] && <button className="btn btn-ghost" style={{ fontSize: 12 }} aria-label={`Reset ${title} message`} onClick={() => { setV({ ...v, [k]: DEFAULT_TEMPLATES[k] }); save(k, DEFAULT_TEMPLATES[k]); }}>Reset</button>}
          </div>
        </div>
      ))}
    </Card>
  );
}

function NoticesCard({ d, run, fairId }: { d: Data; run: Run; fairId: string }) {
  const [kind, setKind] = useState<'Found' | 'Lost' | 'Notice'>('Found'), [text, setText] = useState('');
  const kc = { Lost: 'tag tag-accent', Found: 'tag tag-accent-2', Notice: 'tag tag-neutral' };
  return (
    <Card>
      <H3>Lost &amp; found · announcements</H3>
      <span style={{ fontSize: 14 }}>Shows on every customer's Stalls screen and on the token board.</span>
      <div className="wrap">{(['Found', 'Lost', 'Notice'] as const).map(k => <button key={k} aria-pressed={kind === k} className={kind === k ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => setKind(k)}>{k}</button>)}</div>
      <form className="wrap" onSubmit={e => { e.preventDefault(); run(db.from('notices').insert({ fair_id: fairId, kind, text: text.trim().slice(0, 200), by_name: 'Admin' })); setText(''); }}>
        <input className="input" style={{ flex: 1, minWidth: 200 }} maxLength={200} aria-label="Notice text" placeholder="e.g. Blue water bottle found near Sunny Snacks" value={text} onChange={e => setText(e.target.value)} />
        <button className="btn btn-primary" disabled={!text.trim()}>Post</button>
      </form>
      {d.notices.map(n => (
        <div key={n.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap', padding: 'var(--space-3) var(--space-4)', borderRadius: 'var(--radius-lg)', background: 'var(--color-surface)', opacity: n.open ? 1 : 0.55 }}>
          <span className={kc[n.kind]}>{n.kind}</span>
          <div className="stack" style={{ flex: 1, minWidth: 160 }}><span style={{ fontSize: 14 }}>{n.text}</span><span style={{ fontSize: 12 }}>{time(n.created_at)} · {n.by_name || 'Admin'}{n.by_phone ? <> · <a href={`tel:${n.by_phone}`}>{n.by_phone}</a></> : ''}</span></div>
          <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => run(db.from('notices').update({ open: !n.open }).eq('id', n.id))}>{n.open ? 'Mark resolved' : 'Show again'}</button>
        </div>
      ))}
    </Card>
  );
}

function LoginsCard({ d, run, fair, flash }: { d: Data; run: Run; fair: Fair; flash: (m: string) => void }) {
  const [iv, setIv] = useState({ name: '', phone: '' }), ph = digits(iv.phone);
  const msg = (name: string) => fill(d.tpl.invite, { name: name.trim() || 'there', link: `${appUrl(fair.slug)}/owner`, code: d.code });
  const newCode = () => {
    const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', c = Array.from(crypto.getRandomValues(new Uint8Array(6)), b => a[b % a.length]).join('');
    run(db.from('fairs').update({ invite_code: c }).eq('id', fair.id), 'New invite code — the old one stops working');
  };
  return (
    <Card>
      <H3>Stall logins</H3>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap', padding: 'var(--space-3) var(--space-4)', borderRadius: 'var(--radius-lg)', background: 'var(--color-accent-2-100)' }}>
        <span style={{ fontSize: 14 }}>Invite code for new stalls</span><strong style={{ fontFamily: 'var(--font-heading)', fontSize: 24, letterSpacing: '.06em' }} data-testid="invite-code">{d.code}</strong>
        <div style={{ flex: 1 }} /><button className="btn btn-secondary" onClick={newCode}>New code</button>
      </div>
      <div className="stack" style={{ gap: 'var(--space-2)', padding: 'var(--space-4)', borderRadius: 'var(--radius-lg)', background: 'var(--color-surface)' }}>
        <strong>Invite a stall owner</strong>
        <div className="wrap">
          <input className="input" style={{ flex: 1, minWidth: 140 }} aria-label="Their name" placeholder="Their name" value={iv.name} onChange={e => setIv({ ...iv, name: e.target.value })} />
          <input className="input" style={{ flex: 1, minWidth: 160 }} inputMode="tel" aria-label="Their WhatsApp number" placeholder="WhatsApp number" value={iv.phone} onChange={e => setIv({ ...iv, phone: e.target.value })} />
        </div>
        <div className="wrap">
          <a className="btn btn-primary" style={{ textDecoration: 'none', ...(ph.length !== 10 ? { opacity: 0.45, pointerEvents: 'none' } : {}) }} aria-disabled={ph.length !== 10} target="_blank" rel="noopener"
            href={ph.length === 10 ? wa(ph, msg(iv.name)) : undefined}
            onClick={() => { if (ph.length !== 10) return; run(db.from('invites').insert({ fair_id: fair.id, name: iv.name.trim() || null, phone: ph })); setIv({ name: '', phone: '' }); }}>Send invite on WhatsApp</a>
          <button className="btn btn-ghost" onClick={() => navigator.clipboard?.writeText(msg('')).then(() => flash('Invite message copied — paste it into any WhatsApp group'), () => flash('Copy blocked by the browser'))}>Copy message for a group</button>
        </div>
        <span style={{ fontSize: 12 }}>Includes the app link, steps and today's code. Edit the wording under WhatsApp messages.</span>
        {d.invites.map(x => (
          <div key={x.id} className="row" style={{ gap: 'var(--space-2)', fontSize: 13 }}><span>{x.name || 'Unnamed'} · {x.phone} · {time(x.created_at)}</span>
            <strong>{d.stalls.some(s => s.phone === x.phone) ? 'Joined ✓' : 'Not joined yet'}</strong></div>
        ))}
      </div>
      {d.stalls.map(s => (
        <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap', padding: 'var(--space-3) var(--space-4)', borderRadius: 'var(--radius-lg)', background: 'var(--color-surface)' }}>
          <div className="stack" style={{ flex: 1, gap: 2, minWidth: 160 }}><strong>{s.name}</strong><span style={{ fontSize: 13 }}>{s.owner_name} · {s.phone}</span></div>
          {s.pin_must_change && <span className="tag tag-accent-2">PIN reset to 0000</span>}
          <button className="btn btn-ghost" aria-label={`Reset PIN for ${s.name}`} onClick={() => run(db.rpc('admin_reset_pin', { p_stall: s.id }), `${s.name}: PIN is now 0000 — they choose a new one at login`)}>Reset PIN</button>
        </div>
      ))}
    </Card>
  );
}
