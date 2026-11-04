import { Component, type ErrorInfo, type ReactNode } from 'react';

const RELOADED_KEY = 'bookclub:reloaded-for-chunk';

/** A part of the app that is no longer on the server (after an update): a reload fetches the new one. */
export function isStaleChunk(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError|Unable to preload CSS/i.test(message);
}

interface Props {
  readonly children: ReactNode;
  /** Changing this (the route) clears a caught error. */
  readonly resetKey?: string;
}

interface State {
  readonly error: Error | null;
}

/**
 * Catches a render error anywhere below it, so one broken screen never blanks the whole app.
 * After an update, a screen whose code is gone reloads once to pick up the new version.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('render error', error, info.componentStack);
    if (isStaleChunk(error)) {
      let reloaded = false;
      try {
        reloaded = sessionStorage.getItem(RELOADED_KEY) === location.pathname;
        sessionStorage.setItem(RELOADED_KEY, location.pathname);
      } catch {
        // ignore
      }
      if (!reloaded) location.reload();
    }
  }

  override componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="center-page" role="alert" data-testid="error-page">
        <h1>Something went wrong on this page</h1>
        <p className="muted">Your reading and notes are safe. Reloading usually fixes it.</p>
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={() => location.reload()}>
            Reload
          </button>
          <a className="btn" href="/">
            Your clubs
          </a>
        </div>
      </div>
    );
  }
}
