/*
 * The places saved from this device lately, book by book, as timeline places: the reader's pages
 * and the player's listening alike. The club is told of every place saved, yours too, so a saved
 * place this device hears of is told apart from one saved on another device by being one of these
 * (D70). Another tab is another device here: its places are not this one's.
 */
const recent = new Map<string, number[]>();
const KEPT = 100;

export function savedFromHere(bookId: string, t: number): void {
  const list = recent.get(bookId) ?? [];
  list.push(t);
  if (list.length > KEPT) list.splice(0, list.length - KEPT);
  recent.set(bookId, list);
}

export function placesSavedHere(bookId: string): readonly number[] {
  return recent.get(bookId) ?? [];
}
