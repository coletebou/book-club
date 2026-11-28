import type { CalConsent } from '@bookclub/shared';
import { useState } from 'react';
import { FormError, PrivacyLink } from '../components/Form';
import { Modal } from '../components/Modal';
import { useCalConsent, useCalConsentChoice } from '../lib/cal-consent';

export function CalConsentDialog({ userId, consent, onClose, onAllowed }: { userId: string; consent: CalConsent; onClose: () => void; onAllowed?: () => void }) {
  const choice = useCalConsentChoice(userId);
  const providers = new Intl.ListFormat(undefined, { style: 'long', type: 'conjunction' }).format(consent.providers);
  return (
    <Modal title="Allow Cal to use AI?" onClose={onClose} initialFocus="[data-consent-later]">
      <div className="stack">
        <p>
          {providers ? `When you use Cal, Book Club may share data with ${providers}.` : 'This demo runs Cal on this server.'}{' '}
          Cal uses your question to answer it. Depending on what you ask, Cal also uses your place in the book, a nearby passage,
          club notes you can already see, and your conversation with Cal. Voice questions also share
          your recording for transcription and send the answer text to be read aloud.
        </p>
        <p>You can turn off Cal and stop future requests in Settings.</p>
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

export function CalPrivacySettings({ userId }: { userId: string }) {
  const consent = useCalConsent(userId);
  const choice = useCalConsentChoice(userId);
  const [review, setReview] = useState(false);
  if (!consent.data || (!consent.data.enabled && !consent.data.hasGrant)) return null;
  return (
    <section className="card stack" aria-labelledby="cal-ai-access-title">
      <h2 id="cal-ai-access-title">Cal and AI access</h2>
      <p>{consent.data.allowed ? 'Cal can use the AI providers listed in the disclosure.' : 'Cal is off.'}</p>
      <FormError error={choice.error} />
      <div className="row">
        {consent.data.enabled ? <button type="button" className="btn" onClick={() => setReview(true)}>Review AI disclosure</button> : null}
        {consent.data.hasGrant ? (
          <button type="button" className="btn" disabled={choice.isPending} onClick={() => choice.mutate({ allow: false })}>Turn off Cal</button>
        ) : null}
      </div>
      {review && consent.data.enabled ? <CalConsentDialog userId={userId} consent={consent.data} onClose={() => setReview(false)} onAllowed={() => setReview(false)} /> : null}
    </section>
  );
}
