import { describe, expect, it } from 'vitest';
import { uuid } from './uuid';

// A phone on a plain-HTTP LAN address has no `crypto.randomUUID` (it is a
// secure-context-only API), and the lyrics providers call it while the
// bundle loads: without this fallback the whole page fell over.
describe('uuid', () => {
  it('has the RFC 4122 version-4 layout', () => {
    expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('differs every time', () => {
    const seen = new Set(Array.from({ length: 200 }, () => uuid()));
    expect(seen.size).toBe(200);
  });

  it('falls back when randomUUID is missing, as in an insecure context', () => {
    const original = globalThis.crypto;
    // happy-dom provides one; take it away to stand in for http://192.168.x.x.
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
    try {
      expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true });
    }
  });
});
