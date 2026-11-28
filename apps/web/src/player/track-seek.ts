// `position` is measured from the start of `fromTrack`. Carry any overflow across chapters.
export function trackPositionForSeek(
  tracks: readonly { readonly durationMs: number }[],
  fromTrack: number,
  position: number,
  currentDuration?: number,
): { track: number; position: number } {
  const durationOf = (track: number) =>
    track === fromTrack && currentDuration !== undefined ? currentDuration : (tracks[track]?.durationMs ?? 0) / 1000;
  let track = fromTrack;
  while (position < 0 && track > 0) position += durationOf(--track);
  while (track < tracks.length - 1) {
    const duration = durationOf(track);
    if (duration <= 0 || position <= duration) break;
    position -= duration;
    track++;
  }
  const duration = durationOf(track);
  return { track, position: Math.max(0, duration > 0 ? Math.min(position, duration) : position) };
}
