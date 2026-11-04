import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { keys } from '../lib/queries';
import { ListeningSettingsCard, SpeedButton, SpeedPicker } from './SpeedControl';
import { rememberedDefault } from './speed-memory';

function Picker({ start = 1, max }: { start?: number; max?: number }) {
  const [rate, setRate] = useState(start);
  return <SpeedPicker value={rate} onChange={setRate} label="Playback speed" {...(max !== undefined ? { max } : {})} />;
}

const value = () => screen.getByTestId('speed-value').textContent;
const checked = () => screen.getAllByRole('radio').filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.textContent);

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SpeedPicker (D195)', () => {
  it('steps by 0.05 either way, shown cleanly', () => {
    render(<Picker />);
    expect(value()).toBe('1.0×');
    for (let i = 0; i < 7; i++) fireEvent.click(screen.getByTestId('speed-up'));
    expect(value()).toBe('1.35×');
    fireEvent.click(screen.getByTestId('speed-down'));
    expect(value()).toBe('1.3×');
    expect(screen.getByTestId('speed-up').getAttribute('aria-label')).toBe('Faster, 1.35 times');
    expect(screen.getByTestId('speed-down').getAttribute('aria-label')).toBe('Slower, 1.25 times');
  });

  it('offers the common speeds, marking the one in effect', () => {
    render(<Picker />);
    expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual(['0.75×', '1.0×', '1.25×', '1.5×', '1.75×', '2.0×', '2.5×', '3.0×']);
    expect(checked()).toEqual(['1.0×']);
    fireEvent.click(screen.getByTestId('speed-preset-1.75'));
    expect(value()).toBe('1.75×');
    expect(checked()).toEqual(['1.75×']);
    fireEvent.click(screen.getByTestId('speed-up'));
    expect(checked()).toEqual([]); // 1.8× is none of them.
  });

  it('stops at the ends of the range', () => {
    render(<Picker start={0.55} />);
    fireEvent.click(screen.getByTestId('speed-down'));
    expect(value()).toBe('0.5×');
    expect(screen.getByTestId<HTMLButtonElement>('speed-down').disabled).toBe(true);
    cleanup();
    render(<Picker start={2.95} />);
    fireEvent.click(screen.getByTestId('speed-up'));
    expect(value()).toBe('3.0×');
    expect(screen.getByTestId<HTMLButtonElement>('speed-up').disabled).toBe(true);
  });

  it('on a device that plays no faster than 2×, offers nothing faster', () => {
    render(<Picker start={1.95} max={2} />);
    fireEvent.click(screen.getByTestId('speed-up'));
    expect(value()).toBe('2.0×');
    expect(screen.getByTestId<HTMLButtonElement>('speed-up').disabled).toBe(true);
    expect(screen.queryByTestId('speed-preset-2.5')).toBeNull();
  });
});

describe('Settings: your default speed (D195)', () => {
  it('shows the default the server has, and saves a new one at once', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(keys.session, { user: { id: 'ana' } });
    vi.spyOn(api, 'listening').mockResolvedValue({ defaultRate: 1.25, at: 10 });
    const save = vi.spyOn(api, 'setListening').mockImplementation(async (body) => body);
    render(<MemoryRouter><QueryClientProvider client={qc}><ListeningSettingsCard /></QueryClientProvider></MemoryRouter>);
    await waitFor(() => expect(value()).toBe('1.25×'));
    fireEvent.click(screen.getByTestId('speed-up'));
    await waitFor(() => expect(screen.getByTestId('default-speed-status').textContent).toBe('Saved. New audiobooks start at 1.3×.'));
    expect(save).toHaveBeenCalledWith({ defaultRate: 1.3, at: expect.any(Number) as number });
    expect(value()).toBe('1.3×');
    expect(rememberedDefault('ana')?.rate).toBe(1.3);
  });
});

describe('SpeedButton (D195)', () => {
  it('cannot be opened until the page\'s book is in the player', () => {
    const qc = new QueryClient();
    const { rerender } = render(<MemoryRouter><QueryClientProvider client={qc}><SpeedButton bookId="b" disabled /></QueryClientProvider></MemoryRouter>);
    expect(screen.getByTestId<HTMLButtonElement>('speed').disabled).toBe(true);
    fireEvent.click(screen.getByTestId('speed'));
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(<MemoryRouter><QueryClientProvider client={qc}><SpeedButton bookId="b" /></QueryClientProvider></MemoryRouter>);
    expect(screen.getByTestId<HTMLButtonElement>('speed').disabled).toBe(false);
  });
});
