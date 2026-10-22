import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';
import {
  DEFAULT_TEMPLATES, PAID, TAGS, digits, disablePush, fetchAll, useFair, fill, friendly, lineLabel, menuLabel, photoUrl, qrSvg, shrinkPhoto, staff, stallAuth,
  stallUrl, statusInfo, time, upiLink, wa,
  type Combo, type Fair, type Item, type Order, type Stall, type Templates,
} from './lib';
import { receiptText } from './Customer';
import { Offline, PushButton } from './ui';

type Closeout = { upi_actual: string; cash_actual: string; note: string; closed: boolean; closed_at?: string };
type OwnStall = Stall & { phone: string; pin_must_change: boolean; closeout: Closeout | null };
type Ctx = {
  fair: Fair; stall: OwnStall; isOwner: boolean; helperName: string; causes: { id: string; name: string }[]; tpl: Templates;
  saveStall: (patch: Partial<OwnStall>) => Promise<void>; orders: Order[]; reloadOrders: () => void; seen: Set<string>;
  items: Item[]; combos: Combo[]; reloadItems: () => void; toast: (title: string, msg: string) => void; logout: () => void;
};
const O = createContext<Ctx>(null!);
const useO = () => useContext(O);

const STALL_COLS = 'id,fair_id,prefix,name,category,kind,hours,owner_name,owner_role,phone,pin_must_change,upi_id,about,photo_path,cause_id,cut_pct,paused,pause_msg,closeout';
const NAME_KEY = 'stallday-staff-name';
const store = { get: (k: string) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

const Page = ({ children, gap = 'var(--space-4)' }: { children: ReactNode; gap?: string }) =>
  <div style={{ padding: 'var(--space-6) var(--space-4)', display: 'flex', flexDirection: 'column', gap, flex: 1 }}>{children}</div>;
const Title = ({ children }: { children: ReactNode }) => <h2 className="display" style={{ fontSize: 30, padding: '0 var(--space-2)' }}>{children}</h2>;

// ───────────────────────── shell: fair + staff session ─────────────────────────
export default function Owner() {
  const { slug = '' } = useParams();
  const { fair, offline } = useFair(staff, slug);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    staff.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = staff.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);
  if (fair === null) return <div className="phone"><Page><Title>Fair not found</Title><p style={{ padding: '0 var(--space-2)' }}>Check the link from the school admin.</p></Page></div>;
  if (!fair || session === undefined) return <div className="phone">{offline && <Offline />}</div>;
  const meta = session?.user.app_metadata || {};
  const mine = session && meta.fair_id === fair.id && (meta.app_role === 'owner' || meta.app_role === 'helper');
  return <div className="phone">{mine ? <StaffApp fair={fair} session={session!} /> : <Login fair={fair} />}</div>;
}

function Login({ fair }: { fair: Fair }) {
  const nav = useNavigate();
  const [mode, setMode] = useState<'login' | 'join'>('login');
  const [f, setF] = useState({ phone: '', pin: '', code: '', stall: '', owner: '' }), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => { setErr(''); setF({ ...f, [k]: k === 'pin' ? e.target.value.replace(/\D/g, '').slice(0, 4) : e.target.value }); };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    const r = await stallAuth(mode === 'login' ? { action: 'login', fair: fair.slug, phone: f.phone, pin: f.pin } : { action: 'join', fair: fair.slug, ...f });
    setBusy(false);
    if (r.error) return setErr(r.error);
    store.set(NAME_KEY, mode === 'join' ? f.owner.trim() : '');
    const { error } = await staff.auth.setSession({ access_token: r.access_token, refresh_token: r.refresh_token });
    if (error) return setErr(friendly(error));
    nav(`/${fair.slug}/owner${r.joined ? '/stall' : ''}`, { replace: true });   // never land on the last person's tab
  };
  return (
    <form onSubmit={submit} style={{ flex: 1, padding: 'var(--space-8) var(--space-6)', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div className="avatar" style={{ width: 88, height: 88, background: 'var(--color-accent-2-200)', fontSize: 36, color: 'var(--color-accent-2-800)' }}>S</div>
      {mode === 'login' ? <>
        <div className="stack" style={{ gap: 'var(--space-2)' }}>
          <h2 className="display" style={{ fontSize: 32 }}>Stall login</h2>
          <p style={{ margin: 0, fontSize: 15, lineHeight: 1.5 }}>Your phone number and the 4-digit PIN you chose.</p>
        </div>
        <div className="field"><label htmlFor="ph">WhatsApp number</label><input id="ph" className="input" inputMode="tel" autoComplete="tel" placeholder="10-digit mobile" value={f.phone} onChange={set('phone')} /></div>
        <div className="field"><label htmlFor="pin">PIN</label><input id="pin" className="input" type="password" inputMode="numeric" maxLength={4} placeholder="••••" autoComplete="current-password" value={f.pin} onChange={set('pin')} /></div>
        {err && <span className="err" role="alert">{err}</span>}
        <button className="btn btn-primary btn-block" disabled={busy}>Log in</button>
        <div style={{ flex: 1 }} />
        <button type="button" className="btn btn-secondary btn-block" onClick={() => { setErr(''); setMode('join'); }}>New stall? Join with invite code</button>
        <span style={{ fontSize: 13 }}>Forgot your PIN? Ask the school admin to reset it.</span>
      </> : <>
        <div className="stack" style={{ gap: 'var(--space-2)' }}>
          <h2 className="display" style={{ fontSize: 32 }}>Join the fair</h2>
          <p style={{ margin: 0, fontSize: 15, lineHeight: 1.5 }}>Get the invite code from the school admin. You'll add your menu and UPI ID next.</p>
        </div>
        <div className="field"><label htmlFor="code">Invite code</label><input id="code" className="input" placeholder="e.g. FAIR24" autoCapitalize="characters" style={{ textTransform: 'uppercase' }} value={f.code} onChange={set('code')} /></div>
        <div className="field"><label htmlFor="sn">Stall name</label><input id="sn" className="input" placeholder="e.g. Mango Masti" value={f.stall} onChange={set('stall')} /></div>
        <div className="field"><label htmlFor="on">Your name</label><input id="on" className="input" autoComplete="name" value={f.owner} onChange={set('owner')} /></div>
        <div className="field"><label htmlFor="jph">WhatsApp number</label><input id="jph" className="input" inputMode="tel" autoComplete="tel" value={f.phone} onChange={set('phone')} /><span style={{ fontSize: 12 }}>Used to log in, and for reminders and thank-yous from the school.</span></div>
        <div className="field"><label htmlFor="jpin">Choose a 4-digit PIN</label><input id="jpin" className="input" type="password" inputMode="numeric" maxLength={4} autoComplete="new-password" value={f.pin} onChange={set('pin')} /></div>
        {err && <span className="err" role="alert">{err}</span>}
        <button className="btn btn-primary btn-block" disabled={busy}>Create my stall</button>
        <button type="button" className="btn btn-ghost btn-block" onClick={() => { setErr(''); setMode('login'); }}>I already have a stall</button>
      </>}
    </form>
  );
}

function ChangePin({ onDone }: { onDone: () => void }) {
  const [pin, setPin] = useState(''), [err, setErr] = useState('');
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const { error } = await staff.rpc('change_pin', { p_pin: pin });
    if (error) return setErr(friendly(error));
    onDone();
  };
  return (
    <form onSubmit={save} style={{ flex: 1, padding: 'var(--space-8) var(--space-6)', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <h2 className="display" style={{ fontSize: 32 }}>Choose a new PIN</h2>
      <p style={{ margin: 0, fontSize: 15, lineHeight: 1.5 }}>The admin reset your PIN. Pick a new 4-digit PIN only you know.</p>
      <div className="field"><label htmlFor="np">New PIN</label><input id="np" className="input" type="password" inputMode="numeric" maxLength={4} autoComplete="new-password" value={pin} onChange={e => { setErr(''); setPin(e.target.value.replace(/\D/g, '').slice(0, 4)); }} /></div>
      {err && <span className="err" role="alert">{err}</span>}
      <button className="btn btn-primary btn-block" disabled={pin.length !== 4}>Save PIN</button>
    </form>
  );
}

// ───────────────────────── logged-in app ─────────────────────────
function StaffApp({ fair, session }: { fair: Fair; session: Session }) {
  const meta = session.user.app_metadata, stallId: string = meta.stall_id, isOwner = meta.app_role === 'owner';
  const [stall, setStall] = useState<OwnStall | null>(null);
  const [causes, setCauses] = useState<{ id: string; name: string }[]>([]);
  const [tpl, setTpl] = useState<Templates>(DEFAULT_TEMPLATES);
  const [orders, setOrders] = useState<Order[]>([]), [items, setItems] = useState<Item[]>([]), [combos, setCombos] = useState<Combo[]>([]);
  const [note, setNote] = useState<{ title: string; msg: string } | null>(null), [helperName, setHelperName] = useState(store.get(NAME_KEY));
  const seen = useRef<Set<string> | null>(null), [ringed, setRinged] = useState(new Set<string>()), timer = useRef(0);

  const toast = useCallback((title: string, msg: string) => {
    clearTimeout(timer.current); setNote({ title, msg }); timer.current = window.setTimeout(() => setNote(null), 4500);
  }, []);
  const logout = async () => { store.set(NAME_KEY, ''); await disablePush(staff); staff.auth.signOut(); };

  const loadStall = useCallback(async () => {
    const { data } = await staff.from('stalls').select(STALL_COLS).eq('id', stallId).maybeSingle();
    if (data) setStall(data as unknown as OwnStall); else logout();   // stall removed by admin
  }, [stallId]);   // eslint-disable-line

  const reloadOrders = useCallback(async () => {
    await staff.rpc('release_expired_holds');
    const data = await fetchAll<Order>((a, b) => staff.from('orders').select('*, order_lines(*)').eq('stall_id', stallId).order('created_at').range(a, b)).catch(() => null);
    if (!data) return;   // keep the last good list on a failed poll
    // ring + banner for orders that arrived since the last look
    if (seen.current) {
      const fresh = data.filter(o => !seen.current!.has(o.id) && o.customer_id);
      if (fresh.length) {
        const o = fresh[fresh.length - 1];
        toast(o.status === 'hold' ? 'New hold request' : 'New order — KOT', `${o.token} · ${o.customer_name} · ₹${o.total}`);
        setRinged(r => new Set([...r, ...fresh.map(x => x.id)]));
        try { navigator.vibrate?.([200, 100, 200]); } catch { /* not supported */ }
      }
    }
    seen.current = new Set(data.map(o => o.id));
    setOrders(data);
  }, [stallId, toast]);

  const reloadItems = useCallback(async () => {
    const [{ data: i }, { data: c }] = await Promise.all([
      staff.from('items').select('*').eq('stall_id', stallId).order('sort').order('created_at'),
      staff.from('combos').select('*').eq('stall_id', stallId),
    ]);
    setItems(i || []); setCombos(c || []);
  }, [stallId]);

  useEffect(() => {
    loadStall(); reloadOrders(); reloadItems();
    staff.from('causes').select('id,name').eq('fair_id', fair.id).order('name').then(({ data }) => setCauses(data || []));
    staff.from('templates').select('key,body').eq('fair_id', fair.id).then(({ data }) => setTpl({ ...DEFAULT_TEMPLATES, ...Object.fromEntries((data || []).map(t => [t.key, t.body])) }));
    if (!isOwner && !helperName) setHelperName('Helper');
    // Realtime for instant KOTs; the 10 s poll covers flaky school Wi-Fi and a dropped socket.
    const ch = staff.channel('stall-' + stallId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: `stall_id=eq.${stallId}` }, reloadOrders)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'items', filter: `stall_id=eq.${stallId}` }, reloadItems).subscribe();
    const t = setInterval(reloadOrders, 10000), vis = () => document.visibilityState === 'visible' && (reloadOrders(), reloadItems(), loadStall());
    document.addEventListener('visibilitychange', vis);
    return () => { staff.removeChannel(ch); clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  }, [stallId]);   // eslint-disable-line

  const saveStall = async (patch: Partial<OwnStall>) => {
    setStall(s => s && { ...s, ...patch });
    const { error } = await staff.from('stalls').update(patch).eq('id', stallId);
    if (error) { toast('Not saved', friendly(error)); loadStall(); }
  };

  if (!stall) return null;
  if (isOwner && stall.pin_must_change) return <ChangePin onDone={() => setStall({ ...stall, pin_must_change: false })} />;
  const ctx: Ctx = { fair, stall, isOwner, helperName, causes, tpl, saveStall, orders, reloadOrders, seen: ringed, items, combos, reloadItems, toast, logout };
  return (
    <O.Provider value={ctx}>
      {note && <div className="toast" role="status" style={{ background: 'var(--color-accent-700)' }}><strong style={{ fontSize: 15 }}>{note.title}</strong><span style={{ fontSize: 14 }}>{note.msg}</span></div>}
      <div className="phone-main">
        <Routes>
          <Route index element={<Queue />} />
          <Route path="o/:orderId" element={<Detail unring={id => setRinged(r => { const n = new Set(r); n.delete(id); return n; })} />} />
          <Route path="cash" element={<Cash />} />
          {isOwner && <>
            <Route path="items" element={<Items />} />
            <Route path="items/:itemId" element={<ItemEditor />} />
            <Route path="sales" element={<Sales />} />
            <Route path="stall" element={<StallSetup />} />
          </>}
        </Routes>
      </div>
      <StaffNav />
    </O.Provider>
  );
}

function StaffNav() {
  const { fair, isOwner } = useO(), { pathname } = useLocation(), base = `/${fair.slug}/owner`;
  const at = pathname.slice(base.length).split('/')[1] || '';
  const tab = (to: string, label: string) => {
    const on = to === '' ? at === '' || at === 'o' : at === to;
    return <Link key={to} to={`${base}/${to}`} className={on ? 'btn btn-primary' : 'btn btn-ghost'} style={{ flex: 1, paddingLeft: 0, paddingRight: 0, fontSize: 13 }} aria-current={on ? 'page' : undefined}>{label}</Link>;
  };
  return (
    <div className="bottom-nav" style={{ gap: 2, padding: 'var(--space-3) var(--space-2) calc(var(--space-4) + env(safe-area-inset-bottom))' }}>
      {[tab('', 'Orders'), isOwner && tab('items', 'Items'), tab('cash', 'Cash'), isOwner && tab('sales', 'Sales'), isOwner && tab('stall', 'Stall')]}
    </div>
  );
}

// ───────────────────────── orders ─────────────────────────
function Queue() {
  const { stall, orders, isOwner, helperName, logout, saveStall, seen, fair } = useO();
  const [tab, setTab] = useState<'pending' | 'ready' | 'done'>('pending'), nav = useNavigate();
  const [msg, setMsg] = useState(stall.pause_msg || 'Back in 10 min');
  const by = {
    pending: orders.filter(o => ['verify', 'hold', 'pending'].includes(o.status)),
    ready: orders.filter(o => o.status === 'ready'),
    done: orders.filter(o => ['done', 'cancelled'].includes(o.status)).reverse(),
  };
  return (
    <Page gap="var(--space-3)">
      <div className="stack" style={{ gap: 2, padding: '0 var(--space-2)' }}>
        <span style={{ fontSize: 14 }}>{stall.name}</span>
        <h2 className="display" style={{ fontSize: 30 }}>Orders</h2>
      </div>
      <PushButton db={staff} label="Get new-order alerts on this phone" hint="A notification with every new order, even when the app is closed or the screen is off." />
      {!isOwner && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', padding: 'var(--space-2) var(--space-4)', borderRadius: 999, background: 'var(--color-accent-2-100)' }}>
          <span style={{ fontSize: 13, flex: 1 }}>Helper login{helperName ? <> · <strong>{helperName}</strong></> : ''} · orders &amp; cash only</span>
          <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={logout}>Log out</button>
        </div>
      )}
      {stall.paused ? (
        <div className="stack" style={{ gap: 'var(--space-2)', padding: 'var(--space-3) var(--space-4)', borderRadius: 'var(--radius-lg)', background: 'var(--color-accent-100)' }}>
          <strong style={{ color: 'var(--color-accent-800)' }}>Orders paused</strong>
          <input className="input" aria-label="Message for customers" value={msg} onChange={e => setMsg(e.target.value)} onBlur={() => saveStall({ pause_msg: msg })} />
          <button className="btn btn-primary btn-block" onClick={() => saveStall({ paused: false })}>Resume orders</button>
        </div>
      ) : <button className="btn btn-ghost" style={{ alignSelf: 'flex-start', fontSize: 14 }} onClick={() => saveStall({ paused: true, pause_msg: msg })}>Taking a break? Pause orders</button>}
      <div style={{ display: 'flex', gap: 'var(--space-2)' }} role="tablist">
        {(['pending', 'ready', 'done'] as const).map(t => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'btn btn-primary' : 'btn btn-ghost'} style={{ flex: 1, paddingLeft: 0, paddingRight: 0 }} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)} {by[t].length}</button>)}
      </div>
      {!by[tab].length && <p style={{ margin: 0, padding: 'var(--space-4) var(--space-2)' }}>Nothing here right now.</p>}
      {by[tab].map(o => {
        const [label, cls] = statusInfo(o, stall.kind), ring = seen.has(o.id) && !['done', 'cancelled'].includes(o.status);
        return (
          <button key={o.id} onClick={() => nav(`/${fair.slug}/owner/o/${o.id}`)} style={{ all: 'unset', cursor: 'pointer', display: 'flex', gap: 'var(--space-3)', alignItems: 'center', padding: 'var(--space-4)', borderRadius: 'var(--radius-lg)', background: 'var(--color-surface)', boxShadow: ring ? '0 0 0 3px var(--color-accent)' : 'none' }}>
            <div className="avatar" style={{ width: 64, height: 64, background: 'var(--color-accent-200)', fontSize: 20, color: 'var(--color-accent-800)' }}>{o.token}</div>
            <div className="stack" style={{ flex: 1, gap: 4, minWidth: 0 }}>
              <div className="row" style={{ gap: 'var(--space-2)' }}><strong>{o.customer_name}</strong><span style={{ fontSize: 13 }}>{time(o.created_at)}</span></div>
              <span style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{(o.order_lines || []).map(i => `${i.qty}× ${lineLabel(i)}`).join(', ')}</span>
              <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}><span className={cls}>{label}</span><strong style={{ fontSize: 14 }}>₹{o.total}</strong><span style={{ fontSize: 12 }}>{o.paid_by}</span></div>
            </div>
          </button>
        );
      })}
    </Page>
  );
}

function Detail({ unring }: { unring: (id: string) => void }) {
  const { orderId = '' } = useParams(), { orders, stall, fair, tpl, causes, reloadOrders, toast } = useO(), nav = useNavigate();
  const o = orders.find(x => x.id === orderId), [busy, setBusy] = useState(false);
  useEffect(() => { unring(orderId); }, [orderId]);   // eslint-disable-line
  if (!o) return null;
  const [label, cls] = statusInfo(o, stall.kind), first = o.customer_name.split(' ')[0];
  const cause = causes.find(c => c.id === stall.cause_id)?.name || 'School fund';
  const act = async (status: string, back: 'pending' | 'ready' | null = 'pending') => {
    setBusy(true);
    const { error } = await staff.rpc('set_order_status', { p_order: o.id, p_status: status });
    setBusy(false);
    if (error) return toast('Could not update', friendly(error));
    reloadOrders();
    if (back) nav(`/${fair.slug}/owner`);
  };
  return (
    <div style={{ padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', flex: 1 }}>
      <Link className="btn btn-ghost" style={{ alignSelf: 'flex-start' }} to={`/${fair.slug}/owner`}>← Orders</Link>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', padding: '0 var(--space-2)' }}>
        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 56, lineHeight: 1, color: 'var(--color-accent-700)' }}>{o.token}</span>
        <div className="stack" style={{ gap: 4 }}><span className={cls} style={{ alignSelf: 'flex-start' }}>{label}</span><span style={{ fontSize: 13 }}>Placed {time(o.created_at)}{o.status === 'hold' && o.hold_until ? ` · held till ${time(o.hold_until)}` : ''}</span></div>
      </div>
      <div className="card" style={{ gap: 'var(--space-2)', borderRadius: 'var(--radius-lg)' }}>
        <span className="card-kicker">Customer</span>
        <strong style={{ fontSize: 18 }}>{o.customer_name}</strong>
        {o.customer_phone && (
          <div className="wrap" style={{ gap: 'var(--space-3)', alignItems: 'center' }}>
            <a href={`tel:${o.customer_phone}`} style={{ fontSize: 15 }}>{o.customer_phone}</a>
            <a href={wa(o.customer_phone, receiptText(o, stall, cause, tpl))} target="_blank" rel="noopener" style={{ fontSize: 14, fontWeight: 600 }}>Receipt on WhatsApp</a>
            {o.status === 'ready' && <a href={wa(o.customer_phone, fill(tpl.ready, { name: first, token: o.token, stall: stall.name }))} target="_blank" rel="noopener" style={{ fontSize: 14, fontWeight: 600 }}>"Ready" on WhatsApp</a>}
          </div>
        )}
      </div>
      <div className="stack" style={{ gap: 'var(--space-2)', background: 'var(--color-surface)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-4)' }}>
        <span className="card-kicker">Items</span>
        {(o.order_lines || []).map(l => <div key={l.id} className="row" style={{ fontSize: 16 }}><span><strong>{l.qty} ×</strong> {lineLabel(l)}</span><span>₹{l.qty * l.price}</span></div>)}
        {o.donation > 0 && <div className="row" style={{ fontSize: 16 }}><span>Extra for the school</span><span>₹{o.donation}</span></div>}
        <div className="row" style={{ fontSize: 16, paddingTop: 'var(--space-2)' }}><strong>{o.paid_by}</strong><strong>₹{o.total}</strong></div>
      </div>
      <div style={{ flex: 1 }} />
      {o.status === 'verify' && <>
        <span style={{ fontSize: 13, padding: '0 var(--space-2)' }}>Check your UPI app for ₹{o.total} from {o.customer_name} (note: Token {o.token}) first.</span>
        <button className="btn btn-primary btn-block" disabled={busy} onClick={() => act('pending', null)}>Payment received</button>
        <button className="btn btn-ghost btn-block" disabled={busy} onClick={() => act('cancelled')}>Not paid · cancel order</button>
      </>}
      {o.status === 'hold' && <>
        <button className="btn btn-primary btn-block" disabled={busy} onClick={() => act('done')}>Paid cash · handed over</button>
        <button className="btn btn-ghost btn-block" disabled={busy} onClick={() => act('cancelled')}>Release hold · back to stock</button>
      </>}
      {o.status === 'pending' && <>
        <button className="btn btn-primary btn-block" disabled={busy} onClick={() => act('ready')}>Mark ready · notify {first}</button>
        <button className="btn btn-ghost btn-block" disabled={busy} onClick={() => act('cancelled')}>Cancel order · back to stock</button>
      </>}
      {o.status === 'ready' && <button className="btn btn-primary btn-block" disabled={busy} onClick={() => act('done', 'ready')}>Handed over</button>}
    </div>
  );
}

// ───────────────────────── items + combos ─────────────────────────
// sold counts per item, counting combo parts
const useSold = () => {
  const { orders, combos } = useO();
  return useMemo(() => {
    const sold: Record<string, number> = {};
    orders.filter(o => PAID.includes(o.status)).forEach(o => (o.order_lines || []).forEach(l => {
      const parts = l.combo_id ? combos.find(c => c.id === l.combo_id)?.item_ids || [] : l.item_id ? [l.item_id] : [];
      parts.forEach(p => { sold[p] = (sold[p] || 0) + l.qty; });
    }));
    return sold;
  }, [orders, combos]);
};

function Items() {
  const { items, combos, reloadItems, toast, fair, stall } = useO(), sold = useSold(), nav = useNavigate();
  const [draft, setDraft] = useState<{ name: string; parts: string[]; price: string } | null>(null);
  const patch = async (id: string, p: Partial<Item>) => {
    const { error } = await staff.from('items').update(p).eq('id', id);
    if (error) toast('Not saved', friendly(error)); reloadItems();
  };
  const full = draft ? draft.parts.reduce((a, id) => a + (items.find(i => i.id === id)?.price || 0), 0) : 0;
  const saveCombo = async () => {
    const name = draft!.name.trim() || draft!.parts.map(id => items.find(i => i.id === id)!.name).join(' + ');
    const { error } = await staff.from('combos').insert({ stall_id: stall.id, name, item_ids: draft!.parts, price: parseInt(draft!.price, 10) });
    if (error) return toast('Not saved', friendly(error));
    setDraft(null); reloadItems();
  };
  return (
    <Page gap="var(--space-3)">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-2)', padding: '0 var(--space-2)' }}>
        <h2 className="display" style={{ fontSize: 30 }}>Items</h2>
        <button className="btn btn-primary" onClick={() => nav(`/${fair.slug}/owner/items/new`)}>+ Add item</button>
      </div>
      <span style={{ fontSize: 14, padding: '0 var(--space-2)' }}>Photos, prices and stock. Counts drop with every sale; at zero the item shows sold out.</span>
      <div className="stack" style={{ gap: 'var(--space-2)', padding: 'var(--space-3) var(--space-4)', borderRadius: 'var(--radius-lg)', background: 'var(--color-accent-2-100)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-2)' }}><strong>Combos</strong>{!draft && <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => setDraft({ name: '', parts: [], price: '' })}>+ Add combo</button>}</div>
        {combos.map(c => (
          <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <div className="stack" style={{ flex: 1 }}><span style={{ fontSize: 14, fontWeight: 600 }}>{c.name} · ₹{c.price}</span><span style={{ fontSize: 12 }}>{c.item_ids.map(id => items.find(i => i.id === id)?.name).filter(Boolean).join(' + ')}</span></div>
            <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={async () => { await staff.from('combos').delete().eq('id', c.id); reloadItems(); }}>Remove</button>
          </div>
        ))}
        {draft && <>
          <span style={{ fontSize: 13 }}>Pick 2 or more items</span>
          <div className="wrap">{items.map(it => { const on = draft.parts.includes(it.id); return <button key={it.id} aria-pressed={on} className={'chip ' + (on ? 'tag tag-accent' : 'tag tag-outline')} onClick={() => setDraft({ ...draft, parts: on ? draft.parts.filter(x => x !== it.id) : [...draft.parts, it.id] })}>{it.name}</button>; })}</div>
          <span style={{ fontSize: 13 }}>Items add up to ₹{full}</span>
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <input className="input" style={{ flex: 2, minWidth: 0 }} placeholder="Combo name (optional)" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} />
            <input className="input" style={{ flex: 1, minWidth: 0 }} inputMode="numeric" placeholder="₹ price" aria-label="Combo price" value={draft.price} onChange={e => setDraft({ ...draft, price: e.target.value.replace(/\D/g, '') })} />
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}><button className="btn btn-ghost" onClick={() => setDraft(null)}>Cancel</button><button className="btn btn-primary" style={{ flex: 1 }} disabled={draft.parts.length < 2 || !(parseInt(draft.price, 10) > 0)} onClick={saveCombo}>Save combo</button></div>
        </>}
      </div>
      {items.map(m => (
        <div key={m.id} className="stack" style={{ gap: 'var(--space-2)', padding: 'var(--space-3) var(--space-4)', borderRadius: 'var(--radius-lg)', background: 'var(--color-surface)' }}>
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
            {m.photo_path
              ? <div className="avatar washed" role="img" aria-label={m.name} style={{ width: 48, height: 48, backgroundImage: `url(${photoUrl(m.photo_path)})` }} />
              : <div className="avatar" style={{ width: 48, height: 48, border: '2px dashed var(--color-neutral-400)', fontFamily: 'var(--font-body)', fontSize: 11, textAlign: 'center', lineHeight: 1.1 }}>No photo</div>}
            <div className="stack" style={{ flex: 1, gap: 2, minWidth: 0 }}><strong>{m.name}</strong><span style={{ fontSize: 13 }}>₹{m.price} · {sold[m.id] || 0} sold</span></div>
            <Link className="btn btn-ghost" style={{ fontSize: 13 }} to={`/${fair.slug}/owner/items/${m.id}`} aria-label={`Edit ${m.name}`}>Edit</Link>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <button className="btn btn-icon btn-secondary" onClick={() => patch(m.id, { stock: Math.max(0, m.stock - 1) })} aria-label={`Less stock of ${m.name}`}>−</button>
            <strong style={{ minWidth: 28, textAlign: 'center', fontSize: 18, color: m.stock <= 5 ? 'var(--color-accent-700)' : 'var(--color-text)' }}>{m.stock}</strong>
            <button className="btn btn-icon btn-secondary" onClick={() => patch(m.id, { stock: m.stock + 1 })} aria-label={`More stock of ${m.name}`}>+</button>
            <span style={{ fontSize: 13 }}>left</span>
            <div style={{ flex: 1 }} />
            <button className={m.available && m.stock > 0 ? 'btn btn-secondary' : 'btn btn-ghost'} style={{ fontSize: 13 }} onClick={() => patch(m.id, { available: !m.available })}>{m.stock <= 0 ? 'Sold out' : m.available ? 'On sale' : 'Hidden'}</button>
          </div>
        </div>
      ))}
    </Page>
  );
}

function PhotoPicker({ path, label, hint, onFile }: { path: string | null; label: string; hint: string; onFile: (f: File) => void }) {
  return (
    <label style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'center', cursor: 'pointer', padding: 'var(--space-3)', borderRadius: 'var(--radius-lg)', background: 'var(--color-surface)' }}>
      {path ? <div className="avatar washed" role="img" aria-label="Photo" style={{ width: 88, height: 88, backgroundImage: `url(${path.startsWith('blob:') ? path : photoUrl(path)})` }} />
        : <div className="avatar" style={{ width: 88, height: 88, border: '3px dashed var(--color-neutral-400)', fontFamily: 'var(--font-body)', fontSize: 13 }}>+ Photo</div>}
      <div className="stack" style={{ gap: 2 }}><strong>{label}</strong><span style={{ fontSize: 13 }}>{hint}</span></div>
      <input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
    </label>
  );
}

const uploadPhoto = async (stallId: string, file: File) => {
  const blob = await shrinkPhoto(file), path = `${stallId}/${crypto.randomUUID()}.${blob.type === 'image/webp' ? 'webp' : 'jpg'}`;
  const { error } = await staff.storage.from('photos').upload(path, blob, { contentType: blob.type, cacheControl: '31536000' });
  if (error) throw error;
  return path;
};

function ItemEditor() {
  const { itemId = '' } = useParams(), { items, stall, fair, reloadItems, toast } = useO(), nav = useNavigate();
  const it = items.find(i => i.id === itemId), isNew = itemId === 'new';
  const [d, setD] = useState(() => ({ name: it?.name || '', note: it?.note || '', price: it ? String(it.price) : '', stock: it ? String(it.stock) : '10', sizes: (it?.sizes || []).join(', '), tags: it?.tags || [], photo: it?.photo_path || null as string | null }));
  const [busy, setBusy] = useState(false), back = `/${fair.slug}/owner/items`;
  if (!isNew && !it) return null;
  const set = (k: 'name' | 'note' | 'price' | 'stock' | 'sizes') => (e: React.ChangeEvent<HTMLInputElement>) => setD({ ...d, [k]: k === 'price' || k === 'stock' ? e.target.value.replace(/\D/g, '') : e.target.value });
  const pick = async (f: File) => {
    setBusy(true);
    try { setD(x => ({ ...x, photo: null })); const p = await uploadPhoto(stall.id, f); setD(x => ({ ...x, photo: p })); }
    catch (e) { toast('Photo not saved', friendly(e as Error)); }
    setBusy(false);
  };
  const save = async () => {
    setBusy(true);
    const sizes = d.sizes.split(',').map(x => x.trim()).filter(Boolean);
    const row = { name: d.name.trim(), note: d.note.trim() || null, price: parseInt(d.price, 10) || 0, stock: parseInt(d.stock, 10) || 0, sizes: stall.kind === 'goods' && sizes.length ? sizes : null, tags: d.tags, photo_path: d.photo };
    const { error } = isNew ? await staff.from('items').insert({ ...row, stall_id: stall.id, sort: items.length + 1 }) : await staff.from('items').update(row).eq('id', itemId);
    setBusy(false);
    if (error) return toast('Not saved', friendly(error));
    reloadItems(); nav(back);
  };
  const remove = async () => {
    const { error } = await staff.from('items').delete().eq('id', itemId);
    if (error) return toast('Not removed', friendly(error));
    reloadItems(); nav(back);
  };
  return (
    <div style={{ padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <Link className="btn btn-ghost" style={{ alignSelf: 'flex-start' }} to={back}>← Items</Link>
      <Title>{isNew ? 'New item' : 'Edit item'}</Title>
      <PhotoPicker path={d.photo} label={busy && !d.photo ? 'Uploading…' : d.photo ? 'Change photo' : 'Add a photo'} hint="Take a photo or pick one from your gallery" onFile={pick} />
      <div className="field"><label htmlFor="in">Item name</label><input id="in" className="input" placeholder="e.g. Veg puff" value={d.name} onChange={set('name')} /></div>
      <div className="field"><label htmlFor="inote">Short description</label><input id="inote" className="input" placeholder="e.g. Fresh from the oven" value={d.note} onChange={set('note')} /></div>
      <div className="field"><label>Food &amp; allergy tags</label>
        <div className="wrap">{Object.keys(TAGS).map(t => { const on = d.tags.includes(t); return <button key={t} aria-pressed={on} className={'chip ' + (on ? TAGS[t][1] : 'tag tag-outline')} onClick={() => setD({ ...d, tags: on ? d.tags.filter(x => x !== t) : [...d.tags, t] })}>{TAGS[t][0]}</button>; })}</div>
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
        <div className="field" style={{ flex: 1 }}><label htmlFor="ip">Price (₹)</label><input id="ip" className="input" inputMode="numeric" value={d.price} onChange={set('price')} /></div>
        <div className="field" style={{ flex: 1 }}><label htmlFor="is">Stock</label><input id="is" className="input" inputMode="numeric" value={d.stock} onChange={set('stock')} /></div>
      </div>
      {stall.kind === 'goods' && <div className="field"><label htmlFor="isz">Sizes (optional, comma separated)</label><input id="isz" className="input" placeholder="S, M, L" value={d.sizes} onChange={set('sizes')} /></div>}
      <button className="btn btn-primary btn-block" disabled={busy || !d.name.trim() || !(parseInt(d.price, 10) > 0)} onClick={save}>Save item</button>
      {!isNew && <button className="btn btn-ghost btn-block" onClick={remove}>Remove item</button>}
    </div>
  );
}

// ───────────────────────── cash sale ─────────────────────────
function Cash() {
  const { items, stall, reloadOrders, reloadItems, toast } = useO();
  const [qty, setQty] = useState<Record<string, number>>({}), [busy, setBusy] = useState(false);
  const total = items.reduce((a, it) => a + (qty[it.id] || 0) * it.price, 0);
  const record = async () => {
    setBusy(true);
    const { data, error } = await staff.rpc('place_order', { p_stall: stall.id, p_mode: 'cash', p_lines: Object.entries(qty).filter(([, q]) => q > 0).map(([item_id, q]) => ({ item_id, qty: q })) });
    setBusy(false);
    if (error) return toast('Not recorded', friendly(error));
    setQty({}); reloadOrders(); reloadItems();
    toast('Cash sale recorded', `${(data as Order).token} · ₹${total} added to today's sales`);
  };
  return (
    <Page gap="var(--space-3)">
      <Title>Cash sale</Title>
      <span style={{ fontSize: 14, padding: '0 var(--space-2)' }}>For walk-ups paying cash. Tap items to add.</span>
      {items.filter(i => i.available).map(m => {
        const q = qty[m.id] || 0, left = m.stock - q, out = left <= 0;
        return (
          <button key={m.id} disabled={out} onClick={() => setQty({ ...qty, [m.id]: q + 1 })} aria-label={`Add ${m.name}`} style={{ all: 'unset', cursor: out ? 'not-allowed' : 'pointer', display: 'flex', gap: 'var(--space-3)', alignItems: 'center', padding: 'var(--space-3) var(--space-4)', borderRadius: 'var(--radius-lg)', background: q ? 'var(--color-accent-100)' : 'var(--color-surface)', opacity: out && !q ? 0.5 : 1 }}>
            <div className="stack" style={{ flex: 1, gap: 2 }}><strong>{m.name}</strong><span style={{ fontSize: 13 }}>₹{m.price} · {left} left</span></div>
            {q > 0 && <span style={{ fontFamily: 'var(--font-heading)', fontSize: 22, color: 'var(--color-accent-800)' }}>×{q}</span>}
          </button>
        );
      })}
      <div style={{ flex: 1 }} />
      {total > 0 && (
        <div style={{ display: 'flex', gap: 'var(--space-2)', position: 'sticky', bottom: 84 }}>
          <button className="btn btn-ghost" onClick={() => setQty({})}>Clear</button>
          <button className="btn btn-primary" style={{ flex: 1, boxShadow: 'var(--shadow-md)' }} disabled={busy} onClick={record}>Record ₹{total} cash</button>
        </div>
      )}
    </Page>
  );
}

// ───────────────────────── sales, settle-up, close-out ─────────────────────────
function Sales() {
  const { orders, stall, items, fair, causes, saveStall } = useO(), sold = useSold();
  const [received, setReceived] = useState(0);
  useEffect(() => { staff.from('settlements').select('amount').eq('stall_id', stall.id).then(({ data }) => setReceived((data || []).reduce((a, x) => a + x.amount, 0))); }, [stall.id]);
  const paid = orders.filter(o => PAID.includes(o.status)), sum = (os: Order[]) => os.reduce((a, o) => a + o.total, 0);
  const total = sum(paid), cash = sum(paid.filter(o => o.paid_by === 'Cash')), upi = total - cash;
  const school = paid.reduce((a, o) => a + o.school_share, 0), due = Math.max(0, school - received);
  const cause = causes.find(c => c.id === stall.cause_id)?.name || 'School fund';
  const top = items.map(i => ({ name: i.name, qty: sold[i.id] || 0 })).filter(t => t.qty).sort((a, b) => b.qty - a.qty).slice(0, 3);

  const [co, setCo] = useState<Closeout>(stall.closeout || { upi_actual: '', cash_actual: '', note: '', closed: false });
  const diff = (actual: string, rec: number): [string, string] => {
    if (actual === '') return ['', 'var(--color-text)'];
    const d = (parseInt(actual, 10) || 0) - rec;
    return d === 0 ? ['Matches ✓', 'var(--color-accent-2-800)'] : [d < 0 ? `₹${-d} short` : `₹${d} extra`, 'var(--color-accent-800)'];
  };
  const [upiDiff, upiColor] = diff(co.upi_actual, upi), [cashDiff, cashColor] = diff(co.cash_actual, cash);
  const unconf = orders.filter(o => o.status === 'verify').length, holds = orders.filter(o => o.status === 'hold').length;
  const closeDay = (closed: boolean) => { const c = { ...co, closed, closed_at: closed ? new Date().toISOString() : undefined }; setCo(c); saveStall({ closeout: c }); };
  const headline = `You raised ₹${school} for ${cause}`, sub = `${paid.length} orders today${top[0] ? ` · best seller: ${top[0].name}` : ''}`;

  return (
    <Page>
      <Title>Today's sales</Title>
      <div className="stack" style={{ background: 'var(--color-accent-2)', color: 'var(--color-bg)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-6)', gap: 'var(--space-1)' }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>Total collected</span>
        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 56, lineHeight: 1 }}>₹{total}</span>
        <span style={{ fontSize: 14 }}>{paid.length} orders · UPI ₹{upi} · Cash ₹{cash}</span>
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
        <div className="stack" style={{ flex: 1, padding: 'var(--space-4)', borderRadius: 'var(--radius-lg)', background: 'var(--color-accent-2-100)' }}><span style={{ fontSize: 13 }}>To school · {stall.cut_pct}%</span><strong style={{ fontSize: 22 }}>₹{school}</strong></div>
        <div className="stack" style={{ flex: 1, padding: 'var(--space-4)', borderRadius: 'var(--radius-lg)', background: 'var(--color-surface)' }}><span style={{ fontSize: 13 }}>You keep</span><strong style={{ fontSize: 22 }}>₹{total - school}</strong></div>
      </div>
      <div className="stack" style={{ gap: 'var(--space-2)', padding: 'var(--space-4)', borderRadius: 'var(--radius-lg)', background: 'var(--color-accent-2-100)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-2)' }}>
          <h3 className="display" style={{ fontSize: 22 }}>Settle with school</h3>{school > 0 && due === 0 && <span className="tag tag-accent-2">Settled ✓</span>}
        </div>
        <div className="row" style={{ fontSize: 14 }}><span>School share so far</span><strong>₹{school}</strong></div>
        <div className="row" style={{ fontSize: 14 }}><span>Already received by school</span><strong>₹{received}</strong></div>
        <div className="row" style={{ fontSize: 16 }}><strong>Still to pay</strong><strong>₹{due}</strong></div>
        {due > 0 && <>
          <a className="btn btn-primary btn-block" style={{ textDecoration: 'none' }} href={upiLink({ pa: fair.school_upi, pn: 'School fund', am: due, tn: `${stall.name} school share` })}>Pay ₹{due} to school via UPI</a>
          <span style={{ fontSize: 12 }}>Goes to {fair.school_upi}. The school admin marks it received.</span>
        </>}
      </div>
      <div className="stack" style={{ gap: 'var(--space-3)', padding: 'var(--space-4)', borderRadius: 'var(--radius-lg)', background: 'var(--color-surface)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-2)' }}>
          <h3 className="display" style={{ fontSize: 22 }}>End-of-day match-up</h3>{co.closed && <span className="tag tag-accent-2">Closed {co.closed_at ? time(co.closed_at) : ''}</span>}
        </div>
        <span style={{ fontSize: 13 }}>Check what actually came in against what the app recorded.</span>
        {!co.closed && unconf + holds > 0 && <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-accent-700)' }}>
          {[unconf ? `${unconf} UPI payment${unconf > 1 ? 's' : ''} not yet confirmed` : '', holds ? `${holds} hold${holds > 1 ? 's' : ''} still open` : ''].filter(Boolean).join(' · ')} — sort these first.</span>}
        <div className="stack" style={{ gap: 'var(--space-1)' }}>
          <div className="row" style={{ fontSize: 14 }}><span>App recorded UPI</span><strong>₹{upi}</strong></div>
          <div className="field"><label htmlFor="ua">Your UPI app shows (₹)</label><input id="ua" className="input" inputMode="numeric" placeholder="Total received today" value={co.upi_actual} disabled={co.closed} onChange={e => setCo({ ...co, upi_actual: e.target.value.replace(/\D/g, '') })} /></div>
          <span style={{ fontSize: 13, fontWeight: 600, color: upiColor }} aria-live="polite">{upiDiff}</span>
        </div>
        <div className="stack" style={{ gap: 'var(--space-1)' }}>
          <div className="row" style={{ fontSize: 14 }}><span>App recorded cash</span><strong>₹{cash}</strong></div>
          <div className="field"><label htmlFor="ca">Cash counted in the box (₹)</label><input id="ca" className="input" inputMode="numeric" placeholder="Leave out your starting change" value={co.cash_actual} disabled={co.closed} onChange={e => setCo({ ...co, cash_actual: e.target.value.replace(/\D/g, '') })} /></div>
          <span style={{ fontSize: 13, fontWeight: 600, color: cashColor }} aria-live="polite">{cashDiff}</span>
        </div>
        <div className="field"><label htmlFor="cn">Note (optional)</label><input id="cn" className="input" placeholder="e.g. Gave ₹20 change from my own pocket" value={co.note} disabled={co.closed} onChange={e => setCo({ ...co, note: e.target.value })} /></div>
        {co.closed ? <button className="btn btn-ghost btn-block" onClick={() => closeDay(false)}>Reopen</button>
          : <button className="btn btn-primary btn-block" disabled={co.upi_actual === '' || co.cash_actual === ''} onClick={() => closeDay(true)}>Close the day</button>}
      </div>
      <div className="stack" style={{ gap: 'var(--space-2)', padding: 'var(--space-6)', borderRadius: 'var(--radius-lg)', background: 'var(--color-accent-100)' }}>
        <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--color-accent-800)' }}>Thank you!</span>
        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 28, lineHeight: 1.15 }}>{headline}</span>
        <span style={{ fontSize: 14 }}>{sub}</span>
        <a className="btn btn-secondary" style={{ textDecoration: 'none', alignSelf: 'flex-start' }} target="_blank" rel="noopener" href={wa(null, `${stall.name} at the school fair: ${headline}! ${sub}. Thank you to everyone who came by 🙏`)}>Share on WhatsApp</a>
      </div>
      {top.length > 0 && <span className="label-caps">Best sellers</span>}
      {top.map(t => <div key={t.name} className="row" style={{ padding: 'var(--space-3) var(--space-4)', borderRadius: 'var(--radius-lg)', background: 'var(--color-surface)' }}><span>{t.name}</span><strong>{t.qty} sold</strong></div>)}
    </Page>
  );
}

// ───────────────────────── stall setup ─────────────────────────
const esc = (t: string) => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function printList(stall: OwnStall, items: Item[], combos: Combo[], cause: string, qr: string) {
  const row = (n: string, note: string, p: number) => `<div class="r"><div><strong>${esc(n)}</strong>${note ? `<div class="n">${esc(note)}</div>` : ''}</div><strong class="p">₹${p}</strong></div>`;
  const tagText = (t: string[]) => t.map(x => TAGS[x]?.[0]).filter(Boolean).join(' · ');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(stall.name)} price list</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Caprasimo&family=Figtree:wght@400;700&display=swap">
<style>body{margin:0;background:#f5ead8;color:#201e1d;font-family:Figtree,system-ui,sans-serif}.w{max-width:720px;padding:48px}h1,h2{font-family:Caprasimo,serif;font-weight:400}
h1{font-size:56px;margin:0 0 8px}h2{font-size:28px;margin:24px 0 0}.r{display:flex;justify-content:space-between;gap:24px;padding:14px 0;font-size:22px}.n{font-size:15px}.p{font-size:26px}
.q{display:flex;gap:24px;align-items:center;margin-top:40px;padding:24px;border-radius:28px;background:#ebddc5}.q img{width:180px;height:180px;background:#fff;border-radius:16px;padding:8px}
@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}</style></head><body><div class="w">
<h1>${esc(stall.name)}</h1><div style="font-size:18px;margin-bottom:24px">${esc([stall.hours, (stall.cut_pct >= 100 ? 'Every rupee' : stall.cut_pct + '% of sales') + ' goes to ' + cause].filter(Boolean).join(' · '))}</div>
${combos.length ? '<h2>Combos</h2>' + combos.map(c => row(c.name, c.item_ids.map(id => items.find(i => i.id === id)?.name).filter(Boolean).join(' + '), c.price)).join('') : ''}
<h2>${menuLabel(stall)}</h2>${items.filter(i => i.available).map(i => row(i.name, [i.note, tagText(i.tags)].filter(Boolean).join(' — '), i.price)).join('')}
<div class="q"><img src="${qr}" alt="QR"><div style="font-size:22px"><strong>Scan to order &amp; pay by UPI</strong><div style="font-size:16px;margin-top:6px">We call your token when it is ready.</div></div></div>
</div><script>setTimeout(function(){print()},800)<\/script></body></html>`;
  const w = window.open('', '_blank'); if (w) { w.document.write(html); w.document.close(); }
}

function StallSetup() {
  const { stall, fair, causes, saveStall, items, combos, toast, logout } = useO();
  const [f, setF] = useState({ name: stall.name, upi_id: stall.upi_id || '', hours: stall.hours || '', owner_name: stall.owner_name, owner_role: stall.owner_role || '', about: stall.about || '', category: stall.category });
  const [helpers, setHelpers] = useState<{ id: string; name: string; phone: string }[]>([]), [hd, setHd] = useState({ name: '', phone: '', pin: '' });
  const loadHelpers = useCallback(() => staff.from('helpers').select('id,name,phone').eq('stall_id', stall.id).order('created_at').then(({ data }) => setHelpers(data || [])), [stall.id]);
  useEffect(() => { loadHelpers(); }, [loadHelpers]);
  const field = (k: keyof typeof f) => ({ value: f[k], onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value }),
    onBlur: () => { const v = f[k].trim(); if ((k === 'name' || k === 'owner_name') && !v) return setF({ ...f, [k]: stall[k] }); if (v !== (stall[k] || '')) saveStall({ [k]: v || null }); } });
  const builtIn = ['Food', 'Clothes', 'Crafts'], isOther = !builtIn.includes(f.category);
  const pickCat = (c: string) => { const category = c === 'Other' ? (isOther ? f.category : 'Other') : c; setF({ ...f, category }); saveStall({ category, kind: c === 'Food' ? 'food' : 'goods' }); };
  const qrLink = stallUrl(fair.slug, stall.id), qr = qrSvg(qrLink), cause = causes.find(c => c.id === stall.cause_id)?.name || 'School fund';
  const addHelper = async () => {
    const { error } = await staff.rpc('add_helper', { p_name: hd.name, p_phone: hd.phone, p_pin: hd.pin });
    if (error) return toast('Helper not added', friendly(error));
    toast('Helper added', `${hd.name.trim()} logs in with ${digits(hd.phone)} and PIN ${hd.pin}`); setHd({ name: '', phone: '', pin: '' }); loadHelpers();
  };
  const pickPhoto = async (file: File) => {
    try { saveStall({ photo_path: await uploadPhoto(stall.id, file) }); }
    catch (e) { toast('Photo not saved', friendly(e as Error)); }
  };
  return (
    <Page>
      <Title>My stall</Title>
      <span style={{ fontSize: 14, padding: '0 var(--space-2)' }}>Everything customers see about your stall. Changes go live instantly.</span>
      <PhotoPicker path={stall.photo_path} label="Stall photo" hint="Your stall, your food or your logo" onFile={pickPhoto} />
      <div className="field"><label htmlFor="sn">Stall name</label><input id="sn" className="input" {...field('name')} /></div>
      <div className="field"><label htmlFor="su">UPI ID for payments</label><input id="su" className="input" placeholder="e.g. priya.rao@okaxis" autoCapitalize="none" {...field('upi_id')} />
        {!stall.upi_id && <span style={{ fontSize: 12, color: 'var(--color-accent-800)', fontWeight: 600 }}>Customers can't pay by UPI until you add this.</span>}</div>
      <div className="field"><label>What do you sell?</label>
        <div className="wrap">{[...builtIn, 'Other'].map(c => { const on = c === 'Other' ? isOther : f.category === c; return <button key={c} aria-pressed={on} className={on ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => pickCat(c)}>{c}</button>; })}</div>
        {isOther && <input className="input" style={{ marginTop: 'var(--space-2)' }} aria-label="Other category" placeholder="e.g. Books, Plants, Toys, Games" value={f.category === 'Other' ? '' : f.category}
          onChange={e => setF({ ...f, category: e.target.value || 'Other' })} onBlur={() => saveStall({ category: f.category.trim() || 'Other' })} />}
      </div>
      <div className="field"><label htmlFor="sh">Open hours</label><input id="sh" className="input" placeholder="e.g. 10 am – 1 pm" {...field('hours')} /></div>
      <div className="field"><label htmlFor="so">Your name</label><input id="so" className="input" {...field('owner_name')} /></div>
      <div className="field"><label htmlFor="sr">How you're connected to the school</label><input id="sr" className="input" placeholder="e.g. Parent · Class 4B" {...field('owner_role')} /></div>
      <div className="field"><label htmlFor="sa">About you &amp; the stall</label><textarea id="sa" className="input" style={{ borderRadius: 'var(--radius-md)', minHeight: 96, resize: 'vertical' }} {...field('about')} /></div>
      <div className="field"><label>Your sales support</label>
        <div className="wrap">{causes.map(c => <button key={c.id} aria-pressed={stall.cause_id === c.id} style={{ fontSize: 14 }} className={stall.cause_id === c.id ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => saveStall({ cause_id: c.id })}>{c.name}</button>)}</div>
        <span style={{ fontSize: 12 }}>Causes are set up by the school admin.</span>
      </div>
      <div className="row" style={{ padding: 'var(--space-3) var(--space-4)', borderRadius: 'var(--radius-lg)', background: 'var(--color-accent-2-100)' }}><span>School share (set by admin)</span><strong>{stall.cut_pct}%</strong></div>
      <div style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'center', background: 'var(--color-surface)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-4)' }}>
        <img src={qr} alt="Stall QR code" style={{ width: 112, height: 112, flex: 'none', borderRadius: 'var(--radius-md)', background: '#fff', padding: 6 }} />
        <div className="stack" style={{ gap: 'var(--space-2)', minWidth: 0 }}><strong>Print &amp; stick at the stall</strong><span style={{ fontSize: 13 }}>Scanning opens your menu directly.</span>
          <span style={{ fontSize: 11, wordBreak: 'break-all' }}>{qrLink}</span>
          <a className="btn btn-secondary" style={{ alignSelf: 'flex-start', textDecoration: 'none' }} href={qr} download={stall.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '-qr.svg'}>Download QR</a></div>
      </div>
      <button className="btn btn-secondary btn-block" onClick={() => printList(stall, items, combos, cause, qr)}>Print price list with QR</button>
      <div className="stack" style={{ gap: 'var(--space-3)', padding: 'var(--space-4)', borderRadius: 'var(--radius-lg)', background: 'var(--color-surface)' }}>
        <h3 className="display" style={{ fontSize: 22 }}>Helpers</h3>
        <span style={{ fontSize: 13 }}>Volunteers who log in with their own PIN. They can take orders and cash sales, not change prices or see totals.</span>
        {helpers.map(h => (
          <div key={h.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <div className="stack" style={{ flex: 1 }}><strong style={{ fontSize: 14 }}>{h.name}</strong><span style={{ fontSize: 12 }}>{h.phone}</span></div>
            <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={async () => { await staff.from('helpers').delete().eq('id', h.id); loadHelpers(); }} aria-label={`Remove ${h.name}`}>Remove</button>
          </div>
        ))}
        <input className="input" placeholder="Helper name" aria-label="Helper name" value={hd.name} onChange={e => setHd({ ...hd, name: e.target.value })} />
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <input className="input" style={{ flex: 2, minWidth: 0 }} inputMode="tel" placeholder="WhatsApp no." aria-label="Helper WhatsApp number" value={hd.phone} onChange={e => setHd({ ...hd, phone: e.target.value })} />
          <input className="input" style={{ flex: 1, minWidth: 0 }} inputMode="numeric" placeholder="PIN" aria-label="Helper PIN" value={hd.pin} onChange={e => setHd({ ...hd, pin: e.target.value.replace(/\D/g, '').slice(0, 4) })} />
        </div>
        <button className="btn btn-secondary" disabled={!hd.name.trim() || digits(hd.phone).length !== 10 || hd.pin.length !== 4} onClick={addHelper}>+ Add helper</button>
        <span style={{ fontSize: 12 }}>Tell them the PIN now — it's stored scrambled and can't be shown again. Forgotten? Remove and add them again.</span>
      </div>
      <button className="btn btn-ghost btn-block" onClick={logout}>Log out</button>
    </Page>
  );
}
