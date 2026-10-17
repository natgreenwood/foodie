import type { FastifyPluginCallback, FastifyReply } from "fastify";
import {
  AI_PROCEDURES,
  clearProviderCredential,
  configuredProviders,
  isAiProcedure,
  isAiProvider,
  listModelSelections,
  setModelSelection,
  setProviderCredential,
  type AiProvider,
} from "../ai/settings.js";
import { asAdmin } from "../auth/admin.js";
import {
  adminActor,
  isRecord,
  sendAdminRefusal,
  type AuthDeps,
} from "./auth.js";
import { apiErrorHandler, sendError } from "./errors.js";

export interface AdminAiDeps extends AuthDeps {
  // AES-256 key for the stored provider credentials, SETTINGS_ENCRYPTION_KEY.
  settingsKey: Buffer;
}

export interface AdminAiResponse {
  providers: { provider: AiProvider; configured: boolean }[];
  // One entry per known procedure; provider and model are null until set.
  models: {
    procedure: string;
    provider: AiProvider | null;
    model: string | null;
  }[];
}

// Long enough for any provider's key; anything longer is a mistake.
const API_KEY_MAX_LENGTH = 1024;
const BASE_URL_MAX_LENGTH = 2048;
const MODEL_MAX_LENGTH = 200;

// The credential from a PUT body: { apiKey } for a hosted provider,
// { baseUrl } for Ollama. Messages never include the value.
function parseCredential(
  provider: AiProvider,
  body: Record<string, unknown>,
): { credential: string } | { problem: string } {
  const field = provider === "ollama" ? "baseUrl" : "apiKey";
  const unknown = Object.keys(body).filter((key) => key !== field);
  if (unknown.length > 0) {
    return { problem: `unknown field: ${unknown.join(", ")}` };
  }
  const value = body[field];
  if (typeof value !== "string") {
    return { problem: `${field} must be a string` };
  }
  const credential = value.trim();
  if (field === "apiKey") {
    if (credential === "" || /\s/.test(credential)) {
      return { problem: "apiKey must be non-empty with no spaces" };
    }
    if (credential.length > API_KEY_MAX_LENGTH) {
      return {
        problem: `apiKey must be at most ${API_KEY_MAX_LENGTH} characters`,
      };
    }
    return { credential };
  }
  if (credential.length > BASE_URL_MAX_LENGTH) {
    return {
      problem: `baseUrl must be at most ${BASE_URL_MAX_LENGTH} characters`,
    };
  }
  const url = URL.canParse(credential) ? new URL(credential) : null;
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return { problem: "baseUrl must be an http or https URL" };
  }
  return { credential };
}

function unknownProvider(reply: FastifyReply) {
  return sendError(reply, 404, "not_found", "unknown provider");
}

// /admin/ai: the platform-wide AI provider credentials and the model each
// procedure uses. Registered behind requireUser and requireAdmin. Responses
// say only whether a provider is configured, never its credential, and no
// log line here carries one. Every write is idempotent, and re-checks the
// acting admin inside its own transaction (asAdmin).
export const adminAiRoutes: FastifyPluginCallback<AdminAiDeps> = (
  app,
  { db, settingsKey },
  done,
) => {
  app.setErrorHandler(apiErrorHandler("admin ai"));

  app.get("/admin/ai", async (): Promise<AdminAiResponse> => {
    const [providers, selections] = await Promise.all([
      configuredProviders(db),
      listModelSelections(db),
    ]);
    return {
      providers,
      models: AI_PROCEDURES.map((procedure) => {
        const found = selections.find((s) => s.procedure === procedure);
        return {
          procedure,
          provider: found?.provider ?? null,
          model: found?.model ?? null,
        };
      }),
    };
  });

  // { apiKey } or, for ollama, { baseUrl }: sets the provider's credential,
  // replacing any earlier one.
  app.put<{ Params: { provider: string }; Body: unknown }>(
    "/admin/ai/providers/:provider",
    async (request, reply) => {
      const { provider } = request.params;
      if (!isAiProvider(provider)) return unknownProvider(reply);
      const parsed = parseCredential(
        provider,
        isRecord(request.body) ? request.body : {},
      );
      if ("problem" in parsed) {
        return sendError(reply, 400, "invalid_request", parsed.problem);
      }
      const result = await asAdmin(db, adminActor(request), null, (t) =>
        setProviderCredential(t, settingsKey, provider, parsed.credential),
      );
      if (result.refused) return sendAdminRefusal(reply, result.refused);
      request.log.info(
        { adminId: request.user!.id, provider, action: "set" },
        "admin ai: provider changed",
      );
      return { provider, configured: true };
    },
  );

  // Clears the provider's credential. 204 whether or not one was set.
  app.delete<{ Params: { provider: string } }>(
    "/admin/ai/providers/:provider",
    async (request, reply) => {
      const { provider } = request.params;
      if (!isAiProvider(provider)) return unknownProvider(reply);
      const result = await asAdmin(db, adminActor(request), null, (t) =>
        clearProviderCredential(t, provider),
      );
      if (result.refused) return sendAdminRefusal(reply, result.refused);
      request.log.info(
        { adminId: request.user!.id, provider, action: "clear" },
        "admin ai: provider changed",
      );
      return reply.code(204).send();
    },
  );

  // { provider, model }: the model the procedure uses. The provider need not
  // be configured yet.
  app.put<{ Params: { procedure: string }; Body: unknown }>(
    "/admin/ai/models/:procedure",
    async (request, reply) => {
      const { procedure } = request.params;
      if (!isAiProcedure(procedure)) {
        return sendError(reply, 404, "not_found", "unknown procedure");
      }
      const body = isRecord(request.body) ? request.body : {};
      const unknown = Object.keys(body).filter(
        (key) => key !== "provider" && key !== "model",
      );
      if (unknown.length > 0) {
        return sendError(
          reply,
          400,
          "invalid_request",
          `unknown field: ${unknown.join(", ")}`,
        );
      }
      if (typeof body.provider !== "string" || !isAiProvider(body.provider)) {
        return sendError(
          reply,
          400,
          "invalid_request",
          "provider must be one of anthropic, openai, openrouter, ollama",
        );
      }
      const model = typeof body.model === "string" ? body.model.trim() : "";
      if (model === "" || /\s/.test(model) || model.length > MODEL_MAX_LENGTH) {
        return sendError(
          reply,
          400,
          "invalid_request",
          `model must be a model id of at most ${MODEL_MAX_LENGTH} characters, with no spaces`,
        );
      }
      const selection = { procedure, provider: body.provider, model };
      const result = await asAdmin(db, adminActor(request), null, (t) =>
        setModelSelection(t, selection),
      );
      if (result.refused) return sendAdminRefusal(reply, result.refused);
      request.log.info(
        { adminId: request.user!.id, ...selection },
        "admin ai: model changed",
      );
      return selection;
    },
  );

  done();
};
