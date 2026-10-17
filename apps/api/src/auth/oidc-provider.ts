import * as client from "openid-client";
import type { OidcConfig, OidcProviderId } from "../config.js";

// What Foodie reads about the person the provider signed in. Nothing else:
// not groups (admin is granted only in Foodie), not picture.
export interface OidcClaims {
  issuer: string;
  subject: string;
  email: string | null;
  // True only when the provider says so; false or absent is false.
  emailVerified: boolean;
  name: string | null;
}

// The per-browser values a callback is checked against.
export interface OidcChecks {
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface OidcProvider {
  id: OidcProviderId;
  displayName: string | null;
  // The issuer identifiers an identity from this provider is stored under:
  // the configured issuer URL with and without a trailing slash, since
  // discovery accepts either spelling of it.
  issuers: string[];
  // The path of the redirect URL, as the browser requests it.
  callbackPath: string;
  // The admission limits on starting a trip, from the configuration.
  maxPendingLogins: number;
  startsPerMinute: number;
  // Fresh random state, nonce and PKCE verifier for one trip to the provider.
  newChecks(): OidcChecks;
  // Where to send the browser to sign in at the provider.
  authorizationUrl(checks: OidcChecks): Promise<URL>;
  // Exchanges the code in the callback's query string and returns the
  // validated claims. Throws if the response, state, nonce, PKCE verifier
  // or ID token does not check out, or the provider cannot be reached.
  claims(callbackQuery: string, checks: OidcChecks): Promise<OidcClaims>;
}

const SCOPE = "openid profile email";
// For each request to the provider, discovery included.
const TIMEOUT_SECONDS = 10;

// A standards-only OIDC client: everything about the provider comes from its
// discovery document, fetched on first use and kept. A failed discovery is
// not kept, so the next sign-in tries again.
//
// The ID token's signature is checked against the discovered JWKS, on top of
// the TLS the token endpoint already has: the issuer URL is set by whoever
// deploys Foodie. On a kid it does not know, openid-client fetches the JWKS
// again only once its copy is a minute old, so a provider that starts signing
// with a key it published less than a minute earlier is refused until then.
export function oidcProvider(
  settings: OidcConfig,
  // Plain http to the provider; only the tests' mock and a development
  // provider without a certificate need it.
  { allowHttp = settings.issuerUrl.protocol === "http:" } = {},
): OidcProvider {
  let configuration: Promise<client.Configuration> | null = null;

  function discover(): Promise<client.Configuration> {
    configuration ??= client
      .discovery(
        settings.issuerUrl,
        settings.clientId,
        settings.clientSecret,
        undefined,
        {
          timeout: TIMEOUT_SECONDS,
          ...(allowHttp ? { execute: [client.allowInsecureRequests] } : {}),
        },
      )
      .then((config) => {
        client.enableNonRepudiationChecks(config);
        return config;
      })
      .catch((err: unknown) => {
        configuration = null;
        throw err;
      });
    return configuration;
  }

  const href = settings.issuerUrl.href;
  return {
    id: settings.id,
    displayName: settings.displayName,
    issuers: [...new Set([href, href.replace(/\/$/, "")])],
    callbackPath: settings.redirectUrl.pathname,
    maxPendingLogins: settings.maxPendingLogins,
    startsPerMinute: settings.startsPerMinute,

    newChecks() {
      return {
        state: client.randomState(),
        nonce: client.randomNonce(),
        codeVerifier: client.randomPKCECodeVerifier(),
      };
    },

    async authorizationUrl(checks) {
      const config = await discover();
      return client.buildAuthorizationUrl(config, {
        redirect_uri: settings.redirectUrl.href,
        scope: SCOPE,
        state: checks.state,
        nonce: checks.nonce,
        code_challenge: await client.calculatePKCECodeChallenge(
          checks.codeVerifier,
        ),
        code_challenge_method: "S256",
      });
    },

    async claims(callbackQuery, checks) {
      const config = await discover();
      // The callback as the provider addressed it, whatever path the api
      // sees behind the web app's /api/ proxy.
      const currentUrl = new URL(settings.redirectUrl);
      currentUrl.search = callbackQuery;
      const tokens = await client.authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: checks.codeVerifier,
        expectedState: checks.state,
        expectedNonce: checks.nonce,
      });
      const idToken = tokens.claims()!;
      // The UserInfo response is the full set of standard claims when the
      // provider has the endpoint; the ID token may carry only some. Email
      // and email_verified are always taken from the same one.
      const source: Record<string, unknown> = config.serverMetadata()
        .userinfo_endpoint
        ? await client.fetchUserInfo(config, tokens.access_token, idToken.sub)
        : idToken;
      return {
        issuer: idToken.iss,
        subject: idToken.sub,
        email: typeof source.email === "string" ? source.email : null,
        emailVerified: source.email_verified === true,
        name: typeof source.name === "string" ? source.name : null,
      };
    },
  };
}
