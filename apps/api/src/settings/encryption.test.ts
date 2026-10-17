import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DecryptError,
  decryptSetting,
  encryptSetting,
  parseEncryptionKey,
} from "./encryption.js";

const key = randomBytes(32);
const SECRET = "sk-ant-test-0123456789";
const CONTEXT = "ai_provider:anthropic";

// Flips one bit of the base64url part at `index` of a stored value.
function tamper(stored: string, index: number): string {
  const parts = stored.split(".");
  const bytes = Buffer.from(parts[index]!, "base64url");
  bytes[0]! ^= 1;
  parts[index] = bytes.toString("base64url");
  return parts.join(".");
}

describe("encryptSetting and decryptSetting", () => {
  it("round-trips, and never stores the plaintext", () => {
    const stored = encryptSetting(key, CONTEXT, SECRET);

    expect(stored).toMatch(/^v1\./);
    expect(stored).not.toContain(SECRET);
    expect(decryptSetting(key, CONTEXT, stored)).toBe(SECRET);
  });

  it("uses a fresh IV each time", () => {
    expect(encryptSetting(key, CONTEXT, SECRET)).not.toBe(
      encryptSetting(key, CONTEXT, SECRET),
    );
  });

  it.each([
    ["iv", 1],
    ["tag", 2],
    ["ciphertext", 3],
  ])("detects a changed %s", (_, index) => {
    const stored = encryptSetting(key, CONTEXT, SECRET);

    expect(() => decryptSetting(key, CONTEXT, tamper(stored, index))).toThrow(
      DecryptError,
    );
  });

  it("refuses another key", () => {
    const stored = encryptSetting(key, CONTEXT, SECRET);

    expect(() => decryptSetting(randomBytes(32), CONTEXT, stored)).toThrow(
      DecryptError,
    );
  });

  it("refuses a value moved to another context", () => {
    const stored = encryptSetting(key, CONTEXT, SECRET);

    expect(() => decryptSetting(key, "ai_provider:openai", stored)).toThrow(
      DecryptError,
    );
  });

  it.each(["", SECRET, "v2.a.b.c", "v1.a.b", "v1.AAAA.AAAA.AAAA"])(
    "refuses the malformed value %j without echoing it",
    (stored) => {
      expect(() => decryptSetting(key, CONTEXT, stored)).toThrow(
        expect.objectContaining({
          name: "DecryptError",
          message: expect.not.stringContaining(SECRET) as string,
        }) as Error,
      );
    },
  );
});

describe("parseEncryptionKey", () => {
  it("reads 64 hex characters and 32 bytes of base64", () => {
    expect(parseEncryptionKey(key.toString("hex"))).toEqual(key);
    expect(parseEncryptionKey(key.toString("base64"))).toEqual(key);
    expect(parseEncryptionKey(` ${key.toString("base64url")}\n`)).toEqual(key);
  });

  it.each([
    "",
    "short",
    randomBytes(31).toString("hex"),
    randomBytes(31).toString("base64"),
    randomBytes(33).toString("base64"),
  ])("refuses %j", (raw) => {
    expect(parseEncryptionKey(raw)).toBeNull();
  });
});
