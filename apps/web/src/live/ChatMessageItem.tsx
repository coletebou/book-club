import { type MouseEvent as ReactMouseEvent } from 'react';
import type { Run } from '@bookclub/chat-core';
import type { ChatMessageView, ChatQuote as ChatQuoteView } from '@bookclub/shared';
import { Avatar } from '../components/People';
import { Icon } from '../components/Icon';
import { authorKind, mentionsMe } from '../lib/chat-model';
import { AgentAvatar, AgentBadge } from './ChatAgent';
import { ChatImageGrid } from './ChatImages';
import { ChatMessageText, ChatQuote } from './ChatMessageText';

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉'];

/** What a bubble can ask the panel to do. */
export interface ChatMessageActions {
  readonly react: (message: ChatMessageView, emoji: string) => void;
  /** Answer this message (D200): the composer shows it and the next send replies to it. */
  readonly reply: (message: ChatMessageView) => void;
  readonly edit: (message: ChatMessageView) => void;
  readonly remove: (message: ChatMessageView) => void;
  /** Go to the message a quote is of (D200), from the reply carrying it. */
  readonly jumpTo: (quote: ChatQuoteView, from: ChatMessageView) => void;
  readonly openThread: (rootId: string) => void;
  /** Open one of a message's pictures full size (D203). */
  readonly viewImages: (message: ChatMessageView, index: number) => void;
}

export interface ChatEditing {
  readonly id: string;
  readonly text: string;
}

interface Props {
  readonly run: Run<ChatMessageView>;
  readonly selfId: string | undefined;
  readonly menuOpen: boolean;
  readonly onMenu: (open: boolean) => void;
  readonly editing: ChatEditing | null;
  readonly onEditText: (text: string) => void;
  readonly onSaveEdit: () => void;
  readonly onCancelEdit: () => void;
  /** Just jumped to: drawn with a brief glow so the eye finds it (D200). */
  readonly highlighted: boolean;
  /** In the thread view: no "N replies" link to the thread already open. */
  readonly inThread?: boolean;
  readonly actions: ChatMessageActions;
}

const replies = (n: number) => `${n} ${n === 1 ? 'reply' : 'replies'}`;
const pictures = (n: number) => `${n} ${n === 1 ? 'picture' : 'pictures'}`;

/**
 * One message in the chat (D173's compact bubble): grouped under its writer's run, with edit,
 * delete, reply and reactions in one overflow menu. A reply carries a quote of what it answers
 * (D200); a root its thread has answered says how many replies it has, which opens the thread; a
 * message that @-mentions you is marked (D201).
 */
export function ChatMessageItem({ run, selfId, menuOpen, onMenu, editing, onEditText, onSaveEdit, onCancelEdit, highlighted, inThread = false, actions }: Props) {
  const { message: m, showHeader, showTime } = run;
  const isEditing = editing?.id === m.id;
  const live = !m.hidden && !m.deleted;
  const forMe = mentionsMe(m, selfId);
  // Cal, or another agent (D204): shown as what it is, never as a person.
  const kind = authorKind(m.author);
  const agent = kind === 'person' ? null : kind;
  // A view kept from before pictures came (the service worker's copy) has none listed.
  const images = m.attachments ?? [];

  /** A tap anywhere on a bubble opens its menu too (not just the small corner button a pointer
   * can hover to find) — except a tap on something already its own control. */
  const onBubbleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!live || isEditing) return;
    if ((e.target as HTMLElement).closest('.chat-reaction, .chat-message-menu, .chat-edit, .chat-quote, .chat-image, a')) return;
    onMenu(!menuOpen);
  };

  return (
    <li
      className={`chat-message${m.mine ? ' is-mine' : ''}${showHeader ? '' : ' is-grouped'}${forMe ? ' mentions-me' : ''}${highlighted ? ' is-highlighted' : ''}`}
      data-testid="chat-message"
      data-hidden={m.hidden}
      data-message-id={m.id}
      data-mentions-me={forMe ? 'true' : undefined}
      data-agent={m.author.agent ?? undefined}
    >
      <div className="chat-message-row">
        {!m.mine ? (
          showHeader ? (
            agent ? (
              <AgentAvatar kind={agent} size={28} />
            ) : (
              <Avatar name={m.author.displayName} color={m.author.color} size={28} />
            )
          ) : (
            <span className="chat-avatar-spacer" aria-hidden="true" />
          )
        ) : null}
        {/* The click is a touch/mouse convenience only (opens the same menu the real,
            keyboard-focusable `chat-message-menu-btn` below does) — the bubble itself
            stays plain markup, not a second, redundant control for the same action. */}
        <div className="chat-bubble" onClick={onBubbleClick}>
          {showHeader && !m.mine ? (
            <div className="chat-meta">
              <strong style={agent ? undefined : { color: m.author.color }} className={agent ? 'chat-agent-name' : undefined}>
                {m.author.displayName}
              </strong>
              {agent ? <AgentBadge kind={agent} /> : null}
            </div>
          ) : null}
          {m.replyTo ? <ChatQuote quote={m.replyTo} onOpen={() => actions.jumpTo(m.replyTo!, m)} /> : null}
          {!m.hidden && m.editedAt ? (
            <div className="chat-meta-sub">
              <span className="muted small">(edited)</span>
            </div>
          ) : null}
          {m.hidden ? (
            <p className="chat-text chat-spoiler" data-testid="chat-spoiler-marker">
              <Icon name="lock" size={14} /> {m.spoilerLabel}
              {images.length > 0 ? <span className="chat-spoiler-pictures"> · {pictures(images.length)}</span> : null}
            </p>
          ) : isEditing ? (
            <div className="chat-edit">
              <textarea value={editing.text} onChange={(e) => onEditText(e.target.value)} rows={2} aria-label="Edit message" />
              <button type="button" className="btn btn-small" onClick={onSaveEdit}>
                Save
              </button>
              <button type="button" className="btn btn-small btn-ghost" onClick={onCancelEdit}>
                Cancel
              </button>
            </div>
          ) : (
            <>
              {!m.deleted && images.length > 0 && !m.hidden ? <ChatImageGrid images={m.attachments} authorName={m.author.displayName} onOpen={(i) => actions.viewImages(m, i)} /> : null}
              {m.deleted || m.text || m.spoilerLabel ? (
                <p className="chat-text">
                  {m.deleted ? <em className="muted">Message deleted</em> : <ChatMessageText message={m} selfId={selfId} />}
                  {!m.deleted && m.spoilerLabel ? <span className="chat-spoiler-tag"> ({m.spoilerLabel})</span> : null}
                </p>
              ) : null}
            </>
          )}
          {live && m.reactions.length > 0 ? (
            <div className="chat-reactions">
              {m.reactions.map((r) => (
                <button key={r.emoji} type="button" className={`chat-reaction${r.mine ? ' is-mine' : ''}`} onClick={() => actions.react(m, r.emoji)}>
                  {r.emoji} {r.count}
                </button>
              ))}
            </div>
          ) : null}
          {live ? (
            <button
              type="button"
              className="icon-btn chat-message-menu-btn"
              aria-label="React, reply, or more"
              aria-expanded={menuOpen}
              data-testid="chat-message-menu-btn"
              onClick={(e) => {
                e.stopPropagation();
                onMenu(!menuOpen);
              }}
            >
              <Icon name="more" size={14} />
            </button>
          ) : null}
          {live && menuOpen ? (
            <div className="chat-message-menu" data-testid="chat-message-menu">
              <div className="chat-reaction-picker-open">
                {QUICK_REACTIONS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    className="chat-reaction-add"
                    aria-label={`React ${emoji}`}
                    onClick={() => {
                      actions.react(m, emoji);
                      onMenu(false);
                    }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
              <div className="chat-message-menu-actions">
                <button
                  type="button"
                  className="btn btn-small btn-ghost"
                  data-testid="chat-message-reply"
                  onClick={() => {
                    actions.reply(m);
                    onMenu(false);
                  }}
                >
                  <Icon name="reply" size={14} /> Reply
                </button>
                {m.mine ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-small btn-ghost"
                      data-testid="chat-message-edit"
                      onClick={() => {
                        actions.edit(m);
                        onMenu(false);
                      }}
                    >
                      <Icon name="edit" size={14} /> Edit
                    </button>
                    <button
                      type="button"
                      className="btn btn-small btn-ghost"
                      data-testid="chat-message-delete"
                      onClick={() => {
                        actions.remove(m);
                        onMenu(false);
                      }}
                    >
                      <Icon name="trash" size={14} /> Delete
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
      {!inThread && m.threadId === null && m.replyCount > 0 ? (
        <button type="button" className="chat-replies-link" data-testid="chat-replies" onClick={() => actions.openThread(m.id)}>
          <Icon name="reply" size={13} /> {replies(m.replyCount)}
        </button>
      ) : null}
      {showTime ? <time className="chat-time muted small">{new Date(m.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time> : null}
    </li>
  );
}
