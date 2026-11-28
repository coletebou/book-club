import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { calApi } from './cal-api';

export const calConsentKey = ['cal-consent'] as const;

export function refreshNativeCalAvailability(): void {
  window.BookClubNative?.postMessage(JSON.stringify({ type: 'cal-consent-changed' }));
}

export function useCalConsent(userId: string | undefined, open = true) {
  return useQuery({ queryKey: [...calConsentKey, userId], queryFn: calApi.consent, enabled: !!userId && open });
}

export function useCalConsentChoice(userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: calApi.setConsent,
    onSuccess: (current) => {
      qc.setQueryData([...calConsentKey, userId], current);
      refreshNativeCalAvailability();
    },
    onError: () => { void qc.invalidateQueries({ queryKey: [...calConsentKey, userId] }); },
  });
}
