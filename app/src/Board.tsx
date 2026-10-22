import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { appUrl, qrSvg, supabase, useFair, type Notice, type Stall } from './lib';
import { Offline } from './ui';

type Tok = { stall_id: string; token: string; status: string; created_at: string };

// TV / laptop by the stalls. Runs signed out: reads only the phone-free views, polled (Realtime can't stream views).
export default function Board() {
  const { slug = '' } = useParams();
  const { fair, offline } = useFair(supabase, slug);
  const [stale, setStale] = useState(false);
  const [stalls, setStalls] = useState<Stall[]>([]), [toks, setToks] = useState<Tok[]>([]), [notices, setNotices] = useState<Notice[]>([]);

  useEffect(() => {
    if (!fair) return;
    const load = async () => {
      const [s, t, n] = await Promise.all([
        supabase.from('stalls_public').select('*').eq('fair_id', fair.id).order('prefix'),
        supabase.from('board_tokens').select('stall_id,token,status,created_at').eq('fair_id', fair.id).order('created_at'),
        supabase.from('notices_public').select('*').eq('fair_id', fair.id).order('created_at', { ascending: false }),
      ]);
      // keep the last good data on a failed poll (weak school Wi-Fi)
      if (s.data) setStalls(s.data); if (t.data) setToks(t.data); if (n.data) setNotices(n.data);
      setStale(!!(s.error || t.error || n.error));
    };
    load(); const t = setInterval(load, 5000); return () => clearInterval(t);
  }, [fair]);

  if (!fair) return offline ? <Offline /> : null;
  return (
    <div style={{ minHeight: '100dvh', background: 'var(--color-bg)', padding: 'var(--space-6)' }}>
      <div style={{ background: 'var(--color-accent-2-800)', color: 'var(--color-bg)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-8)', display: 'flex', flexDirection: 'column', gap: 'var(--space-6)', minHeight: 'calc(100dvh - 2 * var(--space-6))' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
          <h2 className="display" style={{ fontSize: 40 }}>Ready for pickup</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)' }}>
            <span style={{ fontSize: 16, maxWidth: 200 }}>Scan to see every stall &amp; order</span>
            <img src={qrSvg(appUrl(fair.slug))} alt="Fair QR code" style={{ width: 120, height: 120, borderRadius: 'var(--radius-md)', background: '#fff', padding: 6 }} />
          </div>
        </div>
        {notices.length > 0 && (
          <div className="wrap" style={{ gap: 'var(--space-3)' }}>
            {notices.map(n => <div key={n.id} style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', padding: 'var(--space-2) var(--space-4)', borderRadius: 999, background: 'var(--color-accent-2-700)', fontSize: 17 }}><strong>{n.kind}:</strong><span>{n.text}</span></div>)}
          </div>
        )}
        {stale && <Offline />}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 'var(--space-6)' }}>
          {stalls.map(st => {
            const mine = toks.filter(t => t.stall_id === st.id), ready = mine.filter(t => t.status === 'ready'), prep = mine.filter(t => t.status !== 'ready').map(t => t.token);
            return (
              <div key={st.id} className="stack" style={{ gap: 'var(--space-3)', background: 'var(--color-accent-2-700)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-6)' }}>
                <strong style={{ fontSize: 20 }}>{st.name}</strong>
                <div className="wrap" style={{ minHeight: 64 }}>
                  {ready.map(t => <span key={t.token} style={{ fontFamily: 'var(--font-heading)', fontSize: 36, lineHeight: 1, background: 'var(--color-bg)', color: 'var(--color-accent-2-900)', borderRadius: 999, padding: 'var(--space-3) var(--space-4)' }}>{t.token}</span>)}
                  {!ready.length && <span style={{ fontSize: 16, alignSelf: 'center' }}>Nothing ready yet</span>}
                </div>
                <span style={{ fontSize: 15 }}>{prep.length ? `${st.kind === 'food' ? 'Preparing' : 'Packing'}: ${prep.join(', ')}` : 'No queue'}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
