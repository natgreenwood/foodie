import { useState } from "react";
import { AuthError, updateProfile, type Profile } from "./auth";
import { AuthErrorMessage } from "./AuthErrorMessage";
import { ConnectedIdentities } from "./ConnectedIdentities";
import { DISPLAY_NAME_MAX_LENGTH } from "./Register";
import { useSession } from "./session";

// The locales the measurement seed has names for
// (apps/api/drizzle/0001_seed_measurement_units.sql).
const locales: Record<string, string> = {
  "en-GB": "English (UK)",
  "en-US": "English (US)",
};

type State =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; error: unknown };

export function ProfilePage({ user }: { user: Profile }) {
  const session = useSession();
  const [displayName, setDisplayName] = useState(user.displayName ?? "");
  const [locale, setLocale] = useState(user.locale);
  const [state, setState] = useState<State>({ kind: "idle" });
  const saving = state.kind === "saving";

  // Set some other way (the api accepts any BCP-47 tag), so keep it offered.
  const options =
    locale in locales ? locales : { ...locales, [locale]: locale };

  return (
    <section aria-labelledby="profile-heading">
      <h2 id="profile-heading">Profile</h2>
      <dl className="facts">
        <dt>Email</dt>
        <dd>{user.email}</dd>
      </dl>
      <form
        className="account-form"
        onSubmit={(event) => {
          event.preventDefault();
          setState({ kind: "saving" });
          updateProfile({
            displayName: displayName.trim() || null,
            locale,
          }).then(
            (updated) => {
              session.signedIn(updated);
              setDisplayName(updated.displayName ?? "");
              setLocale(updated.locale);
              setState({ kind: "saved" });
            },
            (err: unknown) => {
              // A 401 has already sent the user to sign-in.
              if (err instanceof AuthError && err.code === "unauthenticated") {
                return;
              }
              console.error("saving the profile failed", err);
              setState({ kind: "error", error: err });
            },
          );
        }}
      >
        <label htmlFor="profile-name">Display name</label>
        <input
          id="profile-name"
          type="text"
          autoComplete="nickname"
          maxLength={DISPLAY_NAME_MAX_LENGTH}
          aria-describedby="profile-name-hint"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
        <p id="profile-name-hint" className="hint">
          Leave empty to be shown by your email.
        </p>
        <label htmlFor="profile-locale">Preferred locale</label>
        <select
          id="profile-locale"
          aria-describedby="profile-locale-hint"
          value={locale}
          onChange={(event) => setLocale(event.target.value)}
        >
          {Object.entries(options).map(([tag, label]) => (
            <option key={tag} value={tag}>
              {label}
            </option>
          ))}
        </select>
        <p id="profile-locale-hint" className="hint">
          Decides the spelling of measurement names, such as litre or liter.
        </p>
        <button type="submit" disabled={saving}>
          Save
        </button>
      </form>

      {saving && (
        <p role="status" className="health" data-tone="pending">
          Saving…
        </p>
      )}
      {state.kind === "saved" && (
        <p role="status" className="health" data-tone="good">
          Profile saved.
        </p>
      )}
      {state.kind === "error" && <AuthErrorMessage error={state.error} />}

      <ConnectedIdentities email={user.email} />
    </section>
  );
}
