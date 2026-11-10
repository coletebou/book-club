import { type ClubPlan, formatBytes } from '@bookclub/shared';
import { Icon } from './Icon';

/**
 * The club's plan (D208): what it stores and how many are in it, against what the plan allows
 * where the host set a limit; for an owner on the free plan, the way to Club Pro when the host
 * offers it. A limit only stops what comes next (a new book, a new member), never what is there.
 */
export function ClubPlanCard({ plan }: { plan: ClubPlan }) {
  const pro = plan.name === 'pro';
  // The plan's day is a UTC one (the CLI's `club-plan --until`), so it reads the same everywhere.
  const until = plan.until ? new Date(plan.until).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : null;
  const { usedBytes, maxBytes } = plan.storage;
  const { count, max } = plan.members;
  return (
    <section className="card stack" aria-labelledby="plan-title" data-testid="club-plan" data-plan={plan.name}>
      <h2 id="plan-title">{pro ? 'Club Pro' : 'Plan'}</h2>
      <p className="small muted">
        {pro ? `Club Pro${until ? ` until ${until}` : ''}: room for a bigger club and more audiobooks.` : 'The free plan.'}
      </p>
      <Meter
        label="Stored"
        testId="plan-storage"
        value={usedBytes}
        max={maxBytes}
        text={maxBytes === null ? `${formatBytes(usedBytes)} stored` : `${formatBytes(usedBytes)} of ${formatBytes(maxBytes)} stored`}
      />
      <Meter label="Members" testId="plan-members" value={count} max={max} text={max === null ? `${count} ${count === 1 ? 'member' : 'members'}` : `${count} of ${max} members`} />
      {plan.proUrl ? (
        <div className="stack-tight">
          <p className="small">Club Pro has room for more members and more audiobooks, and keeps Book Club running for everyone.</p>
          <div>
            <a className="btn btn-primary" href={plan.proUrl} target="_blank" rel="noopener noreferrer" data-testid="plan-pro">
              <Icon name="sparkle" size={18} /> Take Club Pro
            </a>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Meter({ label, testId, value, max, text }: { label: string; testId: string; value: number; max: number | null; text: string }) {
  const share = max ? Math.min(1, value / max) : null;
  return (
    <div className="plan-meter" data-testid={testId}>
      <p className="small">{text}</p>
      {share !== null ? (
        <div
          className={`plan-meter-bar${share >= 0.9 ? ' is-full' : ''}`}
          role="meter"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={max!}
          aria-valuenow={Math.min(value, max!)}
          aria-valuetext={text}
        >
          <span style={{ width: `${Math.round(share * 100)}%` }} />
        </div>
      ) : null}
    </div>
  );
}
