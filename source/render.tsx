import { renderToString } from 'react-dom/server';
import Portfolio from './page';

export function render() {
  return renderToString(<Portfolio />);
}
