import { Icon } from '../components/Icon';

/**
 * Listen from here (D197): the audiobook over the page, one tap away in a reader's footer while it
 * is not there. The tap plays it from the page you are reading, or on from where it is if that is
 * on this page (D186), started in the tap itself (D194). Playing, the audiobook docks in the footer.
 */
export function ListenHere({ onListen }: { onListen: () => void }) {
  return (
    <button type="button" className="listen-here" onClick={onListen} aria-label="Listen from this page" data-testid="listen-here">
      <Icon name="headphones" size={16} />
      <span className="listen-here-label" aria-hidden="true">
        Listen
      </span>
    </button>
  );
}
