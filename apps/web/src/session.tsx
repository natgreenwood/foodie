import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { AuthError, fetchMe, sessionEvents, type Profile } from "./auth";

// `how` says why there is no user, which decides where sign-in sends them:
// a visitor or an ended session goes back to the page they were on, someone
// who chose to sign out does not.
export type SessionState =
  | { kind: "loading" }
  | { kind: "error"; reason: string }
  | { kind: "signedOut"; how: "visitor" | "expired" | "signedOut" }
  | { kind: "signedIn"; user: Profile };

interface Session {
  state: SessionState;
  retry: () => void;
  signedIn: (user: Profile) => void;
  signedOut: () => void;
}

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession needs a <SessionProvider>");
  return session;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetchMe(controller.signal).then(
      (user) =>
        setState(
          user
            ? { kind: "signedIn", user }
            : { kind: "signedOut", how: "visitor" },
        ),
      (err: unknown) => {
        if (controller.signal.aborted) return;
        console.error("loading the session failed", err);
        setState({
          kind: "error",
          reason:
            err instanceof AuthError ? err.message : "an unexpected error",
        });
      },
    );
    return () => controller.abort();
  }, [attempt]);

  useEffect(() => {
    const expire = () => setState({ kind: "signedOut", how: "expired" });
    sessionEvents.addEventListener("unauthenticated", expire);
    return () => sessionEvents.removeEventListener("unauthenticated", expire);
  }, []);

  const session: Session = {
    state,
    retry: () => {
      setState({ kind: "loading" });
      setAttempt((n) => n + 1);
    },
    signedIn: (user) => setState({ kind: "signedIn", user }),
    signedOut: () => setState({ kind: "signedOut", how: "signedOut" }),
  };

  return (
    <SessionContext.Provider value={session}>
      {children}
    </SessionContext.Provider>
  );
}
