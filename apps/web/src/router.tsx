import {
  useEffect,
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

export function navigate(to: string, { replace = false } = {}) {
  if (replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  for (const listener of listeners) listener();
}

// A full page load, for addresses outside this app: the api's OIDC routes
// and the provider they send the browser to.
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
