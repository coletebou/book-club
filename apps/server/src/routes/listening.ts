import {
  type AudioControls,
  type BookAudioControls,
  type BookPlayback,
  IdSchema,
  type ListeningSettings,
  SetAudioControlsBodySchema,
  SetBookAudioControlsBodySchema,
  SetBookPlaybackBodySchema,
  SetListeningSettingsBodySchema,
} from '@bookclub/shared';
import { type FastifyInstance } from 'fastify';
import { requireBook } from '../auth/access';
import { requireUser } from '../auth/plugin';
import { type AppContext } from '../context';
import { parse } from '../lib/errors';
import { audioControlsDefault, listeningSettings, setAudioControlsDefault, setBookAudioControls, setBookPlayback, setDefaultRate } from '../repos/playback';

/**
 * Listening speed (D195), kept per person on the server so it follows them from the browser to
 * the iOS app and back. A book's own speed is read with its progress
 * (`GET /api/books/:bookId/progress`, `playback`), the moment the player opens it.
 */
export function listeningRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/me/listening', async (request): Promise<ListeningSettings> => {
    const user = requireUser(request);
    return listeningSettings(ctx.db, user.id);
  });

  /** Your default: the speed every book you have not listened to yet starts at. */
  app.put('/api/me/listening', async (request): Promise<ListeningSettings> => {
    const user = requireUser(request);
    const body = parse(SetListeningSettingsBodySchema, request.body);
    return setDefaultRate(ctx.db, user.id, body.defaultRate, body.at);
  });

  /** The speed you last used for this book: it opens at that speed next time, on any device. */
  app.put<{ Params: { bookId: string } }>('/api/books/:bookId/playback', async (request): Promise<BookPlayback> => {
    const user = requireUser(request);
    const { book } = requireBook(ctx.db, parse(IdSchema, request.params.bookId), user.id);
    const body = parse(SetBookPlaybackBodySchema, request.body);
    return setBookPlayback(ctx.db, user.id, book.id, body.rate, body.at);
  });

  /**
   * The audiobook's controls in the book (D197): your default, kept per person so that hiding them
   * in the iOS app hides them in the browser too. A book's own choice is read with its progress
   * (`audioControls`), as its speed is.
   */
  app.get('/api/me/audio-controls', async (request): Promise<AudioControls> => {
    const user = requireUser(request);
    return audioControlsDefault(ctx.db, user.id);
  });

  app.put('/api/me/audio-controls', async (request): Promise<AudioControls> => {
    const user = requireUser(request);
    const body = parse(SetAudioControlsBodySchema, request.body);
    return setAudioControlsDefault(ctx.db, user.id, body.hidden, body.at);
  });

  /** This book's own choice over your default: hidden, shown, or null for as your default says. */
  app.put<{ Params: { bookId: string } }>('/api/books/:bookId/audio-controls', async (request): Promise<BookAudioControls> => {
    const user = requireUser(request);
    const { book } = requireBook(ctx.db, parse(IdSchema, request.params.bookId), user.id);
    const body = parse(SetBookAudioControlsBodySchema, request.body);
    return setBookAudioControls(ctx.db, user.id, book.id, body.hidden, body.at);
  });
}
