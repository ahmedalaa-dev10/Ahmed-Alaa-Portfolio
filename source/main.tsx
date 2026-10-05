import { hydrateRoot } from 'react-dom/client';
import Portfolio from './page';
import './globals.css';
import { initAnalytics } from './analytics';
import { initPwa } from './pwa';

initPwa();
hydrateRoot(document.getElementById('root')!, <Portfolio />);
void initAnalytics();
