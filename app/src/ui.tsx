import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { enablePush, pushSupported } from './lib';

export const Offline = () => (
  <div role="status" style={{ position: 'fixed', bottom: 'var(--space-3)', left: '50%', transform: 'translateX(-50%)', zIndex: 40, background: 'var(--color-text)', color: 'var(--color-bg)', borderRadius: 999, padding: 'var(--space-2) var(--space-4)', fontSize: 14 }}>
    No connection — waiting for Wi-Fi…
  </div>
);

// "Turn on alerts" for this phone. Hidden where the browser can't do Web Push (WhatsApp links stay as the fallback).
export function PushButton({ db, label, hint }: { db: SupabaseClient; label: string; hint: string }) {
  const [state, setState] = useState<'off' | 'on' | 'busy' | string>('off');
  useEffect(() => {
    // already allowed on this phone → quietly (re)link it to this login
    if (pushSupported() && Notification.permission === 'granted') enablePush(db, false).then(e => setState(e ? 'off' : 'on'));
  }, [db]);
  if (!pushSupported()) return null;
  if (state === 'on') return <span style={{ fontSize: 13, color: 'var(--color-accent-2-800)', fontWeight: 600, padding: '0 var(--space-2)' }}>✓ Alerts on for this phone</span>;
  return (
    <div className="stack" style={{ gap: 4, padding: 'var(--space-3) var(--space-4)', borderRadius: 'var(--radius-lg)', background: 'var(--color-accent-2-100)' }}>
      <button className="btn btn-secondary" style={{ alignSelf: 'flex-start' }} disabled={state === 'busy'}
        onClick={async () => { setState('busy'); const e = await enablePush(db); setState(e || 'on'); }}>{label}</button>
      <span style={{ fontSize: 12 }}>{state !== 'off' && state !== 'busy' ? state : hint}</span>
    </div>
  );
}
