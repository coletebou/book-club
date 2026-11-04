import { cleanup, render, screen } from '@testing-library/react';
import type { Member, PresenceEntry } from '@bookclub/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Avatar, PresenceList, initials } from './People';

afterEach(cleanup);

describe('initials', () => {
  it.each([
    ['Ana Bell', 'AB'],
    ['ana maria lopez', 'AL'],
    ['  Ben   Okafor  ', 'BO'],
    ['Jean-Luc Picard', 'JP'],
    ['cleo', 'CL'],
    ['B', 'B'],
    ['élodie durand', 'ÉD'],
    ['Zoë', 'ZO'],
    ['李 小龙', '李小'],
  ])('%j → %j', (name, expected) => {
    expect(initials(name)).toBe(expected);
  });

  it.each(['', '   ', '\t\n'])('is a question mark for a blank name (%j)', (name) => {
    expect(initials(name)).toBe('?');
  });

  // BUG (components/People.tsx, initials): it takes the first UTF-16 code unit of each word
  // (`parts[0][0]`, `slice(0, 2)`), so a name that starts with a character outside the Basic
  // Multilingual Plane, such as an emoji ("🦊 Fox") or a mathematical letter, yields half a
  // surrogate pair: the avatar shows "\uD83EF", which renders as a replacement glyph. Taking code
  // points ([...word][0]) keeps the character whole.
  it('keeps a character outside the Basic Multilingual Plane whole', () => {
    expect(initials('🦊 Fox')).toBe('🦊F');
    expect(initials('𝒜lice Smith')).toBe('𝒜S');
  });
});

describe('Avatar', () => {
  it('shows initials on the member colour and is hidden from assistive technology (the name is next to it)', () => {
    const { container } = render(<Avatar name="Ana Bell" color="#FF6B6B" online reading size={40} />);
    const avatar = container.firstElementChild as HTMLElement;
    expect(avatar.textContent).toBe('AB');
    expect(avatar.getAttribute('aria-hidden')).toBe('true');
    expect(avatar.dataset.online).toBe('true');
    expect(avatar.dataset.reading).toBe('true');
    expect(avatar.style.width).toBe('40px');
  });

  it('marks nothing when the member is away', () => {
    const { container } = render(<Avatar name="Ana Bell" color="#FF6B6B" />);
    const avatar = container.firstElementChild as HTMLElement;
    expect(avatar.dataset.online).toBeUndefined();
    expect(avatar.dataset.reading).toBeUndefined();
  });
});

describe('PresenceList', () => {
  const members: Member[] = [
    { userId: 'user_ana', displayName: 'Ana Bell', color: '#FF6B6B', role: 'owner', joinedAt: '2026-10-01T00:00:00.000Z', source: 'local' },
    { userId: 'user_ben', displayName: 'Ben Okafor', color: '#4ECDC4', role: 'member', joinedAt: '2026-10-02T00:00:00.000Z', source: 'local' },
    { userId: 'user_cleo', displayName: 'Cleo', color: '#45B7D1', role: 'member', joinedAt: '2026-10-03T00:00:00.000Z', source: 'upstream' },
  ];
  const presence = new Map<string, PresenceEntry>([
    [
      'user_ana',
      {
        userId: 'user_ana',
        displayName: 'Ana Bell',
        color: '#FF6B6B',
        online: true,
        reading: { bookId: 'book_alice', editionId: 'ed_epub', kind: 'epub', t: 0.3, label: 'Chapter 3 · 30%', at: 1 },
      },
    ],
    ['user_ben', { userId: 'user_ben', displayName: 'Ben Okafor', color: '#4ECDC4', online: true, reading: null }],
  ]);

  it('lists every member with whether they are reading, online or away', () => {
    render(<PresenceList members={members} presence={presence} />);
    const list = screen.getByRole('list', { name: 'Members' });
    const items = screen.getAllByTestId('presence-member');
    expect(list.children).toHaveLength(3);
    expect(items.map((i) => [i.dataset.user, i.dataset.status])).toEqual([
      ['user_ana', 'reading'],
      ['user_ben', 'online'],
      ['user_cleo', 'away'],
    ]);
  });

  it('says where a reader is, in words, for screen readers and in the tooltip', () => {
    render(<PresenceList members={members} presence={presence} />);
    const [ana, ben, cleo] = screen.getAllByTestId('presence-member');
    expect(ana!.title).toBe('Ana Bell: reading now · Chapter 3 · 30%');
    expect(ana!.textContent).toContain(', reading now · Chapter 3 · 30%');
    expect(ana!.textContent).toContain('(owner)');
    expect(ben!.title).toBe('Ben Okafor: online');
    expect(cleo!.title).toBe('Cleo: away');
    expect(cleo!.textContent).not.toContain('(owner)');
  });

  it('says you are offline with no network, as the header does, and shows nobody else as here', () => {
    const offline = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    render(<PresenceList members={members} presence={presence} selfId="user_ben" />);
    const items = screen.getAllByTestId('presence-member');
    expect(items.map((i) => [i.dataset.user, i.dataset.status])).toEqual([
      ['user_ana', 'away'],
      ['user_ben', 'offline'],
      ['user_cleo', 'away'],
    ]);
    offline.mockRestore();
  });

  it('shows where a reader is on the page itself, and which book once the club has more than one', () => {
    const { unmount } = render(<PresenceList members={members} presence={presence} />);
    expect(screen.getAllByTestId('presence-where').map((w) => w.textContent)).toEqual(['Chapter 3']);
    unmount();
    render(<PresenceList members={members} presence={presence} books={[{ id: 'book_alice', title: 'Alice in Wonderland' }, { id: 'book_pan', title: 'Peter Pan' }]} />);
    expect(screen.getByTestId('presence-where').textContent).toBe('Chapter 3Alice in Wonderland');
  });

  it('says listening for a member who is listening', () => {
    const listening = new Map(presence);
    listening.set('user_ben', { userId: 'user_ben', displayName: 'Ben Okafor', color: '#4ECDC4', online: true, reading: { bookId: 'book_alice', editionId: 'ed_audio', kind: 'audio', t: 0.2, label: 'Chapter 2 · 20%', at: 1 } });
    render(<PresenceList members={members} presence={listening} />);
    const ben = screen.getAllByTestId('presence-member')[1]!;
    expect(ben.dataset.status).toBe('reading');
    expect(ben.title).toBe('Ben Okafor: listening now · Chapter 2 · 20%');
    expect(ben.querySelector('.presence-status')!.textContent).toBe('listening');
  });
});
