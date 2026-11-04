import { describe, expect, it } from 'vitest';
import { isPrivateAddress } from './safe-fetch';

describe('isPrivateAddress', () => {
  it('flags loopback, private, link-local and carrier-grade NAT IPv4 ranges', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true);
    expect(isPrivateAddress('10.1.2.3')).toBe(true);
    expect(isPrivateAddress('172.16.0.1')).toBe(true);
    expect(isPrivateAddress('172.31.255.255')).toBe(true);
    expect(isPrivateAddress('192.168.1.1')).toBe(true);
    expect(isPrivateAddress('169.254.1.1')).toBe(true);
    expect(isPrivateAddress('100.64.0.1')).toBe(true);
    expect(isPrivateAddress('0.0.0.0')).toBe(true);
  });

  it('allows an ordinary public IPv4 address', () => {
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
    // Not a 172.16-172.31 private block: a public address in the same /8.
    expect(isPrivateAddress('172.64.0.1')).toBe(false);
  });

  it('flags loopback and link-local IPv6', () => {
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('fe80::1')).toBe(true);
    expect(isPrivateAddress('fd00::1')).toBe(true);
  });

  it('judges an IPv4 address written as IPv6 as the IPv4 address it is', () => {
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:169.254.169.254')).toBe(true);
    expect(isPrivateAddress('::ffff:a00:1')).toBe(true); // 10.0.0.1 in hex
    expect(isPrivateAddress('64:ff9b::192.168.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
    expect(isPrivateAddress('::')).toBe(true);
    expect(isPrivateAddress('ff02::1')).toBe(true);
    expect(isPrivateAddress('2606:4700::1111')).toBe(false);
  });

  it('treats a non-IP string as unsafe (it is resolved and rechecked, never trusted bare)', () => {
    expect(isPrivateAddress('example.com')).toBe(true);
  });
});
