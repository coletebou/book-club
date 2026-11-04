import { useAudioState } from './AudioProvider';
import { SpeedButton } from './SpeedControl';

/**
 * The speed, where the reader's docked player and its Now in this book sheet show it (D194): a
 * slot. Custom-speed (D195) puts the button + sheet here — same place, new control — instead of
 * the old fixed-rate select (`PLAYBACK_RATES`).
 */
export function SpeedSlot({ testId = 'dock-speed', compact = false }: { testId?: string; compact?: boolean }) {
  const { book } = useAudioState();
  // Call-site props kept so ReaderDock need not change; SpeedButton owns chrome and test ids.
  void testId;
  void compact;
  if (!book) return null;
  return <SpeedButton bookId={book.id} />;
}
