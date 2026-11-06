import { useEffect, useRef } from 'react';
import type { ChatAttachmentView } from '@bookclub/shared';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';

/**
 * A message's pictures (D203): thumbnails in a grid sized by how many there are, each a button that
 * opens it full size. Width and height come from the server, so the bubble makes room before a
 * picture loads and the list does not jump under the reader.
 */
export function ChatImageGrid({ images, authorName, onOpen }: { images: readonly ChatAttachmentView[]; authorName: string; onOpen: (index: number) => void }) {
  const shown = images.slice(0, 4);
  const more = images.length - shown.length;
  return (
    <div className="chat-images" data-count={Math.min(images.length, 4)} data-testid="chat-images">
      {shown.map((image, i) => (
        <button
          key={image.id}
          type="button"
          className="chat-image"
          data-testid="chat-image"
          aria-label={`Picture ${i + 1} of ${images.length} from ${authorName}. Open it.`}
          onClick={(e) => {
            e.stopPropagation();
            onOpen(i);
          }}
        >
          <img src={image.thumbUrl} width={image.width} height={image.height} alt="" loading="lazy" decoding="async" />
          {more > 0 && i === shown.length - 1 ? (
            <span className="chat-image-more" aria-hidden="true">
              +{more}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

/** How far a finger must travel sideways to go to the next or the previous picture. */
const SWIPE_PX = 50;

/**
 * One picture full size, over everything (D203): Back and Next (also ← → and a swipe), its place in
 * the message's set, Escape or Close to leave. The app's own Modal holds the focus and gives it back.
 */
export function ChatLightbox({ images, index, authorName, onIndex, onClose }: { images: readonly ChatAttachmentView[]; index: number; authorName: string; onIndex: (index: number) => void; onClose: () => void }) {
  const image = images[index];
  const swipeFrom = useRef<number | null>(null);
  const go = (delta: number) => onIndex((index + delta + images.length) % images.length);

  useEffect(() => {
    if (images.length < 2) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') onIndex((index + 1) % images.length);
      else if (e.key === 'ArrowLeft') onIndex((index - 1 + images.length) % images.length);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [images.length, index, onIndex]);

  if (!image) return null;
  return (
    <Modal title={images.length > 1 ? `Picture ${index + 1} of ${images.length}` : 'Picture'} onClose={onClose} wide className="chat-lightbox-modal">
      <div
        className="chat-lightbox"
        data-testid="chat-lightbox"
        onPointerDown={(e) => {
          swipeFrom.current = e.clientX;
        }}
        onPointerUp={(e) => {
          const from = swipeFrom.current;
          swipeFrom.current = null;
          if (from === null || images.length < 2) return;
          if (e.clientX - from <= -SWIPE_PX) go(1);
          else if (e.clientX - from >= SWIPE_PX) go(-1);
        }}
      >
        <img className="chat-lightbox-image" src={image.url} width={image.width} height={image.height} alt={`Picture from ${authorName}`} data-testid="chat-lightbox-image" />
        {images.length > 1 ? (
          <div className="chat-lightbox-nav">
            <button type="button" className="icon-btn" aria-label="Previous picture" data-testid="chat-lightbox-prev" onClick={() => go(-1)}>
              <Icon name="prev" />
            </button>
            <button type="button" className="icon-btn" aria-label="Next picture" data-testid="chat-lightbox-next" onClick={() => go(1)}>
              <Icon name="next" />
            </button>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
