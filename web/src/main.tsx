/**
 * Application entry point: the first file the browser runs (loaded by index.html).
 *
 * It builds the "providers" every screen relies on and mounts the app into <div id="root">:
 *  - StrictMode: React's development-only checker that surfaces unsafe patterns early (no effect in production).
 *  - QueryClientProvider: the TanStack Query cache that holds all data fetched from the server.
 *  - BrowserRouter: URL-based navigation between screens.
 *  - ToastProvider: the small pop-up messages ("Saved", errors) available from any component.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { ToastProvider } from './components/Toast';
import './index.css';

/**
 * One shared data cache with shop-friendly defaults:
 *  - retry once: a brief hiccup is hidden, a real outage still surfaces quickly;
 *  - no refetch on window focus: this is a single-user local app, and silent reloads while the owner is typing in
 *    a form would be surprising;
 *  - staleTime 10 s: data counts as fresh for 10 seconds, avoiding duplicate requests when moving between tabs.
 *    Writes still refresh what they affect explicitly (see web/src/api/*).
 */
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 10_000 } },
});

const root = document.getElementById('root');
if (!root) throw new Error('Root element missing');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <App />
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
