import { Modal } from '../components/Modal';
import { useBooks, useClub, useSession } from '../lib/queries';
import { ChatPanel } from './ChatPanel';
import { DndToggle } from './DndToggle';
import { VoiceBar } from './VoiceBar';

/**
 * The club's chat and voice, over whatever you were doing (D173): opened from the reader and the
 * player's own header ("open the club's chat and voice"), so a question for the club never costs
 * your place in the book or the audiobook playing — both keep going underneath, exactly as they
 * do behind the reader's own TOC/settings sheets. Not a route: this is the same `ChatPanel` and
 * `VoiceBar` the standalone `/clubs/:clubId/chat` page uses, inside the shared `Modal` sheet.
 */
export function ChatSheet({ clubId, onClose }: { clubId: string; onClose: () => void }) {
  const club = useClub(clubId);
  const books = useBooks(clubId);
  const session = useSession();
  return (
    <Modal title={club.data?.name ?? 'Chat'} onClose={onClose} wide className="chat-sheet-modal" initialFocus='[data-testid="chat-input"]'>
      {/* Laid over the modal's own header (live.css's `.chat-sheet-dnd`, positioned against the
          `.chat-sheet-modal` class above) — next to the title and the close button, not beside
          the voice line below, which is about who is listening, not about notifications. */}
      <div className="chat-sheet-dnd">
        <DndToggle />
      </div>
      <div className="chat-sheet-body" data-testid="chat-sheet">
        <div className="chat-sheet-top">
          <VoiceBar clubId={clubId} />
        </div>
        <ChatPanel clubId={clubId} books={books.data ?? []} selfId={session.data?.user?.id} />
      </div>
    </Modal>
  );
}
