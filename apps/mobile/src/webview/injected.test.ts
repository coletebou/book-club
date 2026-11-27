/// <reference types="node" />
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { carPlayConnectionScript, nativeBootstrap } from './injected';

it('makes the current CarPlay connection visible before page scripts, then applies each change before its event', () => {
  const received: [string, boolean | undefined][] = [];
  const win: {
    BookClubNative?: { carPlayConnected?: boolean; postMessage(json: string): void };
    ReactNativeWebView: { postMessage: (json: string) => void };
    dispatchEvent: (event: Event) => void;
  } = {
    ReactNativeWebView: { postMessage: vi.fn() },
    dispatchEvent: (event) => received.push([event.type, win.BookClubNative?.carPlayConnected]),
  };
  const context = { window: win, Event };
  runInNewContext(nativeBootstrap(true), context);
  expect(win.BookClubNative?.carPlayConnected).toBe(true);
  win.BookClubNative?.postMessage('hello');
  expect(win.ReactNativeWebView.postMessage).toHaveBeenCalledWith('hello');
  runInNewContext(carPlayConnectionScript(false), context);
  runInNewContext(carPlayConnectionScript(false), context);
  runInNewContext(carPlayConnectionScript(true), context);
  expect(received).toEqual([['bookclub:carplay-connection', false], ['bookclub:carplay-connection', true]]);
});

it('ends an existing capture and discards an outstanding grant across a connect and disconnect', async () => {
  const live = { readyState: 'live', stop: vi.fn() };
  const delayed = { readyState: 'live', stop: vi.fn() };
  const fresh = { readyState: 'live', stop: vi.fn() };
  let grant!: () => void;
  const nativeGetUserMedia = vi.fn()
    .mockResolvedValueOnce({ getTracks: () => [live] })
    .mockImplementationOnce(() => new Promise((resolve) => { grant = () => resolve({ getTracks: () => [delayed] }); }))
    .mockResolvedValueOnce({ getTracks: () => [fresh] });
  const mediaDevices = { getUserMedia: nativeGetUserMedia };
  const window = Object.assign(new EventTarget(), { navigator: { mediaDevices } });
  const context = { window, Event, DOMException };
  runInNewContext(nativeBootstrap(false), context);

  const first = await mediaDevices.getUserMedia({ audio: true });
  expect(first.getTracks()).toEqual([live]);
  const waiting = mediaDevices.getUserMedia({ audio: true });
  runInNewContext(carPlayConnectionScript(true), context);
  expect(live.stop).toHaveBeenCalledOnce();
  await expect(mediaDevices.getUserMedia({ audio: true })).rejects.toHaveProperty('name', 'NotAllowedError');
  expect(nativeGetUserMedia).toHaveBeenCalledTimes(2);

  runInNewContext(carPlayConnectionScript(false), context);
  grant();
  await expect(waiting).rejects.toHaveProperty('name', 'NotAllowedError');
  expect(delayed.stop).toHaveBeenCalledOnce();
  expect((await mediaDevices.getUserMedia({ audio: true })).getTracks()).toEqual([fresh]);
});
