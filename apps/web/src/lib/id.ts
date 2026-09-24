/**
 * A v4 UUID for a command `id` (the idempotency key).
 *
 * Built on `crypto.getRandomValues`, not `crypto.randomUUID`: the latter only exists in secure
 * contexts (HTTPS or localhost), and the office LAN is plain HTTP until M7.
 */
export function newId(fill: (bytes: Uint8Array<ArrayBuffer>) => void = (b) => crypto.getRandomValues(b)): string {
  const b = new Uint8Array(16);
  fill(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
