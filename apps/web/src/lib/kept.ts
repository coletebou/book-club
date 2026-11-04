import { ApiError } from './api';

/** A note made with no network, kept on the device to pin later (lib/pending-notes.ts). */
export function keptForLater(err: unknown): err is ApiError {
  return err instanceof ApiError && err.code === 'kept';
}
