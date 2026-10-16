import { useState } from "react";
import { AuthError, register } from "./auth";
import { AuthErrorMessage } from "./AuthErrorMessage";
import { Link, useLocation } from "./router";
import { useSession } from "./session";

// PASSWORD_MIN_LENGTH and DISPLAY_NAME_MAX_LENGTH in
// apps/api/src/auth/credentials.ts.
const PASSWORD_MIN_LENGTH = 8;
export const DISPLAY_NAME_MAX_LENGTH = 100;

type State =
  { kind: "idle" } | { kind: "submitting" } | { kind: "error"; error: unknown };

// Registering also signs the new account in; App then sends it on to ?next.
export function Register() {
  const session = useSession();
  const { search } = useLocation();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });
  const submitting = state.kind === "submitting";

  return (
    <section aria-labelledby="register-heading">
      <h2 id="register-heading">Register</h2>
      <form
        className="account-form"
        onSubmit={(event) => {
          event.preventDefault();
          setState({ kind: "submitting" });
          register(email, password, displayName.trim() || null).then(
            session.signedIn,
            (err: unknown) => {
              console.error("registration failed", err);
              setState({ kind: "error", error: err });
            },
          );
        }}
      >
        <label htmlFor="register-email">Email</label>
        <input
          id="register-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <label htmlFor="register-name">Display name (optional)</label>
        <input
          id="register-name"
          type="text"
          autoComplete="nickname"
          maxLength={DISPLAY_NAME_MAX_LENGTH}
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
        <label htmlFor="register-password">Password</label>
        <input
          id="register-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          aria-describedby="register-password-hint"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <p id="register-password-hint" className="hint">
          At least {PASSWORD_MIN_LENGTH} characters.
        </p>
        <button type="submit" disabled={submitting}>
          Register
        </button>
      </form>

      {submitting && (
        <p role="status" className="health" data-tone="pending">
          Creating your account…
        </p>
      )}
      {state.kind === "error" && (
        <AuthErrorMessage error={state.error}>
          {state.error instanceof AuthError &&
            state.error.code === "email_taken" && (
              <p>
                <Link to={`/sign-in${search}`}>Sign in instead</Link>
              </p>
            )}
        </AuthErrorMessage>
      )}

      <p>
        Already registered? <Link to={`/sign-in${search}`}>Sign in</Link>
      </p>
    </section>
  );
}
