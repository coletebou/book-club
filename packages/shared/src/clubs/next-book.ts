/**
 * Picking the next book (D214): approval voting, decided on the server and here so the client can
 * show the same thing it is about to ask for. Closing a round picks the nomination with the most
 * votes; a tie (including a round with no votes at all, every nomination tied at zero) is broken
 * by whoever closes, choosing among the tied nominations.
 */

export interface VotedNomination {
  readonly id: string;
  readonly votes: number;
}

/**
 * The nomination ids tied for the most votes, in the order given. Empty for no nominations at
 * all (there is nothing to pick between); every nomination's id when every one of them is tied,
 * including an all-zero round.
 */
export function topVoted(nominations: readonly VotedNomination[]): string[] {
  if (nominations.length === 0) return [];
  const most = Math.max(...nominations.map((n) => n.votes));
  return nominations.filter((n) => n.votes === most).map((n) => n.id);
}

/**
 * Decide a round's winner: the single most-voted nomination outright, or, among a tie, whichever
 * of the tied ids `chosen` names (the closer's pick, D214). `null` when nothing was nominated, or
 * when a tie needs `chosen` and does not have it.
 */
export function pickWinner(nominations: readonly VotedNomination[], chosen?: string | null): string | null {
  const tied = topVoted(nominations);
  if (tied.length === 0) return null;
  if (tied.length === 1) return tied[0]!;
  return chosen && tied.includes(chosen) ? chosen : null;
}
