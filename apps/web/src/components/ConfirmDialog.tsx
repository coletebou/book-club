import { useId } from 'react';
import { Modal } from './Modal';

export interface ConfirmOptions {
  /** The question, short: "Delete your note?" */
  readonly title: string;
  /** What follows from it, in a line: "It goes for everyone in the club." */
  readonly body?: string;
  /** The answer that does it: "Delete". */
  readonly confirm: string;
  /** The answer that does nothing, which has the focus: "Keep". */
  readonly cancel?: string;
  /** Not to be undone: the answer that does it is in the danger colour, not gold. */
  readonly danger?: boolean;
}

/**
 * The app's own question before something is done for good, on its Modal (the browser's confirm()
 * is a grey system alert headed with the site's address on an iPhone). The safe answer has the
 * focus; Escape, the close button and the backdrop answer no; a screen reader hears the question
 * and what follows from it.
 */
export function ConfirmDialog({ title, body, confirm, cancel = 'Cancel', danger = false, onAnswer }: ConfirmOptions & { readonly onAnswer: (yes: boolean) => void }) {
  const bodyId = useId();
  return (
    <Modal
      title={title}
      role="alertdialog"
      describedBy={body ? bodyId : undefined}
      className="modal-confirm"
      initialFocus="[data-safe]"
      onClose={() => onAnswer(false)}
      footer={
        <>
          <button type="button" className="btn" data-safe="" onClick={() => onAnswer(false)}>
            {cancel}
          </button>
          <button type="button" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => onAnswer(true)}>
            {confirm}
          </button>
        </>
      }
    >
      {body ? (
        <p id={bodyId} className="muted">
          {body}
        </p>
      ) : null}
    </Modal>
  );
}
