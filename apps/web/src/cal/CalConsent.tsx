import type { CalConsent } from '@bookclub/shared';
import { useState } from 'react';
import { FormError, PrivacyLink } from '../components/Form';
import { Modal } from '../components/Modal';
import { useCalConsent, useCalConsentChoice } from '../lib/cal-consent';

export function CalConsentDialog({ userId, consent, onClose, onAllowed, dictation = false }: { userId: string; consent: CalConsent; onClose: () => void; onAllowed?: () => void; dictation?: boolean }) {
  const choice = useCalConsentChoice(userId);
  const providers = new Intl.ListFormat(undefined, { style: 'long', type: 'conjunction' }).format(consent.providers);
  return (
    <Modal title={dictation ? 'Allow AI access for dictation?' : 'Allow Cal to use AI?'} onClose={onClose} initialFocus="[data-consent-later]">
      <div className="stack">
        <p>
          {providers ? `Book Club may share data with ${providers} when you use Cal or dictation.` : 'This demo processes requests on this server.'}{' '}
          Cal uses your question to answer it. Depending on what you ask, Cal also uses your place in the book, a nearby passage,
          club notes you can already see, and your conversation with Cal. When you ask Cal in club chat,
          this can include recent messages and author names from the channel or thread, limited to visible
          messages from members who allowed AI access and Cal’s own replies.
        </p>
        <p>Dictation in chat, search and Cal sends your recording to the speech-to-text service for an editable draft. Spoken Cal also sends the answer text to be read aloud.</p>
        <p>While a club has an active grant, book text from new or updated editions may be sent to build a search index for Cal. You can turn off AI access for Cal and dictation in Settings.</p>
        <PrivacyLink />
        <FormError error={choice.error} />
        <div className="row">
          <button type="button" className="btn" data-consent-later disabled={choice.isPending} onClick={onClose}>Not now</button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={choice.isPending}
            onClick={() => choice.mutate({ allow: true, version: consent.version }, { onSuccess: onAllowed })}
          >
            Allow
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function DictationConsent({ userId, onClose }: { userId: string; onClose: () => void }) {
  const consent = useCalConsent(userId);
  if (!consent.data || consent.isError) return (
    <Modal title="Dictation" onClose={onClose}>
      {consent.isError ? <button type="button" className="btn" onClick={() => void consent.refetch()}>Check AI access again</button> : <p role="status">Checking AI access…</p>}
    </Modal>
  );
  if (!consent.data.enabled) return <Modal title="Dictation" onClose={onClose}><p>Dictation is unavailable on this server.</p></Modal>;
  return <CalConsentDialog userId={userId} consent={consent.data} onClose={onClose} onAllowed={onClose} dictation />;
}

export function CalPrivacySettings({ userId }: { userId: string }) {
  const consent = useCalConsent(userId);
  const choice = useCalConsentChoice(userId);
  const [review, setReview] = useState(false);
  if (!consent.data || (!consent.data.enabled && !consent.data.hasGrant)) return null;
  return (
    <section className="card stack" aria-labelledby="cal-ai-access-title">
      <h2 id="cal-ai-access-title">Cal and AI access</h2>
      <p>{consent.data.allowed ? 'The services listed in the disclosure may receive data for Cal and dictation.' : 'AI access is off.'}</p>
      <FormError error={choice.error} />
      <div className="row">
        {consent.data.enabled ? <button type="button" className="btn" onClick={() => setReview(true)}>Review AI disclosure</button> : null}
        {consent.data.hasGrant ? (
          <button type="button" className="btn" disabled={choice.isPending} onClick={() => choice.mutate({ allow: false })}>Turn off AI access</button>
        ) : null}
      </div>
      {review && consent.data.enabled ? <CalConsentDialog userId={userId} consent={consent.data} onClose={() => setReview(false)} onAllowed={() => setReview(false)} /> : null}
    </section>
  );
}
