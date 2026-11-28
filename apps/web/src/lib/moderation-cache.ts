/** D264: keep cached book files, but discard account-scoped content gated by member blocks. */
export function moderatedResponsePath(path: string): boolean {
  return path === '/api/notifications' || /^\/api\/(?:books\/[^/]+\/(?:comments|places)|clubs\/[^/]+\/chat(?:\/unread)?|chat\/[^/]+\/thread)$/.test(path);
}

export async function clearModeratedResponses(): Promise<void> {
  if (typeof caches === 'undefined') return;
  const names = (await caches.keys()).filter((name) => name === 'bc-api' || name.startsWith('bc-ed-'));
  await Promise.all(names.map(async (name) => {
    const cache = await caches.open(name);
    const requests = (await cache.keys()).filter((request) => moderatedResponsePath(new URL(request.url).pathname));
    await Promise.all(requests.map((request) => cache.delete(request)));
  }));
}

/** A late save or pagination request must not bring back a response from before the change. */
export let moderationGeneration = 0;

export function changeModerationGeneration(): void {
  moderationGeneration++;
}
