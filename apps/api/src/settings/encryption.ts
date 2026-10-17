import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM for settings stored in the database, such as an AI provider's
// API key, with the key from SETTINGS_ENCRYPTION_KEY. Pure apart from the
// random IV, so config.ts can use parseEncryptionKey.

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
// Stored values start with this, so a later key rotation or algorithm change
// can tell its own values from these.
const VERSION = "v1";

// Thrown for a stored value that cannot be decrypted: altered, encrypted
// under another key or context, or not one of ours. Never carries the value.
export class DecryptError extends Error {
  override name = "DecryptError";
}

// The 32-byte key from 64 hex characters or base64 (standard or url-safe,
// padding optional), or null for anything else. The caller reports the
// problem without echoing the value.
export function parseEncryptionKey(raw: string): Buffer | null {
  const value = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, "hex");
  // 43 characters carry exactly 32 bytes; the 44th is the padding.
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(value)) {
    const key = Buffer.from(value, "base64");
    return key.length === KEY_BYTES ? key : null;
  }
  return null;
}

// Encrypts `plaintext` for storage. `context` names what the value is for
// (e.g. "ai_provider:openai") and is authenticated with it, so a value
// copied to another row does not decrypt there.
export function encryptSetting(
  key: Buffer,
  context: string,
  plaintext: string,
): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [VERSION, iv, cipher.getAuthTag(), ciphertext]
    .map((part) =>
      typeof part === "string" ? part : part.toString("base64url"),
    )
    .join(".");
}

// The plaintext of a value from encryptSetting with the same key and
// context. Throws DecryptError if it has been changed in any way.
export function decryptSetting(
  key: Buffer,
  context: string,
  stored: string,
): string {
  const [version, iv, tag, ciphertext, ...rest] = stored.split(".");
  if (
    version !== VERSION ||
    iv === undefined ||
    tag === undefined ||
    ciphertext === undefined ||
    rest.length > 0
  ) {
    throw new DecryptError(`stored setting for ${context} is not a v1 value`);
  }
  const ivBytes = Buffer.from(iv, "base64url");
  const tagBytes = Buffer.from(tag, "base64url");
  if (ivBytes.length !== IV_BYTES || tagBytes.length !== TAG_BYTES) {
    throw new DecryptError(`stored setting for ${context} is malformed`);
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, ivBytes);
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(tagBytes);
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new DecryptError(
      `stored setting for ${context} failed authentication: altered, or encrypted under another key`,
    );
  }
}
