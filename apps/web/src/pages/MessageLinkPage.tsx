import { decodeMessageUrl, messageTarget } from '@bookclub/shared';
import { Navigate, useLocation } from 'react-router';
import { NotFoundPage } from './NotFoundPage';

/**
 * A Book Club message from iMessage, opened by someone without the app (D220): its payload is in
 * the URL's fragment, which never reached the server; this sends them on to what it is about, an
 * invite, a book or the club's vote, where the usual sign-in and membership gates apply. Anything
 * that is not such a message is not found.
 */
export function MessageLinkPage() {
  const location = useLocation();
  const payload = decodeMessageUrl(`${window.location.origin}${location.pathname}${location.hash}`);
  if (!payload) return <NotFoundPage />;
  return <Navigate to={messageTarget(payload)} replace />;
}
