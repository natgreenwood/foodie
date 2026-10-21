import { useEffect, useRef, useState, type ReactNode } from "react";
import { adminPages, AdminBreadcrumb, AdminIndex, NoPermission } from "./Admin";
import { signOut, type Profile } from "./auth";
import { HealthStatus } from "./HealthStatus";
import { ImportPreview } from "./ImportPreview";
import { ProfilePage } from "./ProfilePage";
import { RecipePage, recipeIdFrom } from "./RecipePage";
import { Register } from "./Register";
import { Link, Redirect, useLocation } from "./router";
import { SessionProvider, useSession } from "./session";
import { SignIn } from "./SignIn";

// "signedIn" pages send a visitor to sign-in; "signedOut" pages send a
// signed-in user on to where they were going. "admin" pages send a visitor
// to sign-in too, and show a signed-in non-admin that they have no
// permission, at the same address.
const routes: Record<
  string,
  { title: string; access: "signedIn" | "signedOut" | "admin" }
> = {
  "/": { title: "Import", access: "signedIn" },
  "/profile": { title: "Profile", access: "signedIn" },
  "/sign-in": { title: "Sign in", access: "signedOut" },
  "/register": { title: "Register", access: "signedOut" },
  "/admin": { title: "Admin", access: "admin" },
  ...Object.fromEntries(
    adminPages.map(({ path, title }) => [path, { title, access: "admin" }]),
  ),
};

// Every /recipes/:id page.
const recipeRoute = { title: "Recipe", access: "signedIn" } as const;

function routeFor(pathname: string) {
  return (
    routes[pathname] ??
    (recipeIdFrom(pathname) !== null ? recipeRoute : undefined)
  );
}

// Where sign-in returns to: ?next when it resolves to a page on this site,
// so the link cannot send anyone elsewhere, and home otherwise. The parsed
// URL is returned rather than the raw string, because the browser drops
// tabs and newlines when it parses, so "/\t/evil.example" is really
// "//evil.example".
export function returnPath(search: string): string {
  const next = new URLSearchParams(search).get("next");
  if (!next) return "/";
  let url: URL;
  try {
    url = new URL(next, window.location.origin);
  } catch {
    return "/";
  }
  if (url.origin !== window.location.origin) return "/";
  if (routes[url.pathname]?.access === "signedOut") return "/";
  return url.pathname + url.search + url.hash;
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
  const route = routeFor(pathname);
  const recipeId = recipeIdFrom(pathname);

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
  if ((route?.access === "signedIn" || route?.access === "admin") && !user) {
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

  if (route?.access === "admin" && !user?.isAdmin) {
    return (
      <Layout title="No permission" user={user}>
        <NoPermission />
      </Layout>
    );
  }
  const adminPage = adminPages.find((page) => page.path === pathname);

  return (
    <Layout title={route?.title ?? "Page not found"} user={user}>
      {pathname === "/" && user && (
        <>
          <ImportPreview locale={user.locale} />
          <HealthStatus />
        </>
      )}
      {recipeId !== null && user && (
        <RecipePage key={recipeId} id={recipeId} locale={user.locale} />
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
      {pathname === "/admin" && <AdminIndex />}
      {adminPage && (
        <>
          <AdminBreadcrumb title={adminPage.title} />
          <adminPage.Page />
        </>
      )}
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
  const { pathname } = useLocation();
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
        {user.isAdmin && (
          <li>
            <Link
              to="/admin"
              aria-current={
                pathname === "/admin" || pathname.startsWith("/admin/")
                  ? "page"
                  : undefined
              }
            >
              Admin
            </Link>
          </li>
        )}
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
