import {
  useEffect,
  useState,
  useSyncExternalStore,
  type AnchorHTMLAttributes,
  type MouseEvent,
} from "react";

// A route switch over the History API: four pages do not need a router
// library. nginx and the Vite dev server both answer any path with
// index.html, so a deep link or a reload lands back here.

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

function snapshot() {
  return window.location.pathname + window.location.search;
}

// `state` travels with the history entry, for a page to read on arrival
// (useArrivalState) and only then: a reload or a shared link does not
// carry it.
export function navigate(
  to: string,
  {
    replace = false,
    state = null,
  }: { replace?: boolean; state?: unknown } = {},
) {
  if (replace) window.history.replaceState(state, "", to);
  else window.history.pushState(state, "", to);
  for (const listener of listeners) listener();
}

// The state the current history entry arrived with. It is then cleared
// from the entry, so a reload of the page does not see it again; this
// component keeps what it read.
export function useArrivalState(): unknown {
  const [state] = useState(() => window.history.state as unknown);
  useEffect(() => {
    if (window.history.state !== null) {
      window.history.replaceState(null, "", window.location.href);
    }
  }, []);
  return state;
}

// A full page load, for addresses outside this app: the api's OIDC start
// route, which redirects on to the provider.
export function leaveFor(url: string) {
  window.location.assign(url);
}

export function useLocation(): { pathname: string; search: string } {
  const href = useSyncExternalStore(subscribe, snapshot);
  const url = new URL(href, window.location.origin);
  return { pathname: url.pathname, search: url.search };
}

export function Redirect({ to }: { to: string }) {
  useEffect(() => navigate(to, { replace: true }), [to]);
  return null;
}

// A real <a>, so it can still be opened in a new tab; a plain click
// navigates in place.
export function Link({
  to,
  ...rest
}: { to: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    navigate(to);
  }
  return <a href={to} onClick={onClick} {...rest} />;
}
