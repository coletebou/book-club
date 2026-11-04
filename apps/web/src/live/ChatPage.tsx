import { useRef } from 'react';
import { Link, useParams } from 'react-router';
import { Icon } from '../components/Icon';
import { useSeenArea } from '../components/Modal';
import { useBooks, useClub, useSession } from '../lib/queries';
import { ChatPanel } from './ChatPanel';
import { DndToggle } from './DndToggle';
import { VoiceBar } from './VoiceBar';

/** /clubs/:clubId/chat: live text chat and the club's voice channel (D150-D154, D173). */
export default function ChatPage() {
  const { clubId = '' } = useParams();
  const club = useClub(clubId);
  const books = useBooks(clubId);
  const session = useSession();
  // The composer stays above the iOS keyboard (D88/D173): a phone's keyboard shrinks the visual
  // viewport without shrinking `100dvh` in this app's WebView, which `useSeenArea` (Modal.tsx)
  // already measures for the sheet; the same measurement keeps the standalone page's own composer
  // clear of it, without needing a sheet of its own.
  const pageRef = useRef<HTMLDivElement>(null);
  useSeenArea(pageRef);

  if (club.isPending) {
    return (
      <div className="center-page">
        <div className="spinner" role="status" aria-label="Loading chat" />
      </div>
    );
  }

  return (
    <div className="chat-page" ref={pageRef}>
      <header className="reader-header">
        <Link to={`/clubs/${clubId}`} className="icon-btn" aria-label="Back to the club">
          <Icon name="back" />
        </Link>
        <div className="reader-title">
          <span className="reader-book">{club.data?.name ?? 'Chat'}</span>
        </div>
        <DndToggle />
      </header>
      <VoiceBar clubId={clubId} />
      <ChatPanel clubId={clubId} books={books.data ?? []} selfId={session.data?.user?.id} />
    </div>
  );
}
