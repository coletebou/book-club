import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { type CalShelfItem, calApi } from '../lib/cal-api';
import './cal.css';

/** The file kinds the shelf's upload route takes (apps/server/src/routes/cal.ts), from a name's extension. */
function shelfKindFromName(name: string): 'pdf' | 'epub' | 'txt' | 'md' | null {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return ext === 'pdf' || ext === 'epub' || ext === 'txt' || ext === 'md' ? ext : null;
}

/**
 * Cal's settings (D173, moved here from the "Cal's shelf" tab the panel used to carry): what Cal
 * may add to the club's shelf (a URL or a file) and the whole-series spoiler scope, which used to
 * have no place to turn on at all — CalPanel only ever read it, never offered a way to set it.
 * Opened from the gear in the panel's own header, over the chat, not instead of it.
 *
 * Since D183 this is the only place the spoiler scope is chosen: the chat panel's per-question
 * "whole series" checkbox is gone, and the scope chosen here holds for every question, typed or
 * spoken, in every chat with Cal, until it is changed here again.
 */
export function CalSettingsModal({
  clubId,
  wholeSeries,
  onWholeSeriesChange,
  onClose,
}: {
  readonly clubId: string;
  readonly wholeSeries: boolean;
  readonly onWholeSeriesChange: (wholeSeries: boolean) => void;
  readonly onClose: () => void;
}) {
  const [shelf, setShelf] = useState<CalShelfItem[] | null>(null);
  const [shelfUrl, setShelfUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadShelf = useCallback(() => void calApi.shelf(clubId).then(setShelf, () => setShelf([])), [clubId]);
  useEffect(() => loadShelf(), [loadShelf]);

  const addUrl = async () => {
    const url = shelfUrl.trim();
    if (!url) return;
    setAdding(true);
    setError(null);
    try {
      await calApi.addShelfUrl(clubId, url);
      setShelfUrl('');
      loadShelf();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.');
    } finally {
      setAdding(false);
    }
  };

  const pickFile = async (file: File) => {
    const kind = shelfKindFromName(file.name);
    if (!kind) {
      setError('Cal takes a PDF, EPUB, text or Markdown file.');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      await calApi.uploadShelfFile(clubId, file, kind);
      loadShelf();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That file did not upload.');
    } finally {
      setUploading(false);
    }
  };

  /** Optimistic (D173): the switch moves the instant it is tapped, not after the round trip to
   *  `/api/cal/settings` — a controlled checkbox that only flips once the server answers reads, on
   *  a slower connection or in a WebKit test run, as though the first tap did nothing at all. Put
   *  back only if the save itself fails. */
  const toggleWholeSeries = async (checked: boolean) => {
    onWholeSeriesChange(checked);
    try {
      const saved = await calApi.setWholeSeries(checked);
      onWholeSeriesChange(saved.wholeSeries);
    } catch (err) {
      onWholeSeriesChange(!checked);
      setError(err instanceof Error ? err.message : 'That setting did not save.');
    }
  };

  return (
    <Modal title="Cal's settings" onClose={onClose} wide className="cal-settings-modal">
      <div className="cal-settings">
        <section className="cal-settings-section" aria-labelledby="cal-scope-title">
          <h3 id="cal-scope-title">Spoilers: what Cal may read from</h3>
          <div className="row" role="radiogroup" aria-labelledby="cal-scope-title">
            <button
              type="button"
              role="radio"
              aria-checked={!wholeSeries}
              className={`btn btn-small${!wholeSeries ? ' btn-primary' : ' btn-ghost'}`}
              onClick={() => void toggleWholeSeries(false)}
              data-testid="cal-scope-backwards"
            >
              Only what I've read
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={wholeSeries}
              className={`btn btn-small${wholeSeries ? ' btn-primary' : ' btn-ghost'}`}
              onClick={() => void toggleWholeSeries(true)}
              data-testid="cal-scope-whole"
            >
              Whole series
            </button>
          </div>
          <p className="cal-hint" data-testid="cal-scope-hint">
            {wholeSeries
              ? 'Cal may draw on every book in the series, including what happens past your place. This holds for every question, in every chat, until you change it here.'
              : "Cal never answers past your place. This holds for every question, in every chat, until you change it here."}
          </p>
        </section>
        <section className="cal-settings-section" aria-labelledby="cal-shelf-title">
          <h3 id="cal-shelf-title">Cal's shelf</h3>
          <p className="cal-hint">Extra material Cal can search: a PDF, EPUB, text file or web page.</p>
          {error ? <p className="cal-error" role="alert">{error}</p> : null}
          <form
            className="cal-shelf-add"
            onSubmit={(e) => {
              e.preventDefault();
              void addUrl();
            }}
          >
            <input type="url" value={shelfUrl} onChange={(e) => setShelfUrl(e.target.value)} placeholder="https://…" disabled={adding} />
            <button type="submit" className="btn btn-small" disabled={adding || !shelfUrl.trim()}>
              {adding ? 'Adding…' : 'Add URL'}
            </button>
            <button type="button" className="btn btn-small btn-ghost" onClick={() => fileInput.current?.click()} disabled={uploading}>
              <Icon name="upload" size={16} /> {uploading ? 'Uploading…' : 'Upload a file'}
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".pdf,.epub,.txt,.md"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void pickFile(file);
              }}
            />
          </form>
          {shelf && shelf.length === 0 ? (
            <p className="cal-hint">Nothing on the shelf yet.</p>
          ) : (
            <ul className="cal-shelf-list">
              {(shelf ?? []).map((item) => (
                <li key={item.id}>
                  <span>{item.title}</span>
                  <span className={`cal-shelf-status cal-shelf-status-${item.status}`}>{item.status}</span>
                  <button type="button" className="icon-btn" aria-label={`Remove ${item.title}`} onClick={() => void calApi.deleteShelfItem(item.id).then(loadShelf)}>
                    <Icon name="trash" size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  );
}
