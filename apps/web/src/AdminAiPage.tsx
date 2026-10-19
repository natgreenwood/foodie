import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  AI_PROVIDERS,
  clearProviderCredential,
  fetchAdminAi,
  setDefaultModel,
  setProviderCredential,
  type AdminAiSettings,
  type AiProvider,
  type AiReasoningLevel,
  type DefaultModel,
} from "./adminAi";
import { AuthError } from "./auth";
import configuredIcon from "./icons/configured.svg";
import notSetIcon from "./icons/not-set.svg";

const providerNames: Record<AiProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  ollama: "Ollama",
};

const providerDescriptions: Record<AiProvider, string> = {
  anthropic: "API key, from the Anthropic console.",
  openai: "API key, from the OpenAI platform dashboard.",
  openrouter: "API key, from your OpenRouter account.",
  ollama:
    "Server URL the api container uses to reach Ollama. Treated like a key: not shown once saved.",
};

// V1 takes the model id as typed, in the provider's own form.
const modelHints: Record<AiProvider, string> = {
  anthropic: "Exactly as Anthropic names it, for example claude-haiku-4-5.",
  openai: "Exactly as OpenAI names it, for example gpt-5-mini.",
  openrouter:
    "OpenRouter's vendor/model form, for example anthropic/claude-haiku-4.5.",
  ollama: "Exactly as your Ollama server lists it, for example llama3.2.",
};

const levelLabels: Record<AiReasoningLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

// Ollama takes a server URL where the others take an API key.
function credentialNoun(provider: AiProvider): string {
  return provider === "ollama" ? "server URL" : "API key";
}

function credentialName(provider: AiProvider): string {
  return `${providerNames[provider]} ${credentialNoun(provider)}`;
}

// Why a request failed, to go mid-sentence. Null for a 401 or a 403, which
// have already sent the user to sign-in or the no-permission page.
function failureReason(err: unknown): string | null {
  if (!(err instanceof AuthError)) return "an unexpected error";
  if (err.code === "unauthenticated" || err.code === "forbidden") return null;
  return err.message;
}

type Load =
  | { kind: "loading" }
  | { kind: "error"; reason: string | null }
  | { kind: "loaded"; settings: AdminAiSettings };

export function AdminAiPage() {
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    fetchAdminAi(controller.signal).then(
      (settings) => setLoad({ kind: "loaded", settings }),
      (err: unknown) => {
        if (controller.signal.aborted) return;
        console.error("loading the AI settings failed", err);
        setLoad({ kind: "error", reason: failureReason(err) });
      },
    );
    return () => controller.abort();
  }, [attempt]);

  // From the settings as they are when the change lands, not as they were
  // when its request started: saves in other rows may have landed since.
  function update(change: (settings: AdminAiSettings) => AdminAiSettings) {
    setLoad((current) =>
      current.kind === "loaded"
        ? { kind: "loaded", settings: change(current.settings) }
        : current,
    );
  }

  return (
    <section className="ai-settings" aria-labelledby="ai-settings-heading">
      <h2 id="ai-settings-heading">AI settings</h2>

      {load.kind === "loading" && (
        <p role="status" className="health" data-tone="pending">
          Loading AI settings…
        </p>
      )}
      {load.kind === "error" && load.reason && (
        <>
          <div role="alert" className="health" data-tone="bad">
            <p>Couldn't load AI settings: {load.reason}. Try again.</p>
          </div>
          <button
            type="button"
            onClick={() => {
              setLoad({ kind: "loading" });
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </button>
        </>
      )}

      {load.kind === "loaded" && (
        <>
          <section aria-labelledby="ai-credentials-heading">
            <h3 id="ai-credentials-heading">Provider credentials</h3>
            <p className="hint">
              Each provider needs its own key. A saved key is stored encrypted
              and never shown again.
            </p>
            <ul
              className="identity-list"
              aria-labelledby="ai-credentials-heading"
            >
              {AI_PROVIDERS.map((provider) => (
                <ProviderRow
                  key={provider}
                  provider={provider}
                  configured={load.settings.configured[provider]}
                  isDefault={load.settings.defaultModel.provider === provider}
                  onChange={(configured) =>
                    update((settings) => ({
                      ...settings,
                      configured: {
                        ...settings.configured,
                        [provider]: configured,
                      },
                    }))
                  }
                />
              ))}
            </ul>
          </section>
          <DefaultModelForm
            saved={load.settings.defaultModel}
            configured={load.settings.configured}
            onSaved={(defaultModel) =>
              update((settings) => ({ ...settings, defaultModel }))
            }
          />
        </>
      )}
    </section>
  );
}

// The word carries the meaning; the icon only repeats it.
function CredentialStatus({ configured }: { configured: boolean }) {
  return (
    <span className="credential-status" data-configured={configured}>
      <img
        src={configured ? configuredIcon : notSetIcon}
        alt=""
        width={16}
        height={16}
      />
      {configured ? "Configured" : "Not set"}
    </span>
  );
}

type RowAction =
  | { kind: "idle"; returnTo?: "open" | "clear" }
  | { kind: "editing"; reason?: string | null }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "confirming" }
  | { kind: "clearing" }
  | { kind: "cleared" }
  | { kind: "clearFailed"; reason: string | null };

// One provider's credential: Set when there is none, Replace and Clear when
// there is. The value typed is sent once and never shown again.
function ProviderRow({
  provider,
  configured,
  isDefault,
  onChange,
}: {
  provider: AiProvider;
  configured: boolean;
  isDefault: boolean;
  onChange: (configured: boolean) => void;
}) {
  const name = providerNames[provider];
  const credential = credentialName(provider);
  const noun = credentialNoun(provider);
  const isUrl = provider === "ollama";

  const [action, setAction] = useState<RowAction>({ kind: "idle" });
  const [value, setValue] = useState("");

  const openButton = useRef<HTMLButtonElement>(null);
  const clearButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const nameId = `ai-${provider}-name`;
  const inputId = `ai-${provider}-input`;
  const hintId = `ai-${provider}-hint`;
  const confirmId = `ai-${provider}-confirm`;

  useEffect(() => {
    if (action.kind === "editing") input.current?.focus();
    if (action.kind === "confirming") confirmButton.current?.focus();
    if (action.kind === "saved" || action.kind === "cleared") {
      openButton.current?.focus();
    }
    if (action.kind === "clearFailed") clearButton.current?.focus();
    if (action.kind === "idle" && action.returnTo === "open") {
      openButton.current?.focus();
    }
    if (action.kind === "idle" && action.returnTo === "clear") {
      clearButton.current?.focus();
    }
  }, [action]);

  const formOpen = action.kind === "editing" || action.kind === "saving";
  const saving = action.kind === "saving";
  const clearing = action.kind === "clearing";

  function cancel() {
    setValue("");
    setAction({ kind: "idle", returnTo: "open" });
  }

  function save(event: FormEvent) {
    event.preventDefault();
    setAction({ kind: "saving" });
    setProviderCredential(provider, value).then(
      () => {
        setValue("");
        onChange(true);
        setAction({ kind: "saved" });
      },
      (err: unknown) => {
        console.error(`saving the ${provider} credential failed`, err);
        setAction({ kind: "editing", reason: failureReason(err) });
      },
    );
  }

  function clear() {
    setAction({ kind: "clearing" });
    clearProviderCredential(provider).then(
      () => {
        onChange(false);
        setAction({ kind: "cleared" });
      },
      (err: unknown) => {
        console.error(`clearing the ${provider} credential failed`, err);
        setAction({ kind: "clearFailed", reason: failureReason(err) });
      },
    );
  }

  return (
    <li id={`ai-${provider}`} className="identity">
      <p className="identity-name">
        <span id={nameId}>{name}</span>{" "}
        <CredentialStatus configured={configured} />
      </p>
      <p className="hint">{providerDescriptions[provider]}</p>

      {!formOpen && action.kind !== "confirming" && (
        <div className="actions">
          {configured ? (
            <>
              <button
                ref={openButton}
                type="button"
                aria-describedby={nameId}
                disabled={clearing}
                onClick={() => setAction({ kind: "editing" })}
              >
                Replace
              </button>
              <button
                ref={clearButton}
                type="button"
                aria-describedby={nameId}
                disabled={clearing}
                onClick={() => setAction({ kind: "confirming" })}
              >
                Clear
              </button>
            </>
          ) : (
            <button
              ref={openButton}
              id={`ai-${provider}-set`}
              type="button"
              aria-describedby={nameId}
              onClick={() => setAction({ kind: "editing" })}
            >
              Set
            </button>
          )}
        </div>
      )}

      {formOpen && (
        <form
          className="account-form"
          onSubmit={save}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !saving) cancel();
          }}
        >
          <label htmlFor={inputId}>
            {configured ? `New ${credential}` : credential}
          </label>
          <input
            ref={input}
            id={inputId}
            type={isUrl ? "url" : "password"}
            autoComplete="off"
            spellCheck={false}
            required
            aria-describedby={hintId}
            disabled={saving}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <p id={hintId} className="hint">
            {isUrl && "For example http://ollama:11434. "}
            {configured
              ? `The saved ${isUrl ? "URL" : "key"} stays in use until you save a new one.`
              : isUrl
                ? "Not shown again once saved."
                : "Stored encrypted. Once saved, it isn't shown again."}
          </p>
          <div className="actions">
            <button type="submit" disabled={saving}>
              Save
            </button>
            <button type="button" disabled={saving} onClick={cancel}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {action.kind === "confirming" && (
        <div
          role="group"
          aria-labelledby={confirmId}
          className="notice"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setAction({ kind: "idle", returnTo: "clear" });
            }
          }}
        >
          <p id={confirmId}>
            Clear the {credential}? Anything that uses {name} stops working
            until a new {noun} is set. This can't be undone.
            {isDefault &&
              ` ${name} is the default provider, so AI tasks will fail until a new ${noun} is set.`}
          </p>
          <div className="actions">
            <button ref={confirmButton} type="button" onClick={clear}>
              Clear {isUrl ? "URL" : "key"}
            </button>
            <button
              type="button"
              onClick={() => setAction({ kind: "idle", returnTo: "clear" })}
            >
              Keep {isUrl ? "URL" : "key"}
            </button>
          </div>
        </div>
      )}

      {saving && (
        <p role="status" className="health" data-tone="pending">
          Saving the {credential}…
        </p>
      )}
      {action.kind === "saved" && (
        <p role="status" className="health" data-tone="good">
          {credential} saved.
        </p>
      )}
      {action.kind === "editing" && action.reason && (
        <div role="alert" className="health" data-tone="bad">
          <p>
            Couldn't save the {credential}: {action.reason}. Nothing was
            changed. Try again.
          </p>
        </div>
      )}
      {clearing && (
        <p role="status" className="health" data-tone="pending">
          Clearing the {credential}…
        </p>
      )}
      {action.kind === "cleared" && (
        <p role="status" className="health" data-tone="good">
          {credential} cleared.
        </p>
      )}
      {action.kind === "clearFailed" && action.reason && (
        <div role="alert" className="health" data-tone="bad">
          <p>
            Couldn't clear the {credential}: {action.reason}. It's still saved.
            Try again.
          </p>
        </div>
      )}
    </li>
  );
}

type FormState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; reason: string | null };

// The app-wide default provider, model and reasoning level: one form, one
// request, one outcome.
function DefaultModelForm({
  saved,
  configured,
  onSaved,
}: {
  saved: DefaultModel;
  configured: Record<AiProvider, boolean>;
  onSaved: (saved: DefaultModel) => void;
}) {
  const [provider, setProvider] = useState<AiProvider | "">(
    saved.provider ?? "",
  );
  const [model, setModel] = useState(saved.model ?? "");
  const [level, setLevel] = useState<AiReasoningLevel | "">(
    saved.reasoningLevel ?? "",
  );
  const [state, setState] = useState<FormState>({ kind: "idle" });
  const saveButton = useRef<HTMLButtonElement>(null);
  const saving = state.kind === "saving";
  const notConfigured = provider !== "" && !configured[provider];

  // Disabled while saving, Save loses focus; it gets it back either way.
  useEffect(() => {
    if (state.kind === "saved" || state.kind === "error") {
      saveButton.current?.focus();
    }
  }, [state.kind]);

  // A change after a save makes "saved" no longer true of the form.
  function edited() {
    if (state.kind === "saved") setState({ kind: "idle" });
  }

  function save(event: FormEvent) {
    event.preventDefault();
    if (provider === "") return;
    setState({ kind: "saving" });
    setDefaultModel({
      provider,
      model: model.trim(),
      reasoningLevel: level === "" ? null : level,
    }).then(
      (stored) => {
        setProvider(stored.provider ?? "");
        setModel(stored.model ?? "");
        setLevel(stored.reasoningLevel ?? "");
        onSaved(stored);
        setState({ kind: "saved" });
      },
      (err: unknown) => {
        console.error("saving the default model failed", err);
        setState({ kind: "error", reason: failureReason(err) });
      },
    );
  }

  return (
    <section className="ai-default-model" aria-labelledby="ai-default-heading">
      <h3 id="ai-default-heading">Default model</h3>
      <p className="hint">
        Used for every AI task, such as reading recipes on import.
      </p>
      <form className="account-form" onSubmit={save}>
        <label htmlFor="ai-default-provider">Provider</label>
        <select
          id="ai-default-provider"
          required
          aria-describedby={
            notConfigured ? "ai-default-provider-notice" : undefined
          }
          disabled={saving}
          value={provider}
          onChange={(event) => {
            setProvider(event.target.value as AiProvider);
            edited();
          }}
        >
          {saved.provider === null && (
            <option value="" disabled>
              Choose a provider
            </option>
          )}
          {AI_PROVIDERS.map((id) => (
            <option key={id} value={id}>
              {providerNames[id]}
            </option>
          ))}
        </select>
        {notConfigured && (
          <div id="ai-default-provider-notice" className="notice">
            <p>
              {providerNames[provider]} isn't configured yet, so AI tasks will
              fail until its {credentialNoun(provider)} is set.
            </p>
            <p>
              <a
                href={`#ai-${provider}`}
                onClick={(event) => {
                  const target =
                    document.getElementById(`ai-${provider}-set`) ??
                    document.getElementById(`ai-${provider}-input`);
                  if (!target) return;
                  event.preventDefault();
                  target.focus();
                }}
              >
                Set the {credentialName(provider)}
              </a>
            </p>
          </div>
        )}

        <label htmlFor="ai-default-model">Model id</label>
        <input
          id="ai-default-model"
          type="text"
          autoComplete="off"
          spellCheck={false}
          required
          placeholder={provider === "" ? "Choose a provider first" : undefined}
          aria-describedby="ai-default-model-hint"
          disabled={saving}
          value={model}
          onChange={(event) => {
            setModel(event.target.value);
            edited();
          }}
        />
        <p id="ai-default-model-hint" className="hint">
          {provider === ""
            ? "The provider's own id for the model."
            : modelHints[provider]}
        </p>

        <label htmlFor="ai-default-level">Reasoning level</label>
        <select
          id="ai-default-level"
          aria-describedby="ai-default-level-hint"
          disabled={saving}
          value={level}
          onChange={(event) => {
            setLevel(event.target.value as AiReasoningLevel | "");
            edited();
          }}
        >
          <option value="">Not set</option>
          {Object.entries(levelLabels).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
        <p id="ai-default-level-hint" className="hint">
          Used only where the chosen model supports it. Other models ignore it.
        </p>

        <button ref={saveButton} type="submit" disabled={saving}>
          Save
        </button>
      </form>

      {saving && (
        <p role="status" className="health" data-tone="pending">
          Saving the default model…
        </p>
      )}
      {state.kind === "saved" && (
        <p role="status" className="health" data-tone="good">
          Default model saved.
        </p>
      )}
      {state.kind === "error" && state.reason && (
        <div role="alert" className="health" data-tone="bad">
          <p>
            Couldn't save the default model: {state.reason}. Nothing was
            changed. Try again.
          </p>
        </div>
      )}
    </section>
  );
}
