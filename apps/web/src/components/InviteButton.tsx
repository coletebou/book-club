import { useState } from 'react';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { useToast } from './Toasts';

/** Share the club's invite link: native share sheet on the phone, copy elsewhere. */
export function InviteButton({ url, canRenew = false }: { url: string; canRenew?: boolean }) {
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.show('Invite link copied.');
    } catch {
      toast.show('Select the link and copy it.', 'error');
    }
  };
  const share = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Join my book club', url });
        toast.show('Invite sent.');
      } catch (err) {
        // Closing the share sheet is not an error, and nothing was copied.
        if (!(err instanceof DOMException && err.name === 'AbortError')) toast.show('That did not work: copy the link instead.', 'error');
      }
      return;
    }
    await copy();
  };
  return (
    <>
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        <Icon name="link" size={18} /> Invite
      </button>
      {open ? (
        <Modal
          title="Invite a friend"
          onClose={() => setOpen(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => void copy()}>
                Copy link
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void share()}>
                Share…
              </button>
            </>
          }
        >
          <p className="muted">
            Anyone with this link can join the club.{canRenew ? ' You can replace it in the club settings.' : ' The club’s owner can replace it.'}
          </p>
          <label className="field">
            <span className="visually-hidden">Invite link</span>
            <input readOnly value={url} data-testid="invite-url" onFocus={(e) => e.currentTarget.select()} />
          </label>
        </Modal>
      ) : null}
    </>
  );
}
