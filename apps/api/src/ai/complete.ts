import type { Db } from "../auth/accounts.js";
import { readCapped } from "../import/fetch/strategy.js";
import {
  listModelSelections,
  providerCredential,
  type AiProcedure,
  type AiProvider,
  type AiReasoningLevel,
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
// Still so with REASONING_TOKEN_ALLOWANCE, whose reasoning may come back in
// the body: as an Anthropic thinking block's summary and its signature (the
// full thinking, encrypted, in base64), or as OpenRouter's reasoning text and
// details. Estimated, not measured: about 15 bytes a token at worst, under
// 400 KB for 25,000 tokens, where this allows about 40 bytes a token.
export const MAX_RESPONSE_BYTES = 1024 * 1024;

// A network failure's message is cut to this in our own message, so one
// verbose error cannot flood the log line.
const MAX_PROVIDER_MESSAGE = 500;

// The only text ever taken from a provider's error body: a code from this
// set, as is. Free text is never quoted, since a provider may echo a
// credential or the prompt back in it, in part or in full, where no scrub can
// find it; and a pattern would still let a short password or a one-word
// fragment of the prompt through, so the set is finite.
export const PROVIDER_ERROR_CODES: ReadonlySet<string> = new Set([
  // Anthropic error.type.
  "invalid_request_error",
  "authentication_error",
  "permission_error",
  "not_found_error",
  "request_too_large",
  "rate_limit_error",
  "api_error",
  "overloaded_error",
  // OpenAI-compatible error.code or error.type.
  "invalid_api_key",
  "insufficient_quota",
  "rate_limit_exceeded",
  "model_not_found",
  "context_length_exceeded",
  "server_error",
]);

// The name and code of a caught error, for `cause`. These come from Node,
// not the provider, so a pattern is enough: e.g. TypeError, ECONNREFUSED.
const NODE_ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

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
// - truncated: a 2xx whose answer stopped at the token limit (Anthropic
//   stop_reason "max_tokens" or "model_context_window_exceeded", chat
//   finish_reason "length"), whatever text it has. A cut-off answer is never returned: callers need all of it.
// - bad_response: any other 2xx that is not an answer: a body that is not
//   the expected JSON or is too large, no text or only whitespace, a refusal,
//   an answer the provider filtered, or an error the provider reports in the
//   body.
export type ProviderFailureReason =
  "unreachable" | "timeout" | "http_error" | "truncated" | "bad_response";

// Never carries the credential, the Ollama base URL (which may hold a
// password) or the prompt. Nothing from the provider's answer is quoted but
// its error code, and every message is also scrubbed of them.
export class AiProviderError extends Error {
  override name = "AiProviderError";
  constructor(
    readonly provider: AiProvider,
    readonly model: string,
    readonly reason: ProviderFailureReason,
    // The provider's HTTP status; null if there was no response.
    readonly status: number | null,
    // For http_error, and for a bad_response the provider reported as an
    // error in a 2xx body, the provider's error code (Anthropic's error.type;
    // the OpenAI-compatible error.code, else error.type) when it is in
    // PROVIDER_ERROR_CODES; otherwise null.
    readonly code: string | null,
    // For http_error, "HTTP <status>" and the code; otherwise what went
    // wrong, in our words, with the code when there is one. Never the
    // provider's own words: not a refusal, not an error message.
    readonly providerMessage: string,
    // `cause`, when there is one, is only { name, code } of the caught error.
    options?: ErrorOptions,
  ) {
    super(
      reason === "http_error"
        ? `${provider} ${model}: ${reason}, status ${status}${code === null ? "" : ` (${code})`}`
        : `${provider} ${model}: ${reason}, status ${status ?? "none"}: ${providerMessage}`,
      options,
    );
  }
}

// The text the model answers `request` with, whole and not blank, from the
// provider and model the admin chose for `procedure`, or for `default` when
// the procedure has none, at that selection's reasoning level where the
// provider and model take one.
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
  const { provider, model, reasoningLevel } = selection;
  const credential = await providerCredential(
    deps.db,
    deps.settingsKey,
    provider,
  );
  if (credential === null) {
    throw new AiNotConfiguredError("no_credential", procedure, provider);
  }

  const call = buildRequest(
    provider,
    model,
    credential,
    reasoningLevel,
    request,
  );
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
      null,
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
          { cause: causeOf(err) },
        )
      : // fetch's own message is only "fetch failed"; the reason is in cause.
        fail("unreachable", status, networkReason(err), {
          cause: causeOf(err),
        });

  let res: Response;
  try {
    res = await fetch(call.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...call.headers },
      body: JSON.stringify(call.body),
      // A redirect fails as unreachable rather than resending the
      // credential and the prompt to wherever it points.
      redirect: "error",
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
    const raw = errorCode(provider, json);
    // A code that happens to hold a secret is dropped, not redacted.
    const code = raw !== null && scrub(raw, secrets) === raw ? raw : null;
    throw new AiProviderError(
      provider,
      model,
      "http_error",
      status,
      code,
      scrub(`HTTP ${status}${code === null ? "" : ` (${code})`}`, secrets),
    );
  }
  if (body === null) {
    throw fail("bad_response", status, `over ${MAX_RESPONSE_BYTES} bytes`);
  }
  // Checked before the text: a truncated or refused answer may still have
  // some, and an empty one cut off at the token limit is a truncation.
  const unanswered =
    provider === "anthropic"
      ? anthropicUnanswered(json)
      : chatUnanswered(provider, json);
  if (unanswered !== null) {
    const { reason, message, code: raw } = unanswered;
    const code = raw !== null && scrub(raw, secrets) === raw ? raw : null;
    throw new AiProviderError(
      provider,
      model,
      reason,
      status,
      code,
      scrub(`${message}${code === null ? "" : ` (${code})`}`, secrets),
    );
  }
  const text = provider === "anthropic" ? anthropicText(json) : chatText(json);
  if (text === null) {
    throw fail("bad_response", status, "no text in the response");
  }
  if (text.trim() === "") {
    throw fail("bad_response", status, "empty text in the response");
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

// The reasoning level as the provider's own request fields, or none. Sent only
// where the model is known to take it: an unknown model gets none, so a new
// or misspelt model id can never fail on it. Ollama gets none, since whether
// its OpenAI-compatible endpoint takes reasoning_effort depends on the Ollama
// version and the model, and a model that cannot think refuses it.
// OpenRouter gets it only for the OpenAI and Anthropic models it passes
// through whose ids are on those providers' allowlists: its docs do not
// promise to ignore it on a model without reasoning, and an effort can switch
// reasoning on.
function reasoningFields(
  provider: AiProvider,
  model: string,
  level: AiReasoningLevel | null,
): Record<string, unknown> {
  if (level === null) return {};
  if (provider === "anthropic") {
    return ANTHROPIC_EFFORT_MODELS.test(model)
      ? { output_config: { effort: level } }
      : {};
  }
  if (provider === "openai") {
    return OPENAI_REASONING_MODELS.test(model)
      ? { reasoning_effort: level }
      : {};
  }
  if (provider === "openrouter") {
    return openRouterReasoningFamily(model) !== null
      ? { reasoning: { effort: level } }
      : {};
  }
  return {};
}

// Which allowlist an OpenRouter id is on, by the provider it passes through
// to; null for any other id. OpenRouter writes Claude versions with dots
// (anthropic/claude-sonnet-4.6) where Anthropic uses hyphens, so a dot
// between two digits becomes a hyphen before the match. Any other dot, a
// :variant suffix or an alias stays as it is and so matches nothing.
function openRouterReasoningFamily(
  model: string,
): "openai" | "anthropic" | null {
  if (
    model.startsWith(OPENROUTER_OPENAI_PREFIX) &&
    OPENAI_REASONING_MODELS.test(model.slice(OPENROUTER_OPENAI_PREFIX.length))
  ) {
    return "openai";
  }
  if (
    model.startsWith(OPENROUTER_ANTHROPIC_PREFIX) &&
    ANTHROPIC_EFFORT_MODELS.test(
      model
        .slice(OPENROUTER_ANTHROPIC_PREFIX.length)
        .replace(/(?<=\d)\.(?=\d)/g, "-"),
    )
  ) {
    return "anthropic";
  }
  return null;
}

// Output tokens added to the caller's maxTokens whenever a reasoning field is
// sent. Every provider counts reasoning against the same limit as the answer
// (Anthropic's max_tokens, OpenAI's max_completion_tokens, OpenRouter's
// max_tokens), so without it reasoning can use the whole limit and leave the
// answer empty. OpenAI's reasoning guide recommends reserving at least 25,000
// tokens for reasoning and output; neither Anthropic's nor OpenRouter's docs
// give a figure, only "leave room". One value for every level: no provider
// documents a figure per level, and a limit is a ceiling, not a charge.
export const REASONING_TOKEN_ALLOWANCE = 25_000;

// OpenRouter's thinking budget for an Anthropic model at each effort, as its
// share of max_tokens: budget_tokens = max(min(max_tokens * share, 128000),
// 1024), per its reasoning tokens docs.
const OPENROUTER_ANTHROPIC_EFFORT_SHARE: Record<AiReasoningLevel, number> = {
  low: 0.2,
  medium: 0.5,
  high: 0.8,
};

// The limit to send for an answer of `answer` tokens. Unchanged unless a
// reasoning field goes with it. On OpenRouter's Anthropic models the thinking
// budget grows with the limit, so the limit is also raised until what is left
// after the budget still holds the answer; the allowance alone already
// clears the 1024-token minimum budget.
function maxTokensFor(
  provider: AiProvider,
  model: string,
  level: AiReasoningLevel | null,
  reasoning: Record<string, unknown>,
  answer: number,
): number {
  if (level === null || Object.keys(reasoning).length === 0) return answer;
  const total = answer + REASONING_TOKEN_ALLOWANCE;
  if (
    provider === "openrouter" &&
    openRouterReasoningFamily(model) === "anthropic"
  ) {
    const share = OPENROUTER_ANTHROPIC_EFFORT_SHARE[level];
    return Math.max(total, Math.ceil(answer / (1 - share)));
  }
  return total;
}

// The Claude models whose Messages API takes output_config.effort: Opus 4.5
// to 4.8, Sonnet 4.6, and every 5.x model, with or without a date suffix.
// Older ones (Sonnet 4.5, Haiku 4.5) refuse it with a 400.
const ANTHROPIC_EFFORT_MODELS =
  /^claude-(?:opus-4-[5-8]|sonnet-4-6|(?:opus|sonnet|haiku|fable|mythos)-5(?:-\d)?)(?:-\d{8})?$/;

// The OpenAI reasoning models whose chat completions take reasoning_effort,
// with or without a date snapshot. Not o1-mini or o1-preview, which refuse
// it; not the -chat and -pro variants, which do not take low to high on
// chat completions.
const OPENAI_REASONING_MODELS =
  /^(?:o1|o3|o3-mini|o4-mini|gpt-5(?:\.\d+)?(?:-mini|-nano)?)(?:-\d{4}-\d{2}-\d{2})?$/;

// OpenRouter's ids for OpenAI's own models, e.g. openai/gpt-5-mini.
const OPENROUTER_OPENAI_PREFIX = "openai/";

// OpenRouter's ids for Anthropic's models, e.g. anthropic/claude-haiku-5.5.
const OPENROUTER_ANTHROPIC_PREFIX = "anthropic/";

function buildRequest(
  provider: AiProvider,
  model: string,
  credential: string,
  reasoningLevel: AiReasoningLevel | null,
  { system, user, maxTokens }: CompletionRequest,
): ProviderRequest | null {
  const reasoning = reasoningFields(provider, model, reasoningLevel);
  const limit = maxTokensFor(
    provider,
    model,
    reasoningLevel,
    reasoning,
    maxTokens,
  );
  if (provider === "anthropic") {
    return {
      url: ANTHROPIC_URL,
      headers: {
        "x-api-key": credential,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: {
        model,
        max_tokens: limit,
        system,
        messages: [{ role: "user", content: user }],
        ...reasoning,
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
      body: {
        model,
        messages,
        max_completion_tokens: limit,
        ...reasoning,
      },
      secrets: [],
    };
  }
  if (provider === "openrouter") {
    return {
      url: OPENROUTER_URL,
      headers: { authorization: `Bearer ${credential}` },
      body: { model, messages, max_tokens: limit, ...reasoning },
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
    secrets.push(basic, base.username, user, base.password, password);
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

// The code in an error body, { error: { type, code } }: Anthropic's
// error.type, or the OpenAI-compatible error.code, else error.type, whichever
// is first in PROVIDER_ERROR_CODES; null when neither is. Nothing else in the
// body, its message included, is ever quoted.
function errorCode(provider: AiProvider, json: unknown): string | null {
  if (!isRecord(json) || !isRecord(json.error)) return null;
  const { code, type } = json.error;
  const candidates = provider === "anthropic" ? [type] : [code, type];
  const found = candidates.find(
    (c) => typeof c === "string" && PROVIDER_ERROR_CODES.has(c),
  );
  return typeof found === "string" ? found : null;
}

// Only the name and code of a caught error, for `cause`: its message and its
// own causes may quote the request, so they never reach our error.
function causeOf(err: unknown): { name: string; code: string | null } {
  const name = err instanceof Error ? err.name : "";
  let code: string | null = null;
  for (
    let current: unknown = err;
    code === null && current instanceof Error;
    current = current.cause
  ) {
    const own = (current as { code?: unknown }).code;
    if (typeof own === "string" && NODE_ERROR_CODE.test(own)) code = own;
  }
  return { name: NODE_ERROR_CODE.test(name) ? name : "Error", code };
}

// `text` with every occurrence of each secret replaced, in one pass and
// longest first, so a URL goes whole rather than leaving its host around a
// redacted password, and a one-letter secret cannot eat into a marker
// already put in. No secret is too short: an ugly message beats a leaked one.
// Only exact copies are caught: a provider quoting part of a prompt is not,
// which is why provider text is never quoted at all.
function scrub(text: string, secrets: readonly string[]): string {
  const sorted = [...new Set(secrets)]
    .filter((secret) => secret !== "")
    .sort((a, b) => b.length - a.length);
  if (sorted.length === 0) return text;
  const pattern = new RegExp(
    sorted.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "g",
  );
  return text.replace(pattern, "[redacted]");
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

// Why a 2xx is not an answer whatever its text says, in our own fixed words;
// `code` is a provider error code as errorCode accepts it.
interface Unanswered {
  reason: "truncated" | "bad_response";
  message: string;
  code: string | null;
}

const TRUNCATED: Unanswered = {
  reason: "truncated",
  message: "answer cut off at the token limit",
  code: null,
};
const REFUSED: Unanswered = {
  reason: "bad_response",
  message: "model refused",
  code: null,
};
const FILTERED: Unanswered = {
  reason: "bad_response",
  message: "answer filtered by the provider",
  code: null,
};

// Messages API: the stop_reason of a refusal or a cut-off answer, whether
// at max_tokens or at the end of the model's context window.
function anthropicUnanswered(json: unknown): Unanswered | null {
  if (!isRecord(json)) return null;
  if (json.stop_reason === "refusal") return REFUSED;
  if (
    json.stop_reason === "max_tokens" ||
    json.stop_reason === "model_context_window_exceeded"
  ) {
    return TRUNCATED;
  }
  return null;
}

// Chat completions: an error in the body, as OpenRouter sends when the
// upstream fails after its 200 (top-level, or on the choice with
// finish_reason "error"); a refusal; an answer the provider's content
// filter stopped; or a cut-off answer.
function chatUnanswered(
  provider: AiProvider,
  json: unknown,
): Unanswered | null {
  if (!isRecord(json)) return null;
  const [first] = Array.isArray(json.choices)
    ? (json.choices as unknown[])
    : [];
  const choice = isRecord(first) ? first : {};
  if (
    (json.error ?? null) !== null ||
    (choice.error ?? null) !== null ||
    choice.finish_reason === "error"
  ) {
    return {
      reason: "bad_response",
      message: "provider reported an error",
      // Only a code from PROVIDER_ERROR_CODES. Not a numeric one, such as
      // OpenRouter repeating an upstream 502: even three digits can be part
      // of the prompt or the key, where the scrub of whole secrets misses it.
      code: errorCode(provider, json) ?? errorCode(provider, choice),
    };
  }
  const { refusal } = isRecord(choice.message) ? choice.message : {};
  if (typeof refusal === "string" && refusal !== "") return REFUSED;
  if (choice.finish_reason === "content_filter") return FILTERED;
  if (choice.finish_reason === "length") return TRUNCATED;
  return null;
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
