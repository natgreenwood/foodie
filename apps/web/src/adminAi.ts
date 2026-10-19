import {
  AuthError,
  call,
  errorFrom,
  reportForbidden,
  reportUnauthenticated,
} from "./auth";

// Mirrors the NATG-277 and NATG-335 contract in the api's admin AI routes
// (apps/api/src/routes/admin-ai.ts). Responses say only whether a provider
// is configured, never its credential.

export const AI_PROVIDERS = [
  "anthropic",
  "openai",
  "openrouter",
  "ollama",
] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const AI_REASONING_LEVELS = ["low", "medium", "high"] as const;
export type AiReasoningLevel = (typeof AI_REASONING_LEVELS)[number];

export interface DefaultModel {
  provider: AiProvider | null;
  model: string | null;
  reasoningLevel: AiReasoningLevel | null;
}

export interface AdminAiSettings {
  configured: Record<AiProvider, boolean>;
  defaultModel: DefaultModel;
}

function isProvider(value: unknown): value is AiProvider {
  return (AI_PROVIDERS as readonly unknown[]).includes(value);
}

function isLevel(value: unknown): value is AiReasoningLevel {
  return (AI_REASONING_LEVELS as readonly unknown[]).includes(value);
}

function isDefaultModel(entry: unknown): entry is DefaultModel {
  if (typeof entry !== "object" || entry === null) return false;
  const { provider, model, reasoningLevel } = entry as Record<string, unknown>;
  return (
    (provider === null || isProvider(provider)) &&
    (model === null || typeof model === "string") &&
    (reasoningLevel === null || isLevel(reasoningLevel))
  );
}

// For these routes a 401 means the session has ended, and a 403 that the
// user is no longer an admin.
async function adminJson(res: Response): Promise<unknown> {
  if (res.status === 401) reportUnauthenticated();
  if (res.status === 403) reportForbidden();
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) throw errorFrom(res, body);
  return body;
}

function settingsFrom(body: unknown): AdminAiSettings {
  if (typeof body === "object" && body !== null) {
    const { providers, models } = body as Record<string, unknown>;
    if (Array.isArray(providers) && Array.isArray(models)) {
      const configured = Object.fromEntries(
        AI_PROVIDERS.map((provider) => [
          provider,
          providers.some(
            (entry: { provider?: unknown; configured?: unknown }) =>
              entry?.provider === provider && entry.configured === true,
          ),
        ]),
      ) as Record<AiProvider, boolean>;
      const found: unknown = models.find(
        (entry: { procedure?: unknown }) => entry?.procedure === "default",
      );
      if (isDefaultModel(found)) {
        const { provider, model, reasoningLevel } = found;
        return {
          configured,
          defaultModel: { provider, model, reasoningLevel },
        };
      }
    }
  }
  throw new AuthError(null, "its response was not the AI settings");
}

export async function fetchAdminAi(
  signal?: AbortSignal,
): Promise<AdminAiSettings> {
  return settingsFrom(
    await adminJson(await call("GET", "/admin/ai", undefined, signal)),
  );
}

// The API key, or for Ollama the server URL. Resolves once the api says the
// provider is configured.
export async function setProviderCredential(
  provider: AiProvider,
  credential: string,
): Promise<void> {
  const body = await adminJson(
    await call(
      "PUT",
      `/admin/ai/providers/${provider}`,
      provider === "ollama" ? { baseUrl: credential } : { apiKey: credential },
    ),
  );
  if ((body as { configured?: unknown } | undefined)?.configured !== true) {
    throw new AuthError(null, "its response did not say the key was saved");
  }
}

export async function clearProviderCredential(
  provider: AiProvider,
): Promise<void> {
  const res = await call("DELETE", `/admin/ai/providers/${provider}`);
  if (res.status !== 204) await adminJson(res);
}

// The app-wide default provider, model and reasoning level, as one request;
// a null level clears it. Answers with the selection as stored.
export async function setDefaultModel(selection: {
  provider: AiProvider;
  model: string;
  reasoningLevel: AiReasoningLevel | null;
}): Promise<DefaultModel> {
  const body = await adminJson(
    await call("PUT", "/admin/ai/models/default", selection),
  );
  if (isDefaultModel(body)) {
    const { provider, model, reasoningLevel } = body;
    return { provider, model, reasoningLevel };
  }
  throw new AuthError(null, "its response was not the saved model");
}
