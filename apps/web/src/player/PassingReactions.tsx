import { memo, useEffect, useEffectEvent, useMemo, useRef } from 'react';
import type { CommentView, Edition, Reaction, RevealedComment } from '@bookclub/shared';
import { useToast } from '../components/Toasts';
import { useComments, useSession } from '../lib/queries';
import { useAudio } from './AudioProvider';
import { audioLocatorOf } from './tracks';
import { useReactionNotices } from './reaction-notices';

interface HeardSpan {
  readonly track: number;
  readonly from: number;
  readonly to: number;
  readonly at: number;
}

interface ReactionCue {
  readonly id: string;
  readonly ms: number;
  readonly author: string;
  readonly reaction: Reaction;
}

// Allow a regular progress delivery to reveal a reaction just heard (D258).
const RECENT_MS = 12_000;
const MAX_SPANS = 96;

export function isStandaloneReaction(comment: CommentView): comment is RevealedComment & { reaction: Reaction } {
  return !comment.hidden && !!comment.reaction && !comment.text && !comment.quote && !comment.media?.length;
}

interface PassingReactionsProps {
  readonly bookId: string;
  readonly edition: Edition;
}

export const PassingReactions = memo(function PassingReactions(props: PassingReactionsProps) {
  return useReactionNotices() ? <HeardReactions {...props} /> : null;
});

/** Observe audible playback. A reaction is eligible once its revealed location arrives. */
function HeardReactions({ bookId, edition }: PassingReactionsProps) {
  const audio = useAudio();
  const toast = useToast();
  const comments = useComments(bookId).data;
  const selfId = useSession().data?.user?.id;
  const heard = useRef<HeardSpan[]>([]);
  const seen = useRef(new Set<string>());
  const cues = useMemo(() => {
    const byTrack = new Map<number, ReactionCue[]>();
    if (!selfId) return byTrack;
    for (const comment of comments ?? []) {
      if (!isStandaloneReaction(comment) || comment.deleted || comment.userId === selfId) continue;
      const locator = audioLocatorOf(edition, comment);
      if (!locator) continue;
      const cue = { id: comment.id, ms: locator.ms, author: comment.authorName, reaction: comment.reaction };
      const entries = byTrack.get(locator.track);
      if (entries) entries.push(cue);
      else byTrack.set(locator.track, [cue]);
    }
    for (const entries of byTrack.values()) entries.sort((a, b) => a.ms - b.ms);
    return byTrack;
  }, [comments, edition, selfId]);

  const tell = useEffectEvent((spans: readonly HeardSpan[]) => {
    const cutoff = Date.now() - RECENT_MS;
    const messages: string[] = [];
    for (const span of spans) {
      if (span.at < cutoff) continue;
      for (const cue of cues.get(span.track) ?? []) {
        if (cue.ms > span.to) break;
        if (cue.ms < span.from || seen.current.has(cue.id)) continue;
        seen.current.add(cue.id);
        if (messages.length < 3) messages.push(`${cue.author} reacted ${cue.reaction}`);
      }
    }
    if (messages.length) toast.show(messages.join(' · '));
  });

  useEffect(() => { tell(heard.current); }, [cues]);

  useEffect(() => {
    const element = audio.element;
    if (!element) return;
    let before: { track: number; ms: number; at: number } | undefined;
    const clear = () => {
      before = undefined;
      heard.current = [];
    };
    const pause = () => { before = undefined; };
    const time = () => {
      const { track, edition: playingEdition, book, returnTo } = audio.state;
      if (playingEdition?.id !== edition.id || book?.id !== bookId || element.seeking || returnTo) { clear(); return; }
      if (element.paused) { pause(); return; }
      const previous = before;
      const at = Date.now();
      const ms = element.currentTime * 1000;
      before = { track, ms, at };
      if (!previous || previous.track !== track || ms <= previous.ms) return;
      const elapsed = at - previous.at;
      if (elapsed > 1_500 || ms - previous.ms > (elapsed + 350) * Math.max(1, element.playbackRate)) { clear(); return; }
      const span = { track, from: previous.ms, to: ms, at };
      heard.current.push(span);
      if (heard.current.length > MAX_SPANS) heard.current.shift();
      tell([span]);
    };
    element.addEventListener('playing', time);
    element.addEventListener('timeupdate', time);
    element.addEventListener('seeking', clear);
    element.addEventListener('native-seeking', clear);
    element.addEventListener('emptied', clear);
    element.addEventListener('pause', pause);
    return () => {
      element.removeEventListener('playing', time);
      element.removeEventListener('timeupdate', time);
      element.removeEventListener('seeking', clear);
      element.removeEventListener('native-seeking', clear);
      element.removeEventListener('emptied', clear);
      element.removeEventListener('pause', pause);
      clear();
    };
  }, [audio, bookId, edition.id]);
  return null;
}
