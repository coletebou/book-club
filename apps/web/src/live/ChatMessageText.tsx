import { Fragment, useMemo } from 'react';
import { segmentText } from '@bookclub/chat-core';
import type { ChatQuote as ChatQuoteView, RevealedChatMessage } from '@bookclub/shared';
import { Icon } from '../components/Icon';
import { spansOf } from '../lib/chat-model';

/**
 * A message's words with its @-mentions highlighted (D201): exactly the spans the server read
 * (the source of truth, which also notified those people), never a second guess made here. A
 * mention of the person looking is marked apart, as is a mention of an agent.
 */
export function ChatMessageText({ message, selfId }: { message: RevealedChatMessage; selfId: string | undefined }) {
  const segments = useMemo(() => segmentText(message.text ?? '', spansOf(message)), [message]);
  return (
    <>
      {segments.map((s, i) => {
        if (s.kind === 'text') return <Fragment key={i}>{s.text}</Fragment>;
        const me = s.target.kind === 'member' && s.target.id === selfId;
        const agent = s.target.kind === 'agent';
        return (
          <span
            key={i}
            className={`chat-mention${me ? ' is-me' : ''}${agent ? ' is-agent' : ''}`}
            data-testid="chat-mention"
            data-me={me ? 'true' : undefined}
            data-mention-user={s.target.kind === 'member' ? s.target.id : undefined}
            data-mention-agent={s.target.kind === 'agent' ? s.target.handle : undefined}
          >
            {s.text}
          </span>
        );
      })}
    </>
  );
}

/**
 * A reply's quote of what it answers (D200), as the server gated it for this viewer: its words in
 * brief, or only where it opens while it is still ahead of them, or that it was deleted. Tapping
 * it goes to that message (ChatPanel's `jumpTo`): in place when it is on screen, else in its thread.
 */
export function ChatQuote({ quote, onOpen }: { quote: ChatQuoteView; onOpen: () => void }) {
  const what = quote.deleted ? 'a deleted message' : `${quote.author.displayName}'s message`;
  return (
    <button
      type="button"
      className="chat-quote"
      data-testid="chat-quote"
      data-quote-id={quote.id}
      data-hidden={quote.hidden ? 'true' : undefined}
      aria-label={`In reply to ${what}. Go to it.`}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
    >
      <span className="chat-quote-author" style={{ color: quote.author.color }}>
        {quote.author.displayName}
      </span>
      <span className="chat-quote-text">
        {quote.deleted ? (
          <em>Message deleted</em>
        ) : quote.hidden ? (
          <>
            <Icon name="lock" size={12} /> {quote.spoilerLabel}
          </>
        ) : quote.text ? (
          <>
            {quote.text}
            {quote.imageCount > 0 ? <span className="chat-quote-pictures"> · <Icon name="camera" size={12} /></span> : null}
          </>
        ) : quote.imageCount > 0 ? (
          <>
            <Icon name="camera" size={12} /> {quote.imageCount === 1 ? 'Picture' : `${quote.imageCount} pictures`}
          </>
        ) : null}
      </span>
    </button>
  );
}
