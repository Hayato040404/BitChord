/**
 * `crypto.randomUUID()`, which browsers expose only in secure contexts
 * (HTTPS, localhost). A phone opening the site at `http://192.168.x.x` has no
 * `crypto.randomUUID`, and the throw used to take the whole page down — the
 * lyrics providers call it while the bundle loads.
 *
 * The fallback is the RFC 4122 version 4 layout from `Math.random()`. These
 * are identifiers, not secrets: a device id for Listen Together, a Musixmatch
 * client id, a tab's presence id.
 */
export function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  // Version 4, variant 10xx, as the RFC lays them out.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
