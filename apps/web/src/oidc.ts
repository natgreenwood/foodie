import { useEffect, useState } from "react";
import { AuthError, call, errorFrom, reportUnauthenticated } from "./auth";
import { navigate } from "./router";

// Mirrors the NATG-308 contract in the api's OIDC routes
// (apps/api/src/routes/oidc.ts and me.ts): one entry per configured
// provider, generic then google.
export interface OidcProvider {
  id: string;
  displayName: string | null;
}

export interface OidcConfig {
  providers: OidcProvider[];
}

export interface ProviderConnection extends OidcProvider {
  connected: boolean;
}

export interface OidcConnection {
  providers: ProviderConnection[];
  hasPassword: boolean;
}

// A browser navigation, not a fetch: it answers with a redirect to the
// provider, which comes back to / signed in or to /sign-in?oidc_error=.
export function oidcStartUrl(id: string): string {
  return `/api/auth/oidc/${encodeURIComponent(id)}/start`;
}

// A plain form POST, not a fetch, for the same reason: it answers with a
// redirect to the provider, which comes back to /profile?oidc=connected or
// /profile?oidc_error=.
export function oidcConnectUrl(id: string): string {
  return `/api/auth/oidc/${encodeURIComponent(id)}/connect`;
}

const FALLBACK_NAME = "your identity provider";

// A provider is only ever named by its configured display name, or
// generically without one. Either goes mid-sentence; the one line that
// starts with it capitalises it there.
export function oidcName(provider: OidcProvider): string {
  return provider.displayName ?? FALLBACK_NAME;
}

// The same name standing alone, as a label.
export function oidcLabel(provider: OidcProvider): string {
  return provider.displayName ?? "Identity provider";
}

// The provider an ?oidc_error= came back from, which the api names with
// ?oidc_provider=<id>. Without it, or with an id not configured, the
// generic name stands in.
export function returningProviderName(
  params: URLSearchParams,
  providers: OidcProvider[],
): string {
  const id = params.get("oidc_provider");
  const provider = providers.find((entry) => entry.id === id);
  return provider ? oidcName(provider) : FALLBACK_NAME;
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

function isProvider(entry: unknown): entry is OidcProvider {
  if (typeof entry !== "object" || entry === null) return false;
  const { id, displayName } = entry as Record<string, unknown>;
  return (
    typeof id === "string" &&
    (displayName === null || typeof displayName === "string")
  );
}

function isConfig(body: unknown): body is OidcConfig {
  if (typeof body !== "object" || body === null) return false;
  const { providers } = body as Record<string, unknown>;
  return Array.isArray(providers) && providers.every(isProvider);
}

function isConnection(entry: unknown): entry is ProviderConnection {
  return (
    isProvider(entry) &&
    typeof (entry as { connected?: unknown }).connected === "boolean"
  );
}

export async function fetchOidcConfig(
  signal?: AbortSignal,
): Promise<OidcConfig> {
  const body = await json(
    await call("GET", "/auth/oidc/config", undefined, signal),
  );
  if (isConfig(body)) return { providers: body.providers };
  throw new AuthError(null, "its response was not an OIDC config");
}

// The configured providers, none when OIDC is off; null until the api has
// answered. A failed answer counts as none, so the pages stay as they are.
export function useOidcConfig(): OidcConfig | null {
  const [config, setConfig] = useState<OidcConfig | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetchOidcConfig(controller.signal).then(setConfig, (err: unknown) => {
      if (controller.signal.aborted) return;
      console.error("loading the OIDC config failed", err);
      setConfig({ providers: [] });
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
    const providers =
      typeof oidc === "object" && oidc !== null
        ? (oidc as Record<string, unknown>).providers
        : undefined;
    if (
      Array.isArray(providers) &&
      providers.every(isConnection) &&
      typeof hasPassword === "boolean"
    ) {
      return { providers, hasPassword };
    }
  }
  throw new AuthError(null, "its response did not say how you sign in");
}

// 409 no_other_sign_in when the account would be left with no way to sign in.
export async function disconnectOidc(id: string): Promise<void> {
  const res = await call(
    "DELETE",
    `/auth/oidc/${encodeURIComponent(id)}/connection`,
  );
  if (res.status !== 204) await signedInJson(res);
}

// The words for an ?oidc_error= the api redirected back with. The api sends
// only a code and the provider's id, so the copy lives here; an unknown code
// gets a general line.
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
