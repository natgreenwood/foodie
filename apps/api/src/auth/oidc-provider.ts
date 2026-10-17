import * as client from "openid-client";
import type { OidcConfig } from "../config.js";

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
  displayName: string | null;
  // The path of the redirect URL, as the browser requests it.
  callbackPath: string;
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
      .catch((err: unknown) => {
        configuration = null;
        throw err;
      });
    return configuration;
  }

  return {
    displayName: settings.displayName,
    callbackPath: settings.redirectUrl.pathname,

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
