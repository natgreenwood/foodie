// Mirrors Profile in apps/api/src/auth/accounts.ts: what GET /me returns.
export interface Profile {
  id: number;
  email: string;
  displayName: string | null;
  locale: string;
  isAdmin: boolean;
}

// `code` is the api's error code (invalid_request, invalid_credentials,
// email_taken, unauthenticated, internal_error) or null when we never got a
// contract error back. `message` is the api's own message when it sent one.
export class AuthError extends Error {
  override name = "AuthError";
  constructor(
    readonly code: string | null,
    message: string,
  ) {
    super(message);
  }
}

// Fired when a protected route answers 401: the session has ended or never
// existed. The session provider listens and sends the user to sign-in.
export const sessionEvents = new EventTarget();

export function reportUnauthenticated() {
  sessionEvents.dispatchEvent(new Event("unauthenticated"));
}

// Fired when an admin route answers 403: the user is no longer an admin.
// The session provider listens and drops their admin access.
export function reportForbidden() {
  sessionEvents.dispatchEvent(new Event("forbidden"));
}

function isProfile(body: unknown): body is Profile {
  if (typeof body !== "object" || body === null) return false;
  const { id, email, displayName, locale, isAdmin } = body as Record<
    string,
    unknown
  >;
  return (
    typeof id === "number" &&
    typeof email === "string" &&
    (displayName === null || typeof displayName === "string") &&
    typeof locale === "string" &&
    typeof isAdmin === "boolean"
  );
}

export async function call(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  try {
    return await fetch(`/api${path}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      ...(signal && { signal }),
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new AuthError(null, "the request failed before a response arrived");
  }
}

async function profileFrom(res: Response): Promise<Profile> {
  const body: unknown = await res.json().catch(() => undefined);
  if (res.ok) {
    if (isProfile(body)) return body;
    throw new AuthError(null, "its response was not a profile");
  }
  throw errorFrom(res, body);
}

// The AuthError for a response that is not ok, from the api's contract
// error when it sent one.
export function errorFrom(res: Response, body: unknown): AuthError {
  if (typeof body === "object" && body !== null) {
    const { error, message } = body as Record<string, unknown>;
    if (typeof error === "string") {
      return new AuthError(
        error,
        typeof message === "string" ? message : `HTTP ${res.status} ${error}`,
      );
    }
  }
  return new AuthError(null, `the server answered with HTTP ${res.status}`);
}

// The signed-in user, or null when there is no session.
export async function fetchMe(signal?: AbortSignal): Promise<Profile | null> {
  const res = await call("GET", "/me", undefined, signal);
  if (res.status === 401) return null;
  return profileFrom(res);
}

export async function signIn(email: string, password: string) {
  return profileFrom(await call("POST", "/auth/login", { email, password }));
}

export async function register(
  email: string,
  password: string,
  displayName: string | null,
) {
  return profileFrom(
    await call("POST", "/auth/register", {
      email,
      password,
      ...(displayName !== null && { displayName }),
    }),
  );
}

export async function signOut(): Promise<void> {
  const res = await call("POST", "/auth/logout");
  if (res.status !== 204) {
    throw new AuthError(null, `the server answered with HTTP ${res.status}`);
  }
}

export async function updateProfile(changes: {
  displayName: string | null;
  locale: string;
}): Promise<Profile> {
  const res = await call("PATCH", "/me", changes);
  if (res.status === 401) reportUnauthenticated();
  return profileFrom(res);
}
