import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <main id="main" className="center-page">
      <h1>Nothing here</h1>
      <p className="muted">This page does not exist.</p>
      <Link className="btn" to="/">
        Go to your clubs
      </Link>
    </main>
  );
}
