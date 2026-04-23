import { describe, expect, it } from "vitest";
import { uuidv7 } from "../src/lib/id.ts";

describe("uuidv7", () => {
  it("produces canonical UUID shape", () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("is monotonic-ish within a millisecond", () => {
    const ids = Array.from({ length: 200 }, () => uuidv7());
    const tsPart = (id: string) => parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
    let prev = 0;
    for (const id of ids) {
      const t = tsPart(id);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });

  it("produces unique ids", () => {
    const set = new Set(Array.from({ length: 1000 }, () => uuidv7()));
    expect(set.size).toBe(1000);
  });
});
