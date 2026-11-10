import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type CalendarFeed } from '@bookclub/shared';
import { api } from '../lib/api';
import { confirmAction } from '../lib/confirm';
import { keys } from '../lib/queries';
import { FormError } from './Form';
import { Icon } from './Icon';
import { useToast } from './Toasts';

/**
 * Your meet-ups in your own calendar (D207): one private address for every club you are in, which
 * your calendar app subscribes to and keeps up to date, reminding you itself. The address is a key
 * and is shown only when it is made; getting a new one, or turning it off, ends the old one.
 */
export function CalendarFeedCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const status = useQuery({ queryKey: keys.calendarFeed, queryFn: () => api.calendarFeed() });
  const make = useMutation({
    mutationFn: () => api.makeCalendarFeed(),
    onSuccess: (feed) => qc.setQueryData<CalendarFeed>(keys.calendarFeed, { ...feed, url: null, webcalUrl: null }),
  });
  const remove = useMutation({
    mutationFn: () => api.removeCalendarFeed(),
    onSuccess: () => {
      make.reset();
      qc.setQueryData<CalendarFeed>(keys.calendarFeed, { enabled: false, createdAt: null, url: null, webcalUrl: null });
    },
  });
  const made = make.data?.url ? make.data : null;
  const enabled = status.data?.enabled === true;
  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.show('Calendar address copied.');
    } catch {
      toast.show('Select the address and copy it.', 'error');
    }
  };
  const renew = async () => {
    if (enabled && !(await confirmAction({ title: 'Get a new address?', body: 'Calendars using the old one stop getting meet-ups.', confirm: 'Get a new one', cancel: 'Keep it' }))) return;
    make.mutate();
  };
  return (
    <section className="card stack" aria-labelledby="calendar-title" data-testid="calendar-feed">
      <h2 id="calendar-title">Meet-ups in your calendar</h2>
      <p className="muted small">
        Every meet-up of every club you are in, in your phone’s or computer’s calendar, kept up to date when one moves, with a reminder the day before and an hour before. The
        address is private: anyone who has it sees your clubs’ meet-ups.
      </p>
      <FormError error={make.error ?? remove.error} />
      {made ? (
        <div className="stack-tight" role="status">
          <label className="field">
            <span className="small">Your calendar address (shown only now)</span>
            <input readOnly value={made.url!} data-testid="calendar-feed-url" onFocus={(e) => e.currentTarget.select()} />
          </label>
          <div className="row">
            <a className="btn btn-primary" href={made.webcalUrl!} data-testid="calendar-feed-subscribe">
              <Icon name="calendar" size={18} /> Add to my calendar
            </a>
            <button type="button" className="btn" onClick={() => void copy(made.url!)}>
              Copy address
            </button>
          </div>
          <p className="faint small">On an iPhone or a Mac, “Add to my calendar” subscribes. For Google Calendar, copy the address into Other calendars → From URL.</p>
        </div>
      ) : enabled ? (
        <p className="small" data-testid="calendar-feed-on">
          On since {new Date(status.data!.createdAt!).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}. Lost the address? Get a new one.
        </p>
      ) : null}
      <div className="row">
        <button type="button" className={`btn${enabled || made ? '' : ' btn-primary'}`} onClick={() => void renew()} disabled={make.isPending || status.isPending} data-testid="calendar-feed-make">
          {enabled || made ? 'Get a new address' : 'Get a calendar address'}
        </button>
        {enabled || made ? (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void confirmAction({ title: 'Turn the calendar off?', body: 'Calendars using the address stop getting meet-ups.', confirm: 'Turn off', cancel: 'Keep it' }).then((yes) => yes && remove.mutate())}
            disabled={remove.isPending}
            data-testid="calendar-feed-off"
          >
            Turn off
          </button>
        ) : null}
      </div>
    </section>
  );
}
