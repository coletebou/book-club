import { describe, expect, it } from 'vitest';
import {
  type MentionCandidate,
  type MentionTarget,
  applyMention,
  findMentions,
  mentionDirectory,
  mentionQueryAt,
  mentionTokenFor,
  mentionedTargets,
  mentionsTarget,
  rankMentionCandidates,
  segmentText,
} from './mentions';

const member = (id: string, displayName: string): MentionCandidate => ({ target: { kind: 'member', id }, displayName });
const agent = (handle: string, displayName: string): MentionCandidate => ({ target: { kind: 'agent', handle }, displayName, handle });

const ana = member('u-ana', 'Ana');
const ben = member('u-ben', 'Ben Carter');
const grantS = member('u-grant-s', 'Grant Smith');
const grantL = member('u-grant-l', 'Grant Lee');
const zoe = member('u-zoe', 'Zoë Ñúñez');
const mj = member('u-mj', "Mary-Jane O'Neil");
const cal = agent('cal', 'Cal');
const lux = agent('lux', 'Lux');

const club = mentionDirectory([ana, ben, grantS, grantL, zoe, mj, cal, lux]);

/** Who each mention in `text` names, as `kind:id` strings, with the text each one covers. */
function read(text: string, directory = club): string[] {
  return findMentions(text, directory).map((s) => `${text.slice(s.start, s.end)} -> ${s.target.kind === 'member' ? s.target.id : `agent:${s.target.handle}`}`);
}

describe('findMentions', () => {
  it('reads a single first name, a whole display name and an agent handle', () => {
    expect(read('hey @Ana, and @Ben look')).toEqual(['@Ana -> u-ana', '@Ben -> u-ben']);
    expect(read('@Grant Smith and @Grant Lee')).toEqual(['@Grant Smith -> u-grant-s', '@Grant Lee -> u-grant-l']);
    expect(read('@cal what is the white rabbit late for?')).toEqual(['@cal -> agent:cal']);
  });

  it('matches case, accents and punctuation loosely, as the key does', () => {
    expect(read('@ANA @zoe @ZoëÑúñez')).toEqual(['@ANA -> u-ana', '@zoe -> u-zoe', '@ZoëÑúñez -> u-zoe']);
    expect(read("@Mary-Jane O'Neil said so")).toEqual(["@Mary-Jane O'Neil -> u-mj"]);
    expect(read('@MaryJaneONeil')).toEqual(['@MaryJaneONeil -> u-mj']);
  });

  it('names nobody with an ambiguous first name, but the whole name still works', () => {
    expect(read('@Grant are you coming?')).toEqual([]);
    expect(read('@GrantSmith are you coming?')).toEqual(['@GrantSmith -> u-grant-s']);
  });

  it('prefers the longest whole display name, then a single word', () => {
    const directory = mentionDirectory([member('a', 'Ana'), member('b', 'Ana Lopez')]);
    expect(read('@Ana Lopez agrees', directory)).toEqual(['@Ana Lopez -> b']);
    // "Ana" alone is someone's whole name, which beats being someone else's first name.
    expect(read('@Ana agrees', directory)).toEqual(['@Ana -> a']);
  });

  it('never starts inside a word, an email address, a path or a code span', () => {
    expect(read('mail ana@example.org or site.org/@ana')).toEqual([]);
    expect(read('x@Ana')).toEqual([]);
    expect(read('use `@ana` to mention her')).toEqual([]);
    expect(read('(@Ana) "@Ben" [@cal]')).toEqual(['@Ana -> u-ana', '@Ben -> u-ben', '@cal -> agent:cal']);
  });

  it('has a name end where its word ends, without a trailing possessive or full stop', () => {
    expect(read('@Anaxagoras was a philosopher')).toEqual([]);
    expect(read('@cal_ is not cal')).toEqual([]);
    expect(read("@Ana's book, @Ben's too.")).toEqual(['@Ana -> u-ana', '@Ben -> u-ben']);
    expect(read('Thanks @Ana. And @Ben!')).toEqual(['@Ana -> u-ana', '@Ben -> u-ben']);
  });

  it('lets a whole display name shadow an agent handle, and a handle shadow a first name', () => {
    const directory = mentionDirectory([member('cal-person', 'Cal'), member('lux-first', 'Lux Ortega'), cal, lux]);
    expect(read('@cal and @lux', directory)).toEqual(['@cal -> cal-person', '@lux -> agent:lux']);
    expect(read('@Lux Ortega', directory)).toEqual(['@Lux Ortega -> lux-first']);
  });

  it('gives UTF-16 spans that slice back to the mention after astral characters', () => {
    const text = '📚📚 @Zoë Ñúñez!';
    const [span] = findMentions(text, club);
    expect(text.slice(span!.start, span!.end)).toBe('@Zoë Ñúñez');
  });

  it('reads one mention per @, however often a person is named', () => {
    expect(read('@Ana @Ana @@Ana')).toEqual(['@Ana -> u-ana', '@Ana -> u-ana']);
    expect(mentionedTargets(findMentions('@Ana @Ben @Ana', club))).toEqual([ana.target, ben.target]);
  });

  it('finds nothing in an empty directory or text', () => {
    expect(read('@Ana', mentionDirectory([]))).toEqual([]);
    expect(read('')).toEqual([]);
    expect(read('@')).toEqual([]);
  });
});

describe('mentionsTarget', () => {
  it('tells whether a message names someone', () => {
    const spans = findMentions('@Ana look', club);
    expect(mentionsTarget(spans, { kind: 'member', id: 'u-ana' })).toBe(true);
    expect(mentionsTarget(spans, { kind: 'member', id: 'u-ben' })).toBe(false);
    expect(mentionsTarget(spans, { kind: 'agent', handle: 'u-ana' })).toBe(false);
  });
});

describe('mentionQueryAt', () => {
  it('finds the @name the caret is typing', () => {
    expect(mentionQueryAt('hi @An', 6)).toEqual({ start: 3, end: 6, query: 'An' });
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, end: 1, query: '' });
    expect(mentionQueryAt('hi @Grant S', 11)).toEqual({ start: 3, end: 11, query: 'Grant S' });
  });

  it('runs a pick to the end of the word the caret is inside', () => {
    expect(mentionQueryAt('hi @Anaa there', 6)).toEqual({ start: 3, end: 8, query: 'An' });
  });

  it('is not typing a mention after an email, a newline, or once the words run on', () => {
    expect(mentionQueryAt('ana@ex', 6)).toBeNull();
    expect(mentionQueryAt('@Ana\nhi', 7)).toBeNull();
    expect(mentionQueryAt('@Ana how are you', 16)).toBeNull();
    expect(mentionQueryAt('no at sign', 5)).toBeNull();
    expect(mentionQueryAt('@Ana', 9)).toBeNull();
  });
});

describe('rankMentionCandidates', () => {
  const everyone = [ana, ben, grantS, grantL, zoe, mj, cal, lux];
  const names = (q: string, exclude: MentionTarget | null = null) => rankMentionCandidates(q, everyone, { exclude }).map((c) => c.displayName);

  it('offers everyone for a bare @, alphabetically, members before agents on a tie', () => {
    expect(names('')).toEqual(['Ana', 'Ben Carter', 'Cal', 'Grant Lee', 'Grant Smith', 'Lux', "Mary-Jane O'Neil", 'Zoë Ñúñez']);
  });

  it('ranks exact, then prefix, then word prefix, then substring', () => {
    const directory = [member('1', 'Al'), member('2', 'Alice'), member('3', 'Hal Albert'), member('4', 'Sally')];
    expect(rankMentionCandidates('al', directory).map((c) => c.displayName)).toEqual(['Al', 'Alice', 'Hal Albert', 'Sally']);
  });

  it('folds accents and finds agents by handle', () => {
    expect(names('zo')).toEqual(['Zoë Ñúñez']);
    expect(names('nun')).toEqual(['Zoë Ñúñez']);
    expect(names('cal')).toEqual(['Cal']);
    expect(names('grant s')).toEqual(['Grant Smith']);
  });

  it('never offers the writer themselves, and honours the limit', () => {
    expect(names('a', ana.target)).not.toContain('Ana');
    expect(rankMentionCandidates('', everyone, { limit: 2 })).toHaveLength(2);
  });
});

describe('mentionTokenFor and applyMention', () => {
  it('writes the shortest form that reads back as the person picked', () => {
    expect(mentionTokenFor(ana, club)).toBe('Ana');
    expect(mentionTokenFor(ben, club)).toBe('Ben');
    expect(mentionTokenFor(grantS, club)).toBe('Grant Smith');
    expect(mentionTokenFor(cal, club)).toBe('cal');
    expect(mentionTokenFor(mj, club)).toBe('Mary-Jane');
  });

  it('round-trips every candidate through findMentions', () => {
    for (const c of club.candidates) {
      const token = mentionTokenFor(c, club);
      const [span] = findMentions(`@${token} hello`, club);
      expect(span?.target).toEqual(c.target);
    }
  });

  it('writes the pick over the query with one space after, reusing one already there', () => {
    const query = mentionQueryAt('hi @Gr', 6)!;
    expect(applyMention('hi @Gr', query, grantS, club)).toEqual({ text: 'hi @Grant Smith ', caret: 16 });
    const inside = mentionQueryAt('hi @Gr there', 6)!;
    expect(applyMention('hi @Gr there', inside, grantS, club)).toEqual({ text: 'hi @Grant Smith there', caret: 16 });
  });

  it('writes a name as it can be typed: punctuation and emoji at the ends of its words left out', () => {
    const doctor = member('dr', 'Dr. Who');
    const flower = member('fl', '🌸 Ana');
    const directory = mentionDirectory([doctor, flower]);
    expect(mentionTokenFor(doctor, directory)).toBe('Dr');
    expect(mentionTokenFor(flower, directory)).toBe('Ana');
    expect(findMentions('@Ana hi', directory)[0]?.target).toEqual(flower.target);
    const two = mentionDirectory([doctor, member('no', 'Dr. No')]);
    expect(mentionTokenFor(doctor, two)).toBe('Dr Who');
    expect(findMentions('@Dr Who hi', two)[0]?.target).toEqual(doctor.target);
  });

  it('reads names in scripts that write vowels as combining marks', () => {
    const priya = member('pr', 'प्रिया');
    const somchai = member('so', 'สมชาย ใจดี');
    const directory = mentionDirectory([priya, somchai]);
    for (const c of [priya, somchai]) {
      const token = mentionTokenFor(c, directory);
      const [span] = findMentions(`@${token} hi`, directory);
      expect(span?.target).toEqual(c.target);
      expect(`@${token} hi`.slice(span!.start, span!.end)).toBe(`@${token}`);
    }
  });

  it("reads a trailing 's as a possessive before it reads it as part of a name", () => {
    const directory = mentionDirectory([member('a', 'Ana'), member('b', 'Anas')]);
    expect(findMentions("@Ana's book", directory).map((s) => s.target)).toEqual([{ kind: 'member', id: 'a' }]);
    expect(findMentions('@Anas here', directory).map((s) => s.target)).toEqual([{ kind: 'member', id: 'b' }]);
  });

  it('falls back to the name run together when nothing shorter is unambiguous', () => {
    const twins = mentionDirectory([member('1', 'Sam Wu'), member('2', 'Sam Wu'), member('3', 'Sam')]);
    expect(mentionTokenFor(twins.candidates[0]!, twins)).toBe('SamWu');
  });
});

describe('segmentText', () => {
  it('cuts text into plain runs and mentions', () => {
    const text = 'hi @Ana and @cal!';
    expect(segmentText(text, findMentions(text, club))).toEqual([
      { kind: 'text', text: 'hi ' },
      { kind: 'mention', text: '@Ana', target: ana.target },
      { kind: 'text', text: ' and ' },
      { kind: 'mention', text: '@cal', target: cal.target },
      { kind: 'text', text: '!' },
    ]);
  });

  it('skips spans that do not fit the text or overlap', () => {
    const target = ana.target;
    expect(
      segmentText('abc', [
        { start: 1, end: 9, target },
        { start: 0, end: 2, target },
        { start: 1, end: 3, target },
      ]),
    ).toEqual([
      { kind: 'mention', text: 'ab', target },
      { kind: 'text', text: 'c' },
    ]);
    expect(segmentText('', [])).toEqual([]);
  });
});
