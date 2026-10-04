import { hydrateRoot } from 'react-dom/client';
import Portfolio from './page';
import './globals.css';

hydrateRoot(document.getElementById('root')!, <Portfolio />);
