import { hydrateRoot } from 'react-dom/client';
import Portfolio from './page';
import './globals.css';
import { initAnalytics } from './analytics';

hydrateRoot(document.getElementById('root')!, <Portfolio />);
void initAnalytics();
