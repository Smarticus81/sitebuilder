import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import './index.css';

// Split the Three.js-heavy landing page and the dashboard into separate chunks
// so visiting /app never downloads the WebGL bundle, and vice-versa.
const Landing = lazy(() => import('./Landing.js'));
const App = lazy(() => import('./App.js'));

function Loader() {
  return (
    <div className="grid min-h-screen place-items-center bg-ink">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/10 border-t-teal-400" />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Suspense fallback={<Loader />}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/app" element={<App />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  </StrictMode>,
);
