// Rules for what a user supplies about their account, shared by the routes
// and the admin account configured in the environment. Pure, so config.ts
// can use them.

export const PASSWORD_MIN_LENGTH = 8;
// argon2 hashes any length, but a multi-megabyte password is only a way to
// make the server work; nobody types one.
export const PASSWORD_MAX_LENGTH = 1024;
// The longest address SMTP allows.
const EMAIL_MAX_LENGTH = 254;

// Trims, then checks for something@something with no whitespace. Nothing
// stricter: there is no email sending, so the address is never verified.
export function normaliseEmail(raw: string): string | null {
  const email = raw.trim();
  if (email.length > EMAIL_MAX_LENGTH || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    return null;
  }
  return email;
}

// Null when the password is acceptable, otherwise why not.
export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  }
  return null;
}

export const DISPLAY_NAME_MAX_LENGTH = 100;

// Null when the value is acceptable as a display name: absent, null (none),
// or a string that is not blank once trimmed and not too long.
export function displayNameProblem(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return "displayName must be a string or null";
  const trimmed = value.trim();
  if (trimmed === "") return "displayName must not be blank";
  if (trimmed.length > DISPLAY_NAME_MAX_LENGTH) {
    return `displayName must be at most ${DISPLAY_NAME_MAX_LENGTH} characters`;
  }
  return null;
}

// Real tags are under 35 characters (RFC 5646 section 4.4.1), but
// private-use subtags make a valid tag any length, and a long one breaks the
// btree index it is stored under (SEC-1). 64 still allows a private-use
// subtag or two. Tags are ASCII, so this counts characters.
export const LOCALE_MAX_LENGTH = 64;

// The canonical form of a BCP-47 tag ("en-gb" -> "en-GB"), or null if the
// value is not one or either form is over LOCALE_MAX_LENGTH.
export function canonicalLocale(value: string): string | null {
  if (value.length > LOCALE_MAX_LENGTH) return null;
  try {
    const [tag] = Intl.getCanonicalLocales(value);
    return tag !== undefined && tag.length <= LOCALE_MAX_LENGTH ? tag : null;
  } catch {
    return null;
  }
}
