import { useEffect, useState } from "react";
import { AuthError, call, errorFrom, reportUnauthenticated } from "./auth";
import { navigate } from "./router";

// Mirrors the "Contract for NATG-288" in the api's OIDC routes
// (apps/api/src/routes/oidc.ts and me.ts).
export interface OidcConfig {
  enabled: boolean;
  displayName: string | null;
}

export interface OidcConnection {
  connected: boolean;
  hasPassword: boolean;
}

// A browser navigation, not a fetch: it answers with a redirect to the
// provider, which comes back to / signed in or to /sign-in?oidc_error=.
export const OIDC_START_URL = "/api/auth/oidc/start";

// A plain form POST, not a fetch, for the same reason: it answers with a
// redirect to the provider, which comes back to /profile?oidc=connected or
// /profile?oidc_error=.
export const OIDC_CONNECT_URL = "/api/auth/oidc/connect";

// The provider is only ever named by its configured display name, or
// generically without one. Either goes mid-sentence, so no line starts with it.
export function oidcName(config: OidcConfig): string {
  return config.displayName ?? "your identity provider";
}

// The same name standing alone, as a label.
export function oidcLabel(config: OidcConfig): string {
  return config.displayName ?? "Identity provider";
}

async function json(res: Response): Promise<unknown> {
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) throw errorFrom(res, body);
  return body;
}

// For the routes that need a session: a 401 means it has ended.
async function signedInJson(res: Response): Promise<unknown> {
  if (res.status === 401) reportUnauthenticated();
  return json(res);
}

function isConfig(body: unknown): body is OidcConfig {
  if (typeof body !== "object" || body === null) return false;
  const { enabled, displayName } = body as Record<string, unknown>;
  return (
    typeof enabled === "boolean" &&
    (displayName === null || typeof displayName === "string")
  );
}

export async function fetchOidcConfig(
  signal?: AbortSignal,
): Promise<OidcConfig> {
  const body = await json(
    await call("GET", "/auth/oidc/config", undefined, signal),
  );
  if (isConfig(body)) return body;
  throw new AuthError(null, "its response was not an OIDC config");
}

// Whether OIDC is on, and what to call it; null until the api has answered.
// A failed answer counts as off, so the pages stay as they are without it.
export function useOidcConfig(): OidcConfig | null {
  const [config, setConfig] = useState<OidcConfig | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetchOidcConfig(controller.signal).then(setConfig, (err: unknown) => {
      if (controller.signal.aborted) return;
      console.error("loading the OIDC config failed", err);
      setConfig({ enabled: false, displayName: null });
    });
    return () => controller.abort();
  }, []);
  return config;
}

// Going back from the provider can restore a page from the back/forward
// cache just as it was left, still saying it is on its way there.
export function usePageRestored(restored: () => void) {
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) restored();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [restored]);
}

// Once the page has shown what an OIDC redirect came back to say, the
// address stops saying it, so a reload or a shared link does not say it
// again. Only the named parameters go: ?next, anything else and the hash
// stay. Through the router, so the pages see the new address; a no-op once
// they have gone, as Strict Mode runs effects twice.
export function clearOidcOutcome(names: readonly string[]) {
  const url = new URL(window.location.href);
  if (!names.some((name) => url.searchParams.has(name))) return;
  for (const name of names) url.searchParams.delete(name);
  navigate(url.pathname + url.search + url.hash, { replace: true });
}

// How the account signs in, from GET /me's hasPassword and oidc. Fetched
// here rather than taken from the session, because sign-in and register
// answer with a profile that does not carry them.
export async function fetchOidcConnection(
  signal?: AbortSignal,
): Promise<OidcConnection> {
  const body = await signedInJson(await call("GET", "/me", undefined, signal));
  if (typeof body === "object" && body !== null) {
    const { hasPassword, oidc } = body as Record<string, unknown>;
    const connected =
      typeof oidc === "object" && oidc !== null
        ? (oidc as Record<string, unknown>).connected
        : undefined;
    if (typeof connected === "boolean" && typeof hasPassword === "boolean") {
      return { connected, hasPassword };
    }
  }
  throw new AuthError(null, "its response did not say how you sign in");
}

// 409 no_local_password when the account has no password to fall back on.
export async function disconnectOidc(): Promise<void> {
  const res = await call("DELETE", "/auth/oidc/connection");
  if (res.status !== 204) await signedInJson(res);
}

// The words for an ?oidc_error= the api redirected back with. The api sends
// only a code, so the copy lives here; an unknown code gets a general line.
// Each line has to be true for every case the api folds into its code.

// A sign-in can be refused with email_unverified, account_disabled,
// already_connected or provider_error.
const signInRefusals: Record<string, (name: string) => string> = {
  email_unverified: (name) =>
    `An account with that email already exists. Sign in with your password, then connect ${name} from your profile.`,
  account_disabled: () =>
    "This account has been disabled. Ask an administrator to re-enable it.",
  already_connected: (name) =>
    `An account with that email is already connected to another identity at ${name}. Sign in with your password to manage it from your profile.`,
  provider_error: (name) => `Sign-in with ${name} didn't complete. Try again.`,
};

// A connect can be refused with email_mismatch, already_connected or
// provider_error.
const connectRefusals: Record<string, (name: string) => string> = {
  email_mismatch: (name) =>
    `The email ${name} returned doesn't match this account's email. Nothing was connected.`,
  already_connected: (name) =>
    `That identity at ${name} is already connected to an account, so nothing was changed.`,
  provider_error: (name) => `Connecting ${name} didn't complete. Try again.`,
};

export function signInRefusal(code: string, name: string): string {
  const line = Object.hasOwn(signInRefusals, code)
    ? signInRefusals[code]
    : undefined;
  return line ? line(name) : `Signing in with ${name} didn't work. Try again.`;
}

export function connectRefusal(code: string, name: string): string {
  const line = Object.hasOwn(connectRefusals, code)
    ? connectRefusals[code]
    : undefined;
  return line ? line(name) : `Connecting ${name} didn't work. Try again.`;
}
