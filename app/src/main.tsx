import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import './organic.css';
import './app.css';
import Customer from './Customer';
import Board from './Board';
import Owner from './Owner';
import Admin from './Admin';

if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');

// A home-screen icon opens "/" — send people back to the fair screen they installed it from.
const LAST = 'stallday-last';
function Remember() {
  const m = useLocation().pathname.match(/^\/[^/]+(\/(owner|admin|board))?/);
  try { if (m) localStorage.setItem(LAST, m[0]); } catch { /* private mode */ }
  return null;
}
function Root() {
  let last = ''; try { last = localStorage.getItem(LAST) || ''; } catch { /* private mode */ }
  return last ? <Navigate to={last} replace /> : <div className="phone" style={{ padding: 'var(--space-8) var(--space-6)' }}><h2 className="display">Stall Day</h2><p>Scan a stall's QR code to start.</p></div>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Remember />
      <Routes>
        <Route path=":slug/board" element={<Board />} />
        <Route path=":slug/owner/*" element={<Owner />} />
        <Route path=":slug/admin" element={<Admin />} />
        <Route path=":slug/*" element={<Customer />} />
        <Route path="*" element={<Root />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
