import { describe, expect, it } from "vitest";
import {
  bytesToHex,
  hexToBytes,
  hmacSha256Hex,
  normalizeContent,
  sha256Hex,
  timingSafeEqualHex,
} from "../src/lib/hash.ts";

describe("hash helpers", () => {
  it("sha256Hex matches known vector", async () => {
    const h = await sha256Hex("abc");
    expect(h).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("normalizeContent trims, collapses, NFKCs", () => {
    expect(normalizeContent("  foo   bar \n baz ")).toBe("foo bar baz");
    // NFKC combines half/full width — e.g. ＡＢＣ → ABC
    expect(normalizeContent("ＡＢＣ")).toBe("ABC");
  });

  it("timingSafeEqualHex", () => {
    expect(timingSafeEqualHex("deadbeef", "deadbeef")).toBe(true);
    expect(timingSafeEqualHex("deadbeef", "DEADBEEF")).toBe(false);
    expect(timingSafeEqualHex("deadbeef", "deadbee0")).toBe(false);
    expect(timingSafeEqualHex("ab", "abcd")).toBe(false);
  });

  it("hmacSha256Hex RFC 4231 test 2", async () => {
    // key = "Jefe", data = "what do ya want for nothing?"
    const mac = await hmacSha256Hex("Jefe", "what do ya want for nothing?");
    expect(mac).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });

  it("bytes/hex roundtrip", () => {
    const orig = new Uint8Array([0, 1, 15, 16, 255]);
    const hex = bytesToHex(orig);
    expect(hex).toBe("00010f10ff");
    expect(hexToBytes(hex)).toEqual(orig);
  });
});
