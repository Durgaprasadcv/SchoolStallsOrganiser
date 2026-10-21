import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  ALLERGENS, DEFAULT_TEMPLATES, TAGS, UPI_APPS, cutLine, digits, fill, friendly, lineLabel, menuLabel, photoUrl,
  statusInfo, supabase, time, upiLink, wa,
  type Combo, type Fair, type Item, type Notice, type Order, type Stall, type Templates,
} from './lib';

type Me = { id: string; name: string; phone: string };
type Cart = { stallId: string | null; qty: Record<string, number>; donation: number };
type Ctx = {
  fair: Fair; stalls: Stall[]; byId: Record<string, Stall>; causeOf: (s: Stall) => string; tpl: Templates; previews: Record<string, string>;
  me: Me | null; enter: (name: string, phone: string) => Promise<string | null>; logout: () => void;
  cart: Cart; setCart: (c: Cart) => void; toast: (title: string, msg: string) => void;
  myOrders: Order[]; reloadOrders: () => void;
};
const C = createContext<Ctx>(null!);
const useC = () => useContext(C);

const EMPTY_CART: Cart = { stallId: null, qty: {}, donation: 0 };
const ACTIVE = ['verify', 'hold', 'pending', 'ready'];

export const receiptText = (o: Order, st: Stall, cause: string, tpl: Templates) => fill(tpl.receipt, {
  name: o.customer_name, stall: st.name, token: o.token, total: o.total, paidBy: o.paid_by, schoolShare: o.school_share, cause,
  items: (o.order_lines || []).map(i => `${i.qty} × ${lineLabel(i)} — ₹${i.qty * i.price}`).join('\n') + (o.donation ? `\nDonation — ₹${o.donation}` : ''),
});

// ───────────────────────── shell: loads the fair, the customer and their orders ─────────────────────────
export default function Customer() {
  const { slug = '' } = useParams();
  const [fair, setFair] = useState<Fair | null>(null);
  const [missing, setMissing] = useState(false);
  const [stalls, setStalls] = useState<Stall[]>([]);
  const [causes, setCauses] = useState<Record<string, string>>({});
  const [tpl, setTpl] = useState<Templates>(DEFAULT_TEMPLATES);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [cart, setCart] = useState<Cart>(EMPTY_CART);
  const [note, setNote] = useState<{ title: string; msg: string } | null>(null);
  const [myOrders, setMyOrders] = useState<Order[]>([]);
  const timer = useRef<number>(0);

  const toast = useCallback((title: string, msg: string) => {
    clearTimeout(timer.current); setNote({ title, msg }); timer.current = window.setTimeout(() => setNote(null), 4500);
  }, []);

  useEffect(() => {
    (async () => {
      const { data: f } = await supabase.from('fairs').select('id,name,slug,school_upi,payment_check').eq('slug', slug).maybeSingle();
      if (!f) return setMissing(true);
      setFair(f);
      const [{ data: cs }, { data: ts }] = await Promise.all([
        supabase.from('causes').select('id,name').eq('fair_id', f.id),
        supabase.from('templates').select('key,body').eq('fair_id', f.id),
      ]);
      setCauses(Object.fromEntries((cs || []).map(c => [c.id, c.name])));
      setTpl({ ...DEFAULT_TEMPLATES, ...Object.fromEntries((ts || []).map(t => [t.key, t.body])) });
      const { data: { session } } = await supabase.auth.getSession();
      const { data: c } = session ? await supabase.from('customers').select('id,name,phone').eq('id', session.user.id).maybeSingle() : { data: null };
      setMe(c);
    })();
  }, [slug]);

  // Stalls (incl. paused state) — customers can't get Realtime on `stalls`, so poll + refresh on focus.
  useEffect(() => {
    if (!fair) return;
    const load = async () => {
      const { data } = await supabase.from('stalls_public').select('*').eq('fair_id', fair.id).order('prefix');
      if (!data) return;
      setStalls(data);
      const { data: its } = await supabase.from('items').select('stall_id,name').in('stall_id', data.map(s => s.id)).order('sort');
      const p: Record<string, string[]> = {};
      (its || []).forEach(i => (p[i.stall_id] ||= []).push(i.name));
      setPreviews(Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.join(' · ')])));
    };
    load();
    const t = setInterval(load, 15000), vis = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  }, [fair]);

  const reloadOrders = useCallback(async () => {
    if (!me) return setMyOrders([]);
    const { data } = await supabase.from('orders').select('*, order_lines(*)').eq('customer_id', me.id).order('created_at', { ascending: false });
    setMyOrders(data || []);
  }, [me]);

  const byId = useMemo(() => Object.fromEntries(stalls.map(s => [s.id, s])), [stalls]);
  const byIdRef = useRef(byId); byIdRef.current = byId;

  // My orders + "Your order is ready" banner
  useEffect(() => {
    if (!me) return;
    reloadOrders();
    const ch = supabase.channel('my-orders').on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'orders', filter: `customer_id=eq.${me.id}` },
      p => {
        const o = p.new as Order;
        if (o.status === 'ready' && (p.old as Partial<Order>).status !== 'ready')
          toast('Your order is ready', `Token ${o.token} — collect at ${byIdRef.current[o.stall_id]?.name || 'the stall'}`);
        reloadOrders();
      }).subscribe();
    const vis = () => document.visibilityState === 'visible' && reloadOrders();
    document.addEventListener('visibilitychange', vis);
    return () => { supabase.removeChannel(ch); document.removeEventListener('visibilitychange', vis); };
  }, [me, reloadOrders, toast]);

  const enter = async (name: string, phone: string) => {
    if (!name.trim()) return 'Please add your name.';
    if (digits(phone).length !== 10) return 'Enter your 10-digit WhatsApp number.';
    let { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      const r = await supabase.auth.signInAnonymously();
      if (r.error) return friendly(r.error);
      session = r.data.session;
    }
    const row = { id: session!.user.id, fair_id: fair!.id, name: name.trim(), phone: digits(phone) };
    const { error } = await supabase.from('customers').upsert(row);
    if (error) return friendly(error);
    setMe({ id: row.id, name: row.name, phone: row.phone });
    return null;
  };
  const logout = async () => { await supabase.auth.signOut(); setMe(null); setCart(EMPTY_CART); setMyOrders([]); };

  if (missing) return <div className="phone" style={{ padding: 'var(--space-8) var(--space-6)' }}><h2 className="display">Fair not found</h2><p>Check the link or scan the QR code again.</p></div>;
  if (!fair || me === undefined) return <div className="phone" />;

  const ctx: Ctx = { fair, stalls, byId, causeOf: s => (s.cause_id && causes[s.cause_id]) || 'School fund', tpl, previews, me, enter, logout, cart, setCart, toast, myOrders, reloadOrders };
  return (
    <C.Provider value={ctx}>
      <div className="phone">
        {note && <div className="toast" style={{ background: 'var(--color-accent-2-700)' }}><strong style={{ fontSize: 15 }}>{note.title}</strong><span style={{ fontSize: 14 }}>{note.msg}</span></div>}
        <div className="phone-main">
          {!me ? <Entry /> : (
            <Routes>
              <Route index element={<Home />} />
              <Route path="s/:stallId" element={<Menu />} />
              <Route path="s/:stallId/about" element={<About />} />
              <Route path="s/:stallId/cart" element={<CartScreen />} />
              <Route path="o/:orderId" element={<Success />} />
              <Route path="orders" element={<MyOrders />} />
            </Routes>
          )}
        </div>
        {me && <BottomNav />}
      </div>
    </C.Provider>
  );
}

function BottomNav() {
  const { fair, myOrders } = useC(), { pathname } = useLocation();
  if (pathname.endsWith('/cart')) return null;
  const onOrders = pathname.endsWith('/orders'), active = myOrders.filter(o => ACTIVE.includes(o.status)).length;
  return (
    <div className="bottom-nav">
      <Link className={onOrders ? 'btn btn-ghost' : 'btn btn-primary'} style={{ flex: 1 }} to={`/${fair.slug}`}>Stalls</Link>
      <Link className={onOrders ? 'btn btn-primary' : 'btn btn-ghost'} style={{ flex: 1 }} to={`/${fair.slug}/orders`}>My orders{active ? ` (${active})` : ''}</Link>
    </div>
  );
}

// ───────────────────────── entry (after scanning a stall QR, or opening the fair link) ─────────────────────────
function Entry() {
  const { enter, byId, fair } = useC(), { pathname } = useLocation();
  const stall = byId[pathname.match(/\/s\/([^/]+)/)?.[1] || ''];
  const [name, setName] = useState(''), [phone, setPhone] = useState(''), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const go = async () => { setBusy(true); setErr((await enter(name, phone)) || ''); setBusy(false); };
  return (
    <form onSubmit={e => { e.preventDefault(); go(); }} style={{ padding: 'var(--space-8) var(--space-6)', display: 'flex', flexDirection: 'column', gap: 'var(--space-6)', flex: 1 }}>
      <div className="avatar" style={{ width: 120, height: 120, background: 'var(--color-accent-200)', fontSize: 44, color: 'var(--color-accent-800)' }}>{(stall?.name || 'S')[0]}</div>
      <div className="stack" style={{ gap: 'var(--space-2)' }}>
        <span style={{ fontSize: 14, color: 'var(--color-accent-700)', fontWeight: 600 }}>{stall ? 'You scanned the QR at' : 'Welcome to'}</span>
        <h2 className="display" style={{ fontSize: 34 }}>{stall?.name || fair.name}</h2>
        <p style={{ margin: 0, fontSize: 15, lineHeight: 1.5 }}>Tell us who you are so the stall can call your token when it's ready.</p>
      </div>
      <div className="field"><label htmlFor="n">Your name</label><input id="n" className="input" placeholder="e.g. Rahul" autoComplete="name" value={name} onChange={e => setName(e.target.value)} /></div>
      <div className="field"><label htmlFor="p">WhatsApp number</label><input id="p" className="input" placeholder="10-digit mobile" inputMode="tel" autoComplete="tel" value={phone} onChange={e => setPhone(e.target.value)} />
        <span style={{ fontSize: 12 }}>Your token, receipt and "order ready" message come here. Used only for this fair's order updates.</span></div>
      {err && <span className="err" role="alert">{err}</span>}
      <div style={{ flex: 1 }} />
      <span style={{ fontSize: 13 }}>No password or OTP — we remember you on this phone.</span>
      <button className="btn btn-primary btn-block" disabled={busy}>{stall ? 'See the menu' : 'See the stalls'}</button>
    </form>
  );
}

// ───────────────────────── stalls today + lost & found + donate ─────────────────────────
function Home() {
  const { fair, stalls, me, previews } = useC();
  return (
    <div style={{ padding: 'var(--space-6) var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div className="stack" style={{ gap: 2, padding: '0 var(--space-2)' }}>
        <span style={{ fontSize: 14 }}>Hi {me!.name}</span>
        <h2 className="display" style={{ fontSize: 30 }}>Stalls today</h2>
      </div>
      {stalls.map(s => (
        <Link key={s.id} to={`/${fair.slug}/s/${s.id}`} className="card" style={{ textDecoration: 'none', flexDirection: 'row', gap: 'var(--space-3)', alignItems: 'center', color: 'inherit', borderRadius: 'var(--radius-lg)' }}>
          {s.photo_path
            ? <div className="avatar washed" role="img" aria-label={s.name} style={{ width: 56, height: 56, backgroundImage: `url(${photoUrl(s.photo_path)})` }} />
            : <div className="avatar" style={{ width: 56, height: 56, background: 'var(--color-accent-2-200)', fontSize: 24, color: 'var(--color-accent-2-800)' }}>{s.name[0]}</div>}
          <div className="stack" style={{ gap: 4, minWidth: 0 }}>
            <div className="wrap" style={{ alignItems: 'center' }}><strong style={{ fontSize: 17 }}>{s.name}</strong>{s.paused && <span className="tag tag-outline">Back soon</span>}</div>
            <span style={{ fontSize: 13 }}>{[s.category, s.hours, `${s.cut_pct}% to school`].filter(Boolean).join(' · ')}</span>
            <span style={{ fontSize: 13, color: 'var(--color-neutral-700)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{previews[s.id] || ''}</span>
          </div>
        </Link>
      ))}
      <LostFound />
      <Donate />
    </div>
  );
}

function LostFound() {
  const { fair, me, toast } = useC();
  const [notices, setNotices] = useState<Notice[]>([]);
  const [form, setForm] = useState<{ kind: 'Lost' | 'Found'; text: string } | null>(null);
  const load = useCallback(async () => {
    const { data } = await supabase.from('notices_public').select('*').eq('fair_id', fair.id).order('created_at', { ascending: false });
    setNotices(data || []);
  }, [fair.id]);
  useEffect(() => { load(); }, [load]);
  const post = async () => {
    const { error } = await supabase.from('notices').insert({ fair_id: fair.id, kind: form!.kind, text: form!.text.trim().slice(0, 200), by_name: me!.name, by_phone: me!.phone });
    if (error) return toast('Could not post', friendly(error));
    setForm(null); load();
  };
  const kc = { Lost: 'tag tag-accent', Found: 'tag tag-accent-2', Notice: 'tag tag-neutral' };
  return (
    <div className="stack" style={{ gap: 'var(--space-3)', padding: 'var(--space-4)', borderRadius: 'var(--radius-lg)', background: 'var(--color-surface)', marginTop: 'var(--space-2)' }}>
      <h3 className="display" style={{ fontSize: 22 }}>Lost &amp; found</h3>
      {!notices.length && <span style={{ fontSize: 14 }}>Nothing reported right now.</span>}
      {notices.map(n => (
        <div key={n.id} style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-start' }}>
          <span className={kc[n.kind]} style={{ flex: 'none' }}>{n.kind}</span>
          <div className="stack"><span style={{ fontSize: 14 }}>{n.text}</span><span style={{ fontSize: 12 }}>{time(n.created_at)} · {n.by_name || 'Admin'}</span></div>
        </div>
      ))}
      {!form ? <button className="btn btn-secondary" style={{ alignSelf: 'flex-start' }} onClick={() => setForm({ kind: 'Lost', text: '' })}>Report lost or found item</button> : <>
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          {(['Lost', 'Found'] as const).map(k => <button key={k} className={form.kind === k ? 'btn btn-primary' : 'btn btn-ghost'} onClick={() => setForm({ ...form, kind: k })}>I {k === 'Lost' ? 'lost' : 'found'} something</button>)}
        </div>
        <input className="input" maxLength={200} aria-label="Describe the item" placeholder={form.kind === 'Lost' ? 'What did you lose? e.g. Red cardigan, size 8' : 'What did you find, and where?'} value={form.text} onChange={e => setForm({ ...form, text: e.target.value })} />
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <button className="btn btn-ghost" onClick={() => setForm(null)}>Cancel</button>
          <button className="btn btn-primary" style={{ flex: 1 }} disabled={!form.text.trim()} onClick={post}>Post</button>
        </div>
        <span style={{ fontSize: 12 }}>Found items go to the admin desk. Your number is shared only with the admin.</span>
      </>}
    </div>
  );
}

function Donate() {
  const { fair, me, toast } = useC();
  const [amt, setAmt] = useState(50);
  const link = upiLink({ pa: fair.school_upi, pn: 'School fund', am: amt, tn: 'Donation' });
  const record = () => {
    supabase.from('donations').insert({ fair_id: fair.id, customer_id: me!.id, name: me!.name, amount: amt })
      .then(({ error }) => error ? toast('Could not record', friendly(error)) : toast('Thank you!', `₹${amt} to the school fund — that means a lot.`));
  };
  return (
    <div className="stack" style={{ gap: 'var(--space-3)', padding: 'var(--space-4)', borderRadius: 'var(--radius-lg)', background: 'var(--color-accent-2-100)', marginTop: 'var(--space-2)' }}>
      <h3 className="display" style={{ fontSize: 22 }}>Just want to give?</h3>
      <span style={{ fontSize: 14, lineHeight: 1.5 }}>Donate straight to the school fund — no purchase needed.</span>
      <div className="wrap">{[20, 50, 100].map(v => <button key={v} className={amt === v ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => setAmt(v)}>₹{v}</button>)}</div>
      <a className="btn btn-primary btn-block" href={link} onClick={record} style={{ textDecoration: 'none' }}>Donate ₹{amt} via UPI</a>
    </div>
  );
}

// ───────────────────────── stall menu ─────────────────────────
type CartLine = { key: string; item_id: string | null; combo_id: string | null; name: string; size: string | null; qty: number; price: number; parts: string[] };

function useStallMenu(stallId: string) {
  const [items, setItems] = useState<Item[]>([]), [combos, setCombos] = useState<Combo[]>([]);
  useEffect(() => {
    const load = async () => {
      const [{ data: i }, { data: c }] = await Promise.all([
        supabase.from('items').select('*').eq('stall_id', stallId).order('sort'),
        supabase.from('combos').select('*').eq('stall_id', stallId),
      ]);
      setItems(i || []); setCombos(c || []);
    };
    load();
    // stock / sold-out changes arrive live (items are public, so Realtime reaches customers)
    const ch = supabase.channel('items-' + stallId).on('postgres_changes', { event: '*', schema: 'public', table: 'items', filter: `stall_id=eq.${stallId}` }, load).subscribe();
    const vis = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', vis);
    return () => { supabase.removeChannel(ch); document.removeEventListener('visibilitychange', vis); };
  }, [stallId]);
  return { items, combos };
}

const linesFrom = (items: Item[], combos: Combo[], qty: Record<string, number>): CartLine[] =>
  Object.entries(qty).filter(([, q]) => q > 0).flatMap(([key, q]): CartLine[] => {
    if (key.startsWith('combo:')) {
      const c = combos.find(x => x.id === key.slice(6));
      return c ? [{ key, item_id: null, combo_id: c.id, name: c.name, size: null, qty: q, price: c.price, parts: c.item_ids }] : [];
    }
    const [id, size] = key.split('|'), it = items.find(i => i.id === id);
    return it ? [{ key, item_id: id, combo_id: null, name: it.name, size: size || null, qty: q, price: it.price, parts: [id] }] : [];
  });
// how many of an item the cart already uses, counting combo parts
const usedOf = (lines: CartLine[], id: string) => lines.reduce((a, l) => a + l.parts.filter(p => p === id).length * l.qty, 0);

function QtyControl({ qty, add, sub, atMax }: { qty: number; add: () => void; sub: () => void; atMax: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
      <button className="btn btn-icon btn-secondary" onClick={sub} aria-label="Less">−</button>
      <strong style={{ minWidth: 16, textAlign: 'center' }} aria-live="polite">{qty}</strong>
      <button className="btn btn-icon btn-primary" onClick={add} disabled={atMax} aria-label="More">+</button>
    </div>
  );
}

function Menu() {
  const { stallId = '' } = useParams(), { byId, fair, causeOf, cart, setCart } = useC(), nav = useNavigate();
  const stall = byId[stallId], { items, combos } = useStallMenu(stallId);
  const [avoid, setAvoid] = useState<string[]>([]), [sizeSel, setSizeSel] = useState<Record<string, string>>({});
  const qty = cart.stallId === stallId ? cart.qty : {};
  if (!stall) return null;
  const lines = linesFrom(items, combos, qty);
  const setQ = (key: string, n: number) => {
    const q = { ...qty }; if (n <= 0) delete q[key]; else q[key] = n;
    setCart({ stallId, qty: q, donation: cart.stallId === stallId ? cart.donation : 0 });
  };
  const count = lines.reduce((a, l) => a + l.qty, 0), total = lines.reduce((a, l) => a + l.qty * l.price, 0);
  const visible = items.filter(it => !it.tags.some(t => avoid.includes(t))), hidden = items.length - visible.length;

  return (
    <>
      <div style={{ padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', paddingBottom: 110 }}>
        <Link className="btn btn-ghost" style={{ alignSelf: 'flex-start' }} to={`/${fair.slug}`}>← All stalls</Link>
        <div className="stack" style={{ gap: 'var(--space-2)', padding: '0 var(--space-2)' }}>
          {stall.photo_path && <div className="washed" role="img" aria-label={stall.name} style={{ width: '100%', height: 160, borderRadius: 'var(--radius-lg)', marginBottom: 'var(--space-2)', backgroundImage: `url(${photoUrl(stall.photo_path)})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />}
          <span className="tag tag-accent-2" style={{ alignSelf: 'flex-start' }}>{stall.category}</span>
          <h2 className="display" style={{ fontSize: 32 }}>{stall.name}</h2>
          <span style={{ fontSize: 14 }}>by {stall.owner_name}{stall.hours ? ` · ${stall.hours}` : ''}</span>
          <span style={{ fontSize: 14, color: 'var(--color-accent-2-800)', fontWeight: 600 }}>{cutLine(stall.cut_pct, causeOf(stall))}</span>
          <Link className="btn btn-secondary" style={{ alignSelf: 'flex-start' }} to="about">About this stall</Link>
        </div>
        {stall.paused && (
          <div className="stack" style={{ gap: 2, padding: 'var(--space-3) var(--space-4)', borderRadius: 'var(--radius-lg)', background: 'var(--color-accent-100)' }} role="status">
            <strong style={{ color: 'var(--color-accent-800)' }}>Back soon</strong>
            <span style={{ fontSize: 14 }}>{stall.pause_msg || 'Back in a few minutes'} — have a look, ordering is paused.</span>
          </div>
        )}
        {stall.kind === 'food' && (
          <div className="stack" style={{ gap: 'var(--space-2)', padding: '0 var(--space-2)' }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Allergies? Hide items with:</span>
            <div className="wrap">
              {ALLERGENS.map(a => <button key={a} aria-pressed={avoid.includes(a)} className={'chip ' + (avoid.includes(a) ? 'tag tag-accent' : 'tag tag-outline')} onClick={() => setAvoid(avoid.includes(a) ? avoid.filter(x => x !== a) : [...avoid, a])}>{a[0].toUpperCase() + a.slice(1)}</button>)}
            </div>
            {hidden > 0 && <span style={{ fontSize: 13 }}>{hidden} item{hidden > 1 ? 's' : ''} hidden</span>}
            <span style={{ fontSize: 12 }}>Tags are added by the stall owner — please double-check at the stall if it's serious.</span>
          </div>
        )}
        {combos.length > 0 && <>
          <span className="label-caps">Combos</span>
          {combos.map(c => {
            const key = 'combo:' + c.id, q = qty[key] || 0, parts = c.item_ids.map(id => items.find(i => i.id === id)).filter(Boolean) as Item[];
            const full = parts.reduce((a, p) => a + p.price, 0);
            const ok = !stall.paused && parts.length === c.item_ids.length && parts.every(p => p.available && p.stock - usedOf(lines, p.id) > 0);
            return (
              <div key={c.id} style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', padding: 'var(--space-3) var(--space-4)', borderRadius: 'var(--radius-lg)', background: 'var(--color-accent-2-100)' }}>
                <div className="stack" style={{ flex: 1, gap: 2, minWidth: 0 }}>
                  <strong style={{ fontSize: 15 }}>{c.name}</strong>
                  <span style={{ fontSize: 13 }}>{parts.map(p => p.name).join(' + ')}</span>
                  <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline' }}><span style={{ fontSize: 15, fontWeight: 700 }}>₹{c.price}</span>{full > c.price && <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-accent-2-800)' }}>Save ₹{full - c.price}</span>}</div>
                </div>
                {q === 0 ? ok && <button className="btn btn-secondary" onClick={() => setQ(key, 1)}>Add</button>
                  : <QtyControl qty={q} add={() => ok && setQ(key, q + 1)} sub={() => setQ(key, q - 1)} atMax={!ok} />}
              </div>
            );
          })}
        </>}
        <span className="label-caps">{menuLabel(stall)}</span>
        {visible.map(it => {
          const size = it.sizes?.length ? sizeSel[it.id] || it.sizes[0] : null, key = size ? `${it.id}|${size}` : it.id;
          const q = qty[key] || 0, used = usedOf(lines, it.id), soldOut = !it.available || it.stock <= 0;
          return (
            <div key={it.id} className="stack" style={{ gap: 'var(--space-2)', padding: 'var(--space-3)', borderRadius: 'var(--radius-lg)', background: 'var(--color-surface)', opacity: soldOut ? 0.55 : 1 }}>
              <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
                {it.photo_path
                  ? <div className="avatar washed" role="img" aria-label={it.name} style={{ width: 52, height: 52, backgroundImage: `url(${photoUrl(it.photo_path)})` }} />
                  : <div className="avatar" style={{ width: 52, height: 52, background: 'var(--color-accent-100)', fontSize: 20, color: 'var(--color-accent-800)' }}>{it.name[0]}</div>}
                <div className="stack" style={{ flex: 1, gap: 2, minWidth: 0 }}>
                  <strong style={{ fontSize: 15 }}>{it.name}</strong>
                  {it.note && <span style={{ fontSize: 13 }}>{it.note}</span>}
                  {it.tags.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '2px 0' }}>{it.tags.filter(t => TAGS[t]).map(t => <span key={t} className={TAGS[t][1]} style={{ fontSize: 11 }}>{TAGS[t][0]}</span>)}</div>}
                  <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline' }}><span style={{ fontSize: 15, fontWeight: 700 }}>₹{it.price}</span>{!soldOut && it.stock <= 5 && <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-accent-700)' }}>Only {it.stock} left</span>}</div>
                </div>
                {soldOut ? <span className="tag tag-neutral">Sold out</span>
                  : q === 0 ? !stall.paused && used < it.stock && <button className="btn btn-secondary" onClick={() => setQ(key, 1)} aria-label={`Add ${it.name}`}>Add</button>
                  : <QtyControl qty={q} add={() => used < it.stock && setQ(key, q + 1)} sub={() => setQ(key, q - 1)} atMax={used >= it.stock || stall.paused} />}
              </div>
              {it.sizes?.length && !soldOut ? (
                <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', paddingLeft: 64, alignItems: 'center' }}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>Size</span>
                  {it.sizes.map(z => <button key={z} aria-pressed={z === size} className={'chip ' + (z === size ? 'tag tag-accent' : 'tag tag-outline')} onClick={() => setSizeSel({ ...sizeSel, [it.id]: z })}>{z}</button>)}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {count > 0 && !stall.paused && (
        <div className="cart-bar">
          <button className="btn btn-primary btn-block" style={{ justifyContent: 'space-between', boxShadow: 'var(--shadow-md)' }} onClick={() => nav('cart')}>
            <span>{count} items · ₹{total + cart.donation}</span><span>View cart →</span>
          </button>
        </div>
      )}
    </>
  );
}

function About() {
  const { stallId = '' } = useParams(), { byId, causeOf } = useC(), nav = useNavigate(), st = byId[stallId];
  if (!st) return null;
  return (
    <div style={{ padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <button className="btn btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={() => nav(-1)}>← Back</button>
      <div className="avatar" style={{ width: 96, height: 96, background: 'var(--color-accent-2-200)', fontSize: 38, color: 'var(--color-accent-2-800)', marginLeft: 'var(--space-2)' }}>{st.owner_name[0]}</div>
      <div className="stack" style={{ gap: 'var(--space-2)', padding: '0 var(--space-2)' }}>
        <h2 className="display" style={{ fontSize: 30 }}>{st.owner_name}</h2>
        {st.owner_role && <span style={{ fontSize: 14, color: 'var(--color-accent-700)', fontWeight: 600 }}>{st.owner_role}</span>}
        {st.about && <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55, textWrap: 'pretty' }}>{st.about}</p>}
      </div>
      <div className="card" style={{ gap: 'var(--space-3)', borderRadius: 'var(--radius-lg)' }}>
        <div className="row"><span>Stall</span><strong>{st.name}</strong></div>
        {st.hours && <div className="row"><span>Open</span><strong>{st.hours}</strong></div>}
        {st.upi_id && <div className="row"><span>Pays to UPI</span><strong style={{ wordBreak: 'break-all' }}>{st.upi_id}</strong></div>}
        <div className="row"><span>To the school</span><strong>{st.cut_pct}% · {causeOf(st)}</strong></div>
      </div>
    </div>
  );
}

// ───────────────────────── cart + pay ─────────────────────────
function CartScreen() {
  const { stallId = '' } = useParams(), { byId, fair, causeOf, cart, setCart, me, reloadOrders } = useC(), nav = useNavigate();
  const st = byId[stallId], { items, combos } = useStallMenu(stallId);
  const [sheet, setSheet] = useState(false), [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const [paying, setPaying] = useState<{ order: Order; app: (typeof UPI_APPS)[number] } | null>(null);
  if (!st) return null;
  const lines = cart.stallId === stallId ? linesFrom(items, combos, cart.qty) : [];
  const itemsTotal = lines.reduce((a, l) => a + l.qty * l.price, 0), total = itemsTotal + cart.donation;

  const place = async (mode: 'upi' | 'hold', paidBy = 'UPI') => {
    setBusy(true); setErr('');
    const { data, error } = await supabase.rpc('place_order', {
      p_stall: stallId, p_mode: mode, p_paid_by: paidBy, p_donation: cart.donation,
      p_lines: lines.map(l => (l.combo_id ? { combo_id: l.combo_id, qty: l.qty } : { item_id: l.item_id, size: l.size, qty: l.qty })),
    });
    setBusy(false);
    if (error) { setSheet(false); setErr(friendly(error)); return null; }
    return data as Order;
  };
  const done = (o: Order) => { setCart(EMPTY_CART); reloadOrders(); nav(`/${fair.slug}/o/${o.id}`); };
  const pickApp = async (app: (typeof UPI_APPS)[number]) => {
    if (!st.upi_id) return setErr('This stall has not added a UPI ID yet — please pay at the stall.');
    const o = await place('upi', app.paidBy);
    if (!o) return;
    // No auto-redirect: mobile browsers only open another app from a tap, and this runs after an await.
    setSheet(false); setPaying({ order: o, app });
  };
  const cancelPay = async () => {
    await supabase.rpc('set_order_status', { p_order: paying!.order.id, p_status: 'cancelled' });   // puts the stock back
    setPaying(null); reloadOrders();
  };

  if (!lines.length && !paying) return (
    <div style={{ padding: 'var(--space-6) var(--space-4)' }} className="stack">
      <h2 className="display" style={{ fontSize: 30 }}>Your cart is empty</h2>
      <Link className="btn btn-primary btn-block" to={`/${fair.slug}/s/${stallId}`}>See the menu</Link>
    </div>
  );

  return (
    <div style={{ padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', flex: 1 }}>
      <Link className="btn btn-ghost" style={{ alignSelf: 'flex-start' }} to={`/${fair.slug}/s/${stallId}`}>← Keep browsing</Link>
      <h2 className="display" style={{ fontSize: 30, padding: '0 var(--space-2)' }}>Your order</h2>
      <span style={{ fontSize: 14, padding: '0 var(--space-2)' }}>From {st.name}</span>
      <div className="stack" style={{ gap: 'var(--space-2)', background: 'var(--color-surface)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-4)' }}>
        {lines.map(l => <div key={l.key} className="row" style={{ fontSize: 15 }}><span>{l.qty} × {lineLabel(l)}</span><strong>₹{l.qty * l.price}</strong></div>)}
        {cart.donation > 0 && <div className="row" style={{ fontSize: 15 }}><span>Extra for the school</span><strong>₹{cart.donation}</strong></div>}
        <div className="row" style={{ fontSize: 18, paddingTop: 'var(--space-3)', marginTop: 'var(--space-1)', borderTop: '2px dashed var(--color-neutral-300)' }}><strong>Total</strong><strong>₹{total}</strong></div>
        <span style={{ fontSize: 13, color: 'var(--color-accent-2-800)', fontWeight: 600 }}>₹{Math.round(itemsTotal * st.cut_pct / 100) + cart.donation} of this goes to {causeOf(st)}</span>
      </div>
      <div className="stack" style={{ gap: 'var(--space-2)', padding: '0 var(--space-2)' }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>Add a little extra for the school?</span>
        <div className="wrap">{[0, 10, 20, 50].map(v => <button key={v} style={{ fontSize: 14 }} className={cart.donation === v ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => setCart({ ...cart, donation: v })}>{v ? '₹' + v : 'No thanks'}</button>)}</div>
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', fontSize: 14, padding: '0 var(--space-2)', flexWrap: 'wrap' }}><span>Pickup as</span><strong>{me!.name}</strong><span>· {me!.phone}</span></div>
      {err && <span className="err" role="alert" style={{ padding: '0 var(--space-2)' }}>{err}</span>}
      <div style={{ flex: 1 }} />
      <button className="btn btn-primary btn-block" disabled={busy || st.paused} onClick={() => setSheet(true)}>Pay ₹{total} with UPI</button>
      {st.kind === 'goods' && <button className="btn btn-secondary btn-block" disabled={busy || st.paused} onClick={async () => { const o = await place('hold'); if (o) done(o); }}>Hold for 15 min · pay at the stall</button>}

      {sheet && (
        <div className="sheet-backdrop" onClick={e => e.target === e.currentTarget && setSheet(false)}>
          <div className="sheet" role="dialog" aria-label="Pay with">
            <h3 className="display" style={{ fontSize: 24 }}>Pay with</h3>
            <span style={{ fontSize: 14 }}>₹{total} to {st.upi_id || st.name}</span>
            {UPI_APPS.map(a => <button key={a.name} disabled={busy} className="btn btn-secondary btn-block" style={{ justifyContent: 'flex-start' }} onClick={() => pickApp(a)}>{a.name}</button>)}
            <button className="btn btn-ghost" onClick={() => setSheet(false)}>Cancel</button>
          </div>
        </div>
      )}
      {paying && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 20, background: 'var(--color-accent-2-800)', color: 'var(--color-bg)', display: 'flex', justifyContent: 'center' }}>
          <div style={{ width: '100%', maxWidth: 480, display: 'flex', flexDirection: 'column', padding: 'var(--space-8) var(--space-6)', gap: 'var(--space-4)' }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Pay with {paying.app.name}</span>
            <h3 className="display" style={{ fontSize: 30 }}>Everything's filled in — just enter your UPI PIN</h3>
            <div className="stack" style={{ background: 'var(--color-accent-2-700)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-4)', gap: 'var(--space-3)', fontSize: 15 }}>
              <div className="row"><span>To</span><strong>{st.name}</strong></div>
              <div className="row"><span>UPI ID</span><strong style={{ wordBreak: 'break-all' }}>{st.upi_id}</strong></div>
              <div className="row"><span>Amount</span><strong>₹{paying.order.total}</strong></div>
              <div className="row"><span>Note</span><strong>Token {paying.order.token}</strong></div>
            </div>
            <div style={{ flex: 1 }} />
            <a className="btn btn-primary btn-block" style={{ textDecoration: 'none' }} href={upiLink({ pa: st.upi_id!, pn: st.name, am: paying.order.total, tn: `Token ${paying.order.token}` }, paying.app.scheme)}>Open {paying.app.name}</a>
            <button className="btn btn-secondary btn-block" style={{ color: 'var(--color-bg)', borderColor: 'color-mix(in srgb, var(--color-bg) 40%, transparent)' }} onClick={() => done(paying.order)}>Payment done — back to Stall Day</button>
            <button className="btn btn-ghost" style={{ color: 'var(--color-bg)' }} onClick={cancelPay}>Cancel payment</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────────────────── success / token ─────────────────────────
function Success() {
  const { orderId = '' } = useParams(), { byId, fair, causeOf, tpl, myOrders } = useC();
  const o = myOrders.find(x => x.id === orderId), st = o && byId[o.stall_id];
  const [ahead, setAhead] = useState<number | null>(null);
  useEffect(() => {
    if (!o || !['verify', 'pending'].includes(o.status)) return;
    supabase.from('board_tokens').select('token', { count: 'exact', head: true }).eq('stall_id', o.stall_id)
      .in('status', ['verify', 'pending']).lt('created_at', o.created_at).then(({ count }) => setAhead(count ?? 0));
  }, [o?.id, o?.status]);   // eslint-disable-line
  if (!o || !st) return null;
  const isHold = o.status === 'hold', [statusLabel] = statusInfo(o, st.kind);
  const payLabel = isHold ? 'Pay at the stall' : o.status === 'verify' ? 'Awaiting stall confirmation' : statusLabel;
  const aheadText = isHold ? `Kept aside until ${time(o.hold_until!)}` : o.status === 'ready' ? 'Ready — go collect it!'
    : !['verify', 'pending'].includes(o.status) ? statusLabel : ahead ? `${ahead} order${ahead > 1 ? 's' : ''} ahead of you` : ahead === 0 ? "You're next in line" : '';
  return (
    <div style={{ padding: 'var(--space-6) var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div className="stack" style={{ gap: 'var(--space-2)', padding: '0 var(--space-2)' }}>
        <span className="tag tag-accent-2" style={{ alignSelf: 'flex-start' }}>{payLabel}</span>
        <h2 className="display" style={{ fontSize: 30 }}>{isHold ? 'Held for you!' : 'Order placed!'}</h2>
        <span style={{ fontSize: 15 }}>Show this token at {st.name}.</span>
      </div>
      <div className="stack" style={{ background: 'var(--color-accent)', color: 'var(--color-bg)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-6)', gap: 'var(--space-1)' }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>Your token</span>
        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 72, lineHeight: 1 }}>{o.token}</span>
        <span style={{ fontSize: 14 }} aria-live="polite">{aheadText}</span>
      </div>
      <div className="stack" style={{ gap: 'var(--space-2)', background: 'var(--color-surface)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-4)' }}>
        {(o.order_lines || []).map(l => <div key={l.id} className="row" style={{ fontSize: 15 }}><span>{l.qty} × {lineLabel(l)}</span><span>₹{l.qty * l.price}</span></div>)}
        {o.donation > 0 && <div className="row" style={{ fontSize: 15 }}><span>Extra for the school</span><span>₹{o.donation}</span></div>}
        <div className="row" style={{ fontSize: 16, paddingTop: 'var(--space-2)' }}><strong>{o.paid_by}</strong><strong>₹{o.total}</strong></div>
      </div>
      <div className="wrap">
        <a className="btn btn-primary" href={wa(null, receiptText(o, st, causeOf(st), tpl))} target="_blank" rel="noopener" style={{ textDecoration: 'none' }}>Receipt on WhatsApp</a>
        <Link className="btn btn-secondary" to={`/${fair.slug}/s/${st.id}/about`}>Meet the owner</Link>
        <Link className="btn btn-ghost" to={`/${fair.slug}`}>More stalls</Link>
      </div>
    </div>
  );
}

function MyOrders() {
  const { me, myOrders, byId, fair, logout } = useC();
  return (
    <div style={{ padding: 'var(--space-6) var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-2)', padding: '0 var(--space-2)' }}>
        <h2 className="display" style={{ fontSize: 30 }}>My orders</h2>
        <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={logout}>Not {me!.name}?</button>
      </div>
      {!myOrders.length && <p style={{ margin: 0, padding: '0 var(--space-2)' }}>No orders yet. Pick a stall to get started.</p>}
      {myOrders.map(o => {
        const st = byId[o.stall_id]; if (!st) return null;
        const [label, cls] = statusInfo(o, st.kind);
        return (
          <Link key={o.id} to={`/${fair.slug}/o/${o.id}`} style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', padding: 'var(--space-4)', borderRadius: 'var(--radius-lg)', background: 'var(--color-surface)', textDecoration: 'none', color: 'inherit' }}>
            <div className="avatar" style={{ width: 64, height: 64, background: 'var(--color-accent-200)', fontSize: 20, color: 'var(--color-accent-800)' }}>{o.token}</div>
            <div className="stack" style={{ flex: 1, gap: 4, minWidth: 0 }}>
              <strong>{st.name}</strong>
              <span style={{ fontSize: 13 }}>{(o.order_lines || []).map(i => `${i.qty}× ${lineLabel(i)}`).join(', ')}</span>
              <span className={cls} style={{ alignSelf: 'flex-start' }}>{label}</span>
            </div>
          </Link>
        );
      })}
    </div>
  );
}


