import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toasts';
import { setChatDndEnabled, useChatDnd } from '../lib/queries';

/**
 * Do Not Disturb (D173): quiet for chat and mentions, everywhere, until turned off again — one
 * switch per person, shown on the chat/voice screen wherever it is opened (ChatPage, or the sheet
 * over the reader/player). A mention still lands in the bell while this is on; it just does not
 * buzz the phone or pop a toast (services/notifications.ts `deliver`, Notifications.tsx).
 */
export function DndToggle() {
  const qc = useQueryClient();
  const toast = useToast();
  const dnd = useChatDnd();
  const [busy, setBusy] = useState(false);
  const on = dnd.data?.enabled ?? false;

  const toggle = async () => {
    setBusy(true);
    try {
      await setChatDndEnabled(qc, !on);
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Could not change that.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className="icon-btn"
      aria-pressed={on}
      aria-label={on ? 'Turn off Do Not Disturb' : 'Turn on Do Not Disturb for chat'}
      title={on ? 'Do Not Disturb is on: no chat pushes or toasts' : 'Do Not Disturb'}
      data-testid="chat-dnd-toggle"
      disabled={busy}
      onClick={() => void toggle()}
    >
      <Icon name="moon" />
    </button>
  );
}
