import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {PwaUpdate} from './components/PwaUpdate';
import App from './App.tsx';
import {ErrorBoundary} from './components/ErrorBoundary.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PwaUpdate />
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
