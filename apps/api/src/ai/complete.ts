import type { Db } from "../auth/accounts.js";
import { readCapped } from "../import/fetch/strategy.js";
import {
  listModelSelections,
  providerCredential,
  type AiProcedure,
  type AiProvider,
} from "./settings.js";

// One completion from the provider and model an admin chose (NATG-320), so
// callers such as recipe import never talk to a provider themselves. Plain
// fetch, no SDK: Anthropic is its Messages API, and OpenAI, OpenRouter and
// Ollama are the OpenAI-compatible chat completions endpoint.

// Per request, so a slow or stuck provider cannot hold a caller open
// indefinitely. Longer than FETCH_TIMEOUT_MS: a model writes its whole answer
// before replying.
export const COMPLETION_TIMEOUT_MS = 120_000;

// Far beyond any answer a sane maxTokens allows; a body past it is not one.
export const MAX_RESPONSE_BYTES = 1024 * 1024;

// The provider's error message is cut to this in our own message, so one
// verbose error cannot flood the log line.
const MAX_PROVIDER_MESSAGE = 500;

export interface CompletionRequest {
  system: string;
  user: string;
  maxTokens: number;
}

export interface Completion {
  text: string;
  provider: AiProvider;
  model: string;
}

export interface CompleteDeps {
  // The api's database or a transaction on it.
  db: Db;
  settingsKey: Buffer;
  // Defaults to COMPLETION_TIMEOUT_MS; tests pass a small one.
  timeoutMs?: number;
}

// - no_selection: no provider and model chosen for the procedure or for
//   `default`.
// - no_credential: the chosen provider has no API key (or, for Ollama, no
//   base URL) stored.
export type NotConfiguredReason = "no_selection" | "no_credential";

// The admin has not finished setting AI up. Callers map it to a "configure
// a provider" response rather than a failure.
export class AiNotConfiguredError extends Error {
  override name = "AiNotConfiguredError";
  constructor(
    readonly reason: NotConfiguredReason,
    readonly procedure: string,
    // The chosen provider; null for no_selection.
    readonly provider: AiProvider | null,
  ) {
    super(
      reason === "no_selection"
        ? `no AI provider selected for ${procedure}`
        : `AI provider ${provider} selected for ${procedure} has no credential`,
    );
  }
}

// - unreachable: the request failed without a response (refused, DNS).
// - timeout: no full response within the timeout.
// - http_error: a non-2xx status.
// - bad_response: a 2xx whose body is not the expected JSON, or too large.
export type ProviderFailureReason =
  "unreachable" | "timeout" | "http_error" | "bad_response";

// Never carries the credential, the Ollama base URL (which may hold a
// password) or the prompt.
export class AiProviderError extends Error {
  override name = "AiProviderError";
  constructor(
    readonly provider: AiProvider,
    readonly model: string,
    readonly reason: ProviderFailureReason,
    // The provider's HTTP status; null if there was no response.
    readonly status: number | null,
    // The provider's own error message, or what was wrong with its answer.
    readonly providerMessage: string,
    options?: ErrorOptions,
  ) {
    super(
      `${provider} ${model}: ${reason}, status ${status ?? "none"}: ${providerMessage}`,
      options,
    );
  }
}

// The text the model answers `request` with, from the provider and model the
// admin chose for `procedure`, or for `default` when the procedure has none.
// Rejects with AiNotConfiguredError or AiProviderError. Database and
// decryption errors are not caught. Not retried: a caller that retries pays
// for another completion, nothing worse.
export async function complete(
  deps: CompleteDeps,
  request: CompletionRequest,
  procedure: AiProcedure = "default",
): Promise<Completion> {
  const selections = await listModelSelections(deps.db);
  const selection =
    selections.find((s) => s.procedure === procedure) ??
    selections.find((s) => s.procedure === "default");
  if (!selection) {
    throw new AiNotConfiguredError("no_selection", procedure, null);
  }
  const { provider, model } = selection;
  const credential = await providerCredential(
    deps.db,
    deps.settingsKey,
    provider,
  );
  if (credential === null) {
    throw new AiNotConfiguredError("no_credential", procedure, provider);
  }

  const call = buildRequest(provider, model, credential, request);
  const fail = (
    reason: ProviderFailureReason,
    status: number | null,
    message: string,
    options?: ErrorOptions,
  ) =>
    new AiProviderError(
      provider,
      model,
      reason,
      status,
      message.slice(0, MAX_PROVIDER_MESSAGE),
      options,
    );

  let status: number;
  let body: string | null;
  try {
    const res = await fetch(call.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...call.headers },
      body: JSON.stringify(call.body),
      // Covers the body too: it aborts the response stream being read.
      signal: AbortSignal.timeout(deps.timeoutMs ?? COMPLETION_TIMEOUT_MS),
    });
    status = res.status;
    const bytes = await readCapped(res.body, MAX_RESPONSE_BYTES);
    body = bytes === null ? null : bytes.toString("utf8");
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw fail(
        "timeout",
        null,
        `no response within ${deps.timeoutMs ?? COMPLETION_TIMEOUT_MS} ms`,
        { cause: err },
      );
    }
    // fetch's own message is only "fetch failed"; the reason is in cause.
    throw fail("unreachable", null, networkReason(err), { cause: err });
  }

  const json = body === null ? null : parseJson(body);
  if (status < 200 || status >= 300) {
    throw fail("http_error", status, errorMessage(json) ?? `HTTP ${status}`);
  }
  if (body === null) {
    throw fail("bad_response", status, `over ${MAX_RESPONSE_BYTES} bytes`);
  }
  const text = provider === "anthropic" ? anthropicText(json) : chatText(json);
  if (text === null) {
    throw fail("bad_response", status, "no text in the response");
  }
  return { text, provider, model };
}

interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function buildRequest(
  provider: AiProvider,
  model: string,
  credential: string,
  { system, user, maxTokens }: CompletionRequest,
): ProviderRequest {
  if (provider === "anthropic") {
    return {
      url: ANTHROPIC_URL,
      headers: {
        "x-api-key": credential,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: {
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
      },
    };
  }
  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  if (provider === "openai") {
    return {
      url: OPENAI_URL,
      headers: { authorization: `Bearer ${credential}` },
      // Not max_tokens: OpenAI's reasoning models refuse it with a 400, and
      // every OpenAI model takes max_completion_tokens. Do not change it back.
      body: { model, messages, max_completion_tokens: maxTokens },
    };
  }
  if (provider === "openrouter") {
    return {
      url: OPENROUTER_URL,
      headers: { authorization: `Bearer ${credential}` },
      body: { model, messages, max_tokens: maxTokens },
    };
  }
  return {
    ...ollamaEndpoint(credential),
    body: { model, messages, max_tokens: maxTokens },
  };
}

// Ollama's credential is its server's base URL, as the admin saved it (e.g.
// http://ollama:11434, or behind a proxy at a path). One trailing /v1 is
// dropped, since Ollama's own docs show the base URL with it. The stored
// value stays as the admin typed it. fetch refuses a URL with a user and
// password in it, so those become a Basic header instead.
function ollamaEndpoint(baseUrl: string): Omit<ProviderRequest, "body"> {
  const base = new URL(baseUrl);
  const headers: Record<string, string> = {};
  if (base.username !== "" || base.password !== "") {
    const userinfo = `${decodeURIComponent(base.username)}:${decodeURIComponent(base.password)}`;
    headers.authorization = `Basic ${Buffer.from(userinfo).toString("base64")}`;
    base.username = "";
    base.password = "";
  }
  base.pathname = `${base.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")}/`;
  return { url: new URL("v1/chat/completions", base).toString(), headers };
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// The message in an error body: { error: { message } } from Anthropic and
// the OpenAI-compatible APIs, or { error: "..." } from older Ollama.
function errorMessage(json: unknown): string | null {
  if (!isRecord(json)) return null;
  const { error } = json;
  if (typeof error === "string") return error;
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  return null;
}

// Messages API: content is a list of blocks; the answer is its text blocks.
function anthropicText(json: unknown): string | null {
  if (!isRecord(json) || !Array.isArray(json.content)) return null;
  const texts = json.content
    .filter(
      (block): block is { type: "text"; text: string } =>
        isRecord(block) &&
        block.type === "text" &&
        typeof block.text === "string",
    )
    .map((block) => block.text);
  return texts.length > 0 ? texts.join("") : null;
}

// Chat completions: the first choice's message content.
function chatText(json: unknown): string | null {
  if (!isRecord(json) || !Array.isArray(json.choices)) return null;
  const [choice] = json.choices as unknown[];
  if (!isRecord(choice) || !isRecord(choice.message)) return null;
  const { content } = choice.message;
  return typeof content === "string" ? content : null;
}

// The innermost cause's message: "connect ECONNREFUSED 10.0.0.5:11434"
// rather than "fetch failed". Undici puts only the address in it, never the
// URL's user or password.
function networkReason(err: unknown): string {
  let current: unknown = err;
  while (current instanceof Error && current.cause instanceof Error) {
    current = current.cause;
  }
  return current instanceof Error && current.message !== ""
    ? current.message
    : String(err);
}
