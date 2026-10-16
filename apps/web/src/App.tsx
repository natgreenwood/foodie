import { useEffect, useRef, useState, type ReactNode } from "react";
import { signOut, type Profile } from "./auth";
import { HealthStatus } from "./HealthStatus";
import { ImportPreview } from "./ImportPreview";
import { ProfilePage } from "./ProfilePage";
import { Register } from "./Register";
import { Link, Redirect, useLocation } from "./router";
import { SessionProvider, useSession } from "./session";
import { SignIn } from "./SignIn";

// "signedIn" pages send a visitor to sign-in; "signedOut" pages send a
// signed-in user on to where they were going.
const routes: Record<
  string,
  { title: string; access: "signedIn" | "signedOut" }
> = {
  "/": { title: "Import", access: "signedIn" },
  "/profile": { title: "Profile", access: "signedIn" },
  "/sign-in": { title: "Sign in", access: "signedOut" },
  "/register": { title: "Register", access: "signedOut" },
};

// Where sign-in returns to: ?next when it is a path on this site, so the
// link cannot send anyone elsewhere, and home otherwise.
export function returnPath(search: string): string {
  const next = new URLSearchParams(search).get("next");
  if (!next?.startsWith("/") || next.startsWith("//") || next.startsWith("/\\"))
    return "/";
  const { pathname } = new URL(next, window.location.origin);
  return routes[pathname]?.access === "signedOut" ? "/" : next;
}

function signInPath(from: string): string {
  return from === "/"
    ? "/sign-in"
    : `/sign-in?next=${encodeURIComponent(from)}`;
}

export function App() {
  return (
    <SessionProvider>
      <Pages />
    </SessionProvider>
  );
}

function Pages() {
  const { state, retry } = useSession();
  const { pathname, search } = useLocation();
  const route = routes[pathname];

  if (state.kind === "loading") {
    return (
      <Layout title="Loading" user={null}>
        <p role="status" className="health" data-tone="pending">
          Checking whether you're signed in…
        </p>
      </Layout>
    );
  }
  if (state.kind === "error") {
    return (
      <Layout title="Can't reach the API" user={null}>
        <div role="alert" className="health" data-tone="bad">
          <p>
            Can't reach the API: {state.reason}. Check the api container is
            running (docker compose ps), then try again.
          </p>
        </div>
        <button type="button" onClick={retry}>
          Try again
        </button>
      </Layout>
    );
  }

  const user = state.kind === "signedIn" ? state.user : null;
  if (route?.access === "signedOut" && user) {
    return <Redirect to={returnPath(search)} />;
  }
  if (route?.access === "signedIn" && !user) {
    return (
      <Redirect
        to={
          state.kind === "signedOut" && state.how === "signedOut"
            ? "/sign-in"
            : signInPath(pathname + search)
        }
      />
    );
  }

  return (
    <Layout title={route?.title ?? "Page not found"} user={user}>
      {pathname === "/" && (
        <>
          <ImportPreview />
          <HealthStatus />
        </>
      )}
      {pathname === "/profile" && user && (
        <ProfilePage key={user.id} user={user} />
      )}
      {pathname === "/sign-in" && (
        <SignIn
          expired={state.kind === "signedOut" && state.how === "expired"}
        />
      )}
      {pathname === "/register" && <Register />}
      {!route && (
        <section aria-labelledby="not-found-heading">
          <h2 id="not-found-heading">Page not found</h2>
          <p>
            There is no page at this address.{" "}
            <Link to="/">Go to the import page</Link>
          </p>
        </section>
      )}
    </Layout>
  );
}

// Module-level, not a ref: Layout remounts across a redirect.
let firstPage = true;

function Layout({
  title,
  user,
  children,
}: {
  title: string;
  user: Profile | null;
  children: ReactNode;
}) {
  const main = useRef<HTMLElement>(null);

  useEffect(() => {
    document.title = `${title} · Foodie`;
    // Moving focus to the new page tells a screen reader it changed; the
    // first page is left alone, as a full page load would be.
    if (firstPage) firstPage = false;
    else main.current?.focus();
  }, [title]);

  return (
    <>
      <header className="site-header">
        <h1>Foodie</h1>
        {user && <SignedInNav user={user} />}
      </header>
      <main ref={main} tabIndex={-1}>
        {children}
      </main>
    </>
  );
}

function SignedInNav({ user }: { user: Profile }) {
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <nav aria-label="Account">
      <ul>
        <li>
          <Link to="/">Import</Link>
        </li>
        <li>
          <Link to="/profile">Profile</Link>
        </li>
        <li>
          <span className="signed-in-as">
            Signed in as {user.displayName ?? user.email}
          </span>
        </li>
        <li>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              signOut().then(session.signedOut, (err: unknown) => {
                console.error("sign-out failed", err);
                setBusy(false);
                setError(
                  err instanceof Error ? err.message : "an unexpected error",
                );
              });
            }}
          >
            Sign out
          </button>
        </li>
      </ul>
      {error && (
        <p role="alert" className="health" data-tone="bad">
          Couldn't sign you out: {error}. Try again.
        </p>
      )}
    </nav>
  );
}
