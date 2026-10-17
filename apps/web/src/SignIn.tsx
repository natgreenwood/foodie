import { useEffect, useRef, useState } from "react";
import { signIn } from "./auth";
import { AuthErrorMessage } from "./AuthErrorMessage";
import {
  clearOidcOutcome,
  oidcName,
  oidcStartUrl,
  returningProviderName,
  signInRefusal,
  useOidcConfig,
  usePageRestored,
  type OidcProvider,
} from "./oidc";
import { Link, leaveFor, useLocation } from "./router";
import { useSession } from "./session";

type State =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; error: unknown }
  | { kind: "redirecting"; name: string };

// Signing in sets the session; App then sends the user on to ?next.
export function SignIn({ expired }: { expired: boolean }) {
  const session = useSession();
  const { search } = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });
  const submitting = state.kind === "submitting";
  const redirecting = state.kind === "redirecting";
  // Nothing about OIDC shows until the api lists a provider.
  const providers = useOidcConfig()?.providers ?? [];
  // A refused OIDC sign-in comes back as a page load with ?oidc_error= and
  // ?oidc_provider=. Kept from the first render, as the address loses them
  // once they are shown.
  const [returned] = useState(() => new URLSearchParams(search));
  const refusedCode = returned.get("oidc_error");
  const [refusalDismissed, setRefusalDismissed] = useState(false);
  const refusal =
    providers.length > 0 && refusedCode && !refusalDismissed
      ? signInRefusal(refusedCode, returningProviderName(returned, providers))
      : null;
  const refusalAlert = useRef<HTMLDivElement>(null);

  // Read before the form, as it is what the page load is about.
  useEffect(() => {
    if (!refusal) return;
    refusalAlert.current?.focus();
    clearOidcOutcome(["oidc_error", "oidc_provider"]);
  }, [refusal]);

  usePageRestored(() => setState({ kind: "idle" }));

  return (
    <section aria-labelledby="sign-in-heading">
      <h2 id="sign-in-heading">Sign in</h2>
      {refusal && (
        <div
          ref={refusalAlert}
          tabIndex={-1}
          role="alert"
          className="health"
          data-tone="bad"
        >
          <p>{refusal}</p>
        </div>
      )}
      {expired && (
        <p className="notice">
          Your session has ended. Sign in again to carry on.
        </p>
      )}
      <form
        className="account-form"
        onSubmit={(event) => {
          event.preventDefault();
          setRefusalDismissed(true);
          setState({ kind: "submitting" });
          signIn(email, password).then(session.signedIn, (err: unknown) => {
            console.error("sign-in failed", err);
            setState({ kind: "error", error: err });
          });
        }}
      >
        <label htmlFor="sign-in-email">Email</label>
        <input
          id="sign-in-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <label htmlFor="sign-in-password">Password</label>
        <input
          id="sign-in-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <button type="submit" disabled={submitting || redirecting}>
          Sign in
        </button>
      </form>

      {submitting && (
        <p role="status" className="health" data-tone="pending">
          Signing in…
        </p>
      )}
      {state.kind === "error" && <AuthErrorMessage error={state.error} />}

      {providers.length > 0 && (
        <div className="sso">
          <p className="sso-divider">or</p>
          <ul className="sso-providers">
            {providers.map((provider) => (
              <li key={provider.id}>
                <ProviderButton
                  provider={provider}
                  disabled={submitting || redirecting}
                  onClick={() => {
                    setRefusalDismissed(true);
                    setState({
                      kind: "redirecting",
                      name: oidcName(provider),
                    });
                    leaveFor(oidcStartUrl(provider.id));
                  }}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
      {state.kind === "redirecting" && (
        <p role="status" className="health" data-tone="pending">
          Taking you to {state.name}…
        </p>
      )}

      <p>
        No account yet? <Link to={`/register${search}`}>Register</Link>
      </p>
    </section>
  );
}

// Google's own button, drawn to its sign-in branding guidelines rather than
// in the app's style; every other provider gets the app's button.
function ProviderButton({
  provider,
  disabled,
  onClick,
}: {
  provider: OidcProvider;
  disabled: boolean;
  onClick: () => void;
}) {
  if (provider.id !== "google") {
    return (
      <button type="button" disabled={disabled} onClick={onClick}>
        Sign in with {oidcName(provider)}
      </button>
    );
  }
  return (
    <button
      type="button"
      className="google-signin"
      disabled={disabled}
      onClick={onClick}
    >
      <GoogleLogo />
      <span>Sign in with Google</span>
    </button>
  );
}

// Google's multicolour "G", as Google supplies it; not to be recoloured.
function GoogleLogo() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="20"
      height="20"
      viewBox="0 0 48 48"
    >
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}
