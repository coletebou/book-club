import type { ChatAgentAvatar } from '@bookclub/shared';
import { Icon } from '../components/Icon';

/**
 * How an agent looks in chat (D204, D205): not a person's initials but a mark of its own, in the
 * cooler accent agents wear (D201's mentions of them): the one its configuration gives (a picture,
 * or an emoji), else the app's own; with a word saying what it is beside its name: "AI" for Cal,
 * the club's librarian; "Bot" for an agent of another service.
 */
export function AgentAvatar({ kind, avatar = null, size = 28 }: { kind: 'cal' | 'agent'; avatar?: ChatAgentAvatar | null; size?: number }) {
  return (
    <span className="avatar chat-agent-avatar" data-agent-kind={kind} style={{ width: size, height: size, fontSize: size * 0.5 }} aria-hidden="true">
      {avatar?.kind === 'image' ? (
        <img src={avatar.src} alt="" width={size} height={size} />
      ) : avatar?.kind === 'text' ? (
        avatar.text
      ) : (
        <Icon name="sparkle" size={Math.round(size * 0.58)} />
      )}
    </span>
  );
}

export function AgentBadge({ kind }: { kind: 'cal' | 'agent' }) {
  return (
    <span className="chat-agent-badge" data-testid="chat-agent-badge">
      {kind === 'cal' ? 'AI' : 'Bot'}
    </span>
  );
}
