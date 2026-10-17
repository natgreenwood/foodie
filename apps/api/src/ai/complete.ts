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
// - invalid_credential: the stored credential cannot be used, such as an
//   Ollama base URL whose user or password does not decode.
export type NotConfiguredReason =
  "no_selection" | "no_credential" | "invalid_credential";

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
    // Never the credential itself.
    super(
      reason === "no_selection"
        ? `no AI provider selected for ${procedure}`
        : reason === "no_credential"
          ? `AI provider ${provider} selected for ${procedure} has no credential`
          : `AI provider ${provider} selected for ${procedure} has an unusable credential`,
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
// password) or the prompt: everything taken from the provider's answer is
// scrubbed of them first, since a provider may echo them back.
export class AiProviderError extends Error {
  override name = "AiProviderError";
  constructor(
    readonly provider: AiProvider,
    readonly model: string,
    readonly reason: ProviderFailureReason,
    // The provider's HTTP status; null if there was no response.
    readonly status: number | null,
    // The provider's error.message, scrubbed, or what was wrong with its
    // answer. Never its raw body.
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
  if (call === null) {
    throw new AiNotConfiguredError("invalid_credential", procedure, provider);
  }
  const secrets = [credential, ...call.secrets, request.system, request.user];
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
      // Scrubbed before cutting, so no secret survives cut in half.
      scrub(message, secrets).slice(0, MAX_PROVIDER_MESSAGE),
      options,
    );

  // A failure with no answer: a timeout, or the connection failing. `status`
  // is the response's when its headers had arrived before the body failed.
  const noAnswer = (err: unknown, status: number | null) =>
    err instanceof Error && err.name === "TimeoutError"
      ? fail(
          "timeout",
          status,
          `no response within ${deps.timeoutMs ?? COMPLETION_TIMEOUT_MS} ms`,
          { cause: err },
        )
      : // fetch's own message is only "fetch failed"; the reason is in cause.
        fail("unreachable", status, networkReason(err), { cause: err });

  let res: Response;
  try {
    res = await fetch(call.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...call.headers },
      body: JSON.stringify(call.body),
      // Covers the body too: it aborts the response stream being read.
      signal: AbortSignal.timeout(deps.timeoutMs ?? COMPLETION_TIMEOUT_MS),
    });
  } catch (err) {
    throw noAnswer(err, null);
  }
  const { status } = res;
  let body: string | null;
  try {
    const bytes = await readCapped(res.body, MAX_RESPONSE_BYTES);
    body = bytes === null ? null : bytes.toString("utf8");
  } catch (err) {
    throw noAnswer(err, status);
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
  // Forms of the credential, beyond the stored value, that must never reach
  // an error: for Ollama the URL with and without its user and password.
  secrets: string[];
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
): ProviderRequest | null {
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
      secrets: [],
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
      secrets: [],
    };
  }
  if (provider === "openrouter") {
    return {
      url: OPENROUTER_URL,
      headers: { authorization: `Bearer ${credential}` },
      body: { model, messages, max_tokens: maxTokens },
      secrets: [],
    };
  }
  const endpoint = ollamaEndpoint(credential);
  if (endpoint === null) return null;
  return { ...endpoint, body: { model, messages, max_tokens: maxTokens } };
}

// Ollama's credential is its server's base URL, as the admin saved it (e.g.
// http://ollama:11434, or behind a proxy at a path). One trailing /v1 is
// dropped, since Ollama's own docs show the base URL with it. The stored
// value stays as the admin typed it. fetch refuses a URL with a user and
// password in it, so those become a Basic header instead. Null when the URL
// does not parse or its user or password does not decode (e.g. "%ZZ"),
// which the admin route's check lets through.
function ollamaEndpoint(baseUrl: string): Omit<ProviderRequest, "body"> | null {
  let base: URL;
  let user: string;
  let password: string;
  try {
    base = new URL(baseUrl);
    user = decodeURIComponent(base.username);
    password = decodeURIComponent(base.password);
  } catch {
    return null;
  }
  const headers: Record<string, string> = {};
  const secrets = [base.href];
  if (user !== "" || password !== "") {
    const basic = Buffer.from(`${user}:${password}`).toString("base64");
    headers.authorization = `Basic ${basic}`;
    secrets.push(basic, base.password, password);
    base.username = "";
    base.password = "";
    secrets.push(base.href);
  }
  base.pathname = `${base.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")}/`;
  const url = new URL("v1/chat/completions", base).toString();
  secrets.push(url);
  // An echo may drop the trailing slash URL adds to a bare host.
  return {
    url,
    headers,
    secrets: secrets.flatMap((secret) => [secret, secret.replace(/\/+$/, "")]),
  };
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

// The message in an error body, { error: { message } } from Anthropic and
// the OpenAI-compatible APIs; null for any other body, which is never
// quoted.
function errorMessage(json: unknown): string | null {
  if (!isRecord(json) || !isRecord(json.error)) return null;
  const { message } = json.error;
  return typeof message === "string" ? message : null;
}

// Shorter values are left alone: redacting a two-letter password everywhere
// would wreck the message and hide little.
const MIN_SCRUBBED_LENGTH = 4;

// `text` with every occurrence of each secret replaced, longest first so a
// URL goes whole rather than leaving its host around a redacted password.
// Only exact copies are caught: a provider quoting part of a prompt is not.
function scrub(text: string, secrets: readonly string[]): string {
  return [...new Set(secrets)]
    .filter((secret) => secret.length >= MIN_SCRUBBED_LENGTH)
    .sort((a, b) => b.length - a.length)
    .reduce((out, secret) => out.replaceAll(secret, "[redacted]"), text);
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
