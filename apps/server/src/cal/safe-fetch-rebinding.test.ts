import type * as dns from 'node:dns';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Every name resolves to this test's own loopback server: the address a rebinding DNS server
// would hand out on the connect after a public answer on the check.
vi.mock('node:dns', async (importOriginal) => {
  const real = await importOriginal<typeof dns>();
  return {
    ...real,
    lookup: (_host: string, _opts: unknown, cb: (e: null, r: { address: string; family: number }[]) => void) => cb(null, [{ address: '127.0.0.1', family: 4 }]),
  };
});

const { safeFetch, SafeFetchError } = await import('./safe-fetch');

describe('safeFetch connects only to the address it checked (D163)', () => {
  let server: http.Server;
  let port = 0;
  let hits = 0;
  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      hits++;
      res.end('internal secret');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('refuses a public-looking name that resolves to loopback, without connecting', async () => {
    await expect(safeFetch(`http://rebind.example:${port}/`)).rejects.toBeInstanceOf(SafeFetchError);
    expect(hits).toBe(0);
  });

  it('refuses a literal private address, and localhost by name', async () => {
    await expect(safeFetch(`http://127.0.0.1:${port}/`)).rejects.toBeInstanceOf(SafeFetchError);
    await expect(safeFetch(`http://[::ffff:127.0.0.1]:${port}/`)).rejects.toBeInstanceOf(SafeFetchError);
    await expect(safeFetch(`http://localhost:${port}/`)).rejects.toBeInstanceOf(SafeFetchError);
    expect(hits).toBe(0);
  });

  it('refuses other schemes', async () => {
    await expect(safeFetch('file:///etc/passwd')).rejects.toThrow('Only http(s)');
  });
});
