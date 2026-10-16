import { useState } from "react";
import { signIn } from "./auth";
import { AuthErrorMessage } from "./AuthErrorMessage";
import { Link, useLocation } from "./router";
import { useSession } from "./session";

type State =
  { kind: "idle" } | { kind: "submitting" } | { kind: "error"; error: unknown };

// Signing in sets the session; App then sends the user on to ?next.
export function SignIn({ expired }: { expired: boolean }) {
  const session = useSession();
  const { search } = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });
  const submitting = state.kind === "submitting";

  return (
    <section aria-labelledby="sign-in-heading">
      <h2 id="sign-in-heading">Sign in</h2>
      {expired && (
        <p className="notice">
          Your session has ended. Sign in again to carry on.
        </p>
      )}
      <form
        className="account-form"
        onSubmit={(event) => {
          event.preventDefault();
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
        <button type="submit" disabled={submitting}>
          Sign in
        </button>
      </form>

      {submitting && (
        <p role="status" className="health" data-tone="pending">
          Signing in…
        </p>
      )}
      {state.kind === "error" && <AuthErrorMessage error={state.error} />}

      <p>
        No account yet? <Link to={`/register${search}`}>Register</Link>
      </p>
    </section>
  );
}
