import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.js';
import './style.css';

const queries = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 10000 } },
});
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queries}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
