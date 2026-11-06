import { Icon } from '../components/Icon';

/**
 * How an agent looks in chat (D204): not a person's initials but a mark of its own, in the cooler
 * accent agents wear (D201's mentions of them), with a word saying what it is beside its name:
 * "AI" for Cal, the club's librarian; "Bot" for an agent of another service (D205).
 */
export function AgentAvatar({ kind, size = 28 }: { kind: 'cal' | 'agent'; size?: number }) {
  return (
    <span className="avatar chat-agent-avatar" data-agent-kind={kind} style={{ width: size, height: size }} aria-hidden="true">
      <Icon name="sparkle" size={Math.round(size * 0.58)} />
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
