/** UUIDv7 — 48-bit unix-ms prefix + version/variant + random. Sortable by time. */
export function uuidv7(): string {
  const now = Date.now();
  const tsHi = Math.floor(now / 2 ** 16).toString(16).padStart(8, "0");
  const tsLo = (now & 0xffff).toString(16).padStart(4, "0");

  const rand = crypto.getRandomValues(new Uint8Array(10));
  const hex = (b: number) => b.toString(16).padStart(2, "0");

  // 12-bit random in the 3rd group, version 7 in top nibble
  const r12 = ((rand[0]! << 8) | rand[1]!) & 0x0fff;
  const group3 = ((0x7 << 12) | r12).toString(16).padStart(4, "0");

  // 14-bit random in group 4, variant 10 in top bits
  const r14 = (((rand[2]! & 0x3f) << 8) | rand[3]!) & 0x3fff;
  const group4 = (0x8000 | r14).toString(16).padStart(4, "0");

  const group5 = Array.from(rand.slice(4, 10)).map(hex).join("");

  return `${tsHi}-${tsLo}-${group3}-${group4}-${group5}`;
}
