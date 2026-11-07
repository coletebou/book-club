/**
 * A tiny external store: one immutable snapshot, replaced whole on every change, and listeners.
 * `getState` and `subscribe` are arrow properties, so they can be handed straight to React's
 * `useSyncExternalStore(store.subscribe, store.getState)` or to any other framework's equivalent;
 * nothing here knows which one is listening.
 */
export interface Store<S> {
  readonly getState: () => S;
  readonly subscribe: (listener: () => void) => () => void;
}

export interface WritableStore<S> extends Store<S> {
  /** Replace the snapshot (or derive the next one from it). Listeners run only if it changed. */
  readonly set: (next: S | ((current: S) => S)) => void;
}

export function createStore<S>(initial: S): WritableStore<S> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: (next) => {
      const value = typeof next === 'function' ? (next as (current: S) => S)(state) : next;
      if (Object.is(value, state)) return;
      state = value;
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch (err) {
          // One listener that throws must not keep the others from hearing about the change;
          // the error still surfaces, just not in the middle of everyone else's update.
          queueMicrotask(() => {
            throw err;
          });
        }
      }
    },
  };
}
