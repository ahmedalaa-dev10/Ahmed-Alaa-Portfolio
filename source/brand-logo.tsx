import logo from '../favicon.svg?raw';

// This trusted, local SVG is the same approved artwork used for the favicon.
export default function BrandLogo() {
  return <span className="brand-logo" aria-hidden="true" dangerouslySetInnerHTML={{ __html: logo }} />;
}
