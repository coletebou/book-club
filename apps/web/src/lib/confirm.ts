import { createElement, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import type { CommentView } from '@bookclub/shared';
import { ConfirmDialog, type ConfirmOptions } from '../components/ConfirmDialog';

export type { ConfirmOptions };

interface Question {
  readonly id: number;
  readonly options: ConfirmOptions;
  readonly answer: (yes: boolean) => void;
}

/** The questions asked and not answered yet: the first is on screen, the others wait their turn. */
let questions: readonly Question[] = [];
const listeners = new Set<() => void>();
let mounted = false;
let nextId = 1;

function setQuestions(next: readonly Question[]): void {
  questions = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function Questions() {
  const asked = useSyncExternalStore(subscribe, () => questions);
  const first = asked[0];
  return first ? createElement(ConfirmDialog, { key: first.id, ...first.options, onAnswer: first.answer }) : null;
}

/**
 * Shown by a React root of their own, so that any part of the app can ask, a page or a dialog
 * alike, as it asked the browser before. Going back (an iPhone's swipe) answers no: the question
 * was the page's that is left.
 */
function mount(): void {
  if (mounted) return;
  mounted = true;
  const container = document.createElement('div');
  document.body.append(container);
  createRoot(container).render(createElement(Questions));
  window.addEventListener('popstate', () => {
    for (const q of questions) q.answer(false);
  });
}

/**
 * Ask before something is done for good, in the app's own dialog: true when the answer is yes.
 * One question is on screen at a time; one asked meanwhile comes after it, as with the browser's
 * confirm(). `signal` takes the question back (the thing it was about is over): the answer is no.
 */
export function confirmAction(options: ConfirmOptions & { readonly signal?: AbortSignal }): Promise<boolean> {
  const { signal, ...shown } = options;
  if (signal?.aborted) return Promise.resolve(false);
  mount();
  return new Promise((resolve) => {
    const id = nextId++;
    const answer = (yes: boolean) => {
      if (!questions.some((q) => q.id === id)) return;
      signal?.removeEventListener('abort', takeBack);
      setQuestions(questions.filter((q) => q.id !== id));
      resolve(yes);
    };
    const takeBack = () => answer(false);
    signal?.addEventListener('abort', takeBack);
    setQuestions([...questions, { id, options: shown, answer }]);
  });
}

/**
 * Asked before a note or a reply goes: the club's notes are not to be lost to one stray tap
 * (INTENT), and deleting one deletes it for everyone.
 */
export function askToDelete(c: Pick<CommentView, 'userId' | 'authorName' | 'parentId'>, selfId: string | undefined): Promise<boolean> {
  const what = c.parentId ? 'reply' : 'note';
  return confirmAction({
    title: c.userId === selfId ? `Delete your ${what}?` : `Delete ${c.authorName}’s ${what}?`,
    body: 'It goes for everyone in the club.',
    confirm: 'Delete',
    cancel: 'Keep',
    danger: true,
  });
}
