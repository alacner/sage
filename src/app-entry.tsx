import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { TooltipHost } from './components/TooltipHost';
import './styles/index.css';
import './styles/chat-ux.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /><TooltipHost /></React.StrictMode>,
);
