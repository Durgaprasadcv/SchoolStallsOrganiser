import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import './organic.css';
import './app.css';
import Customer from './Customer';
import Board from './Board';
import Owner from './Owner';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path=":slug/board" element={<Board />} />
        <Route path=":slug/owner/*" element={<Owner />} />
        <Route path=":slug/*" element={<Customer />} />
        <Route path="*" element={<div className="phone" style={{ padding: 'var(--space-8) var(--space-6)' }}><h2 className="display">Stall Day</h2><p>Scan a stall's QR code to start.</p></div>} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
