import type { FastifyPluginCallback } from "fastify";
import { updateProfile, type Profile } from "../auth/accounts.js";
import { canonicalLocale, displayNameProblem } from "../auth/credentials.js";
import { signInMethods, type SignInMethods } from "../auth/oidc.js";
import { isRecord, type AuthDeps } from "./auth.js";
import { apiErrorHandler, sendError } from "./errors.js";

// GET /me and PATCH /me: the signed-in user's own profile. Registered behind
// requireUser, so request.user is always set here.
//
// GET also says how the account signs in (hasPassword, oidc), so the
// profile knows whether to offer connect or disconnect.
export const meRoutes: FastifyPluginCallback<AuthDeps> = (
  app,
  { db },
  done,
) => {
  app.setErrorHandler(apiErrorHandler("me"));

  app.get("/me", async (request, reply) => {
    const profile: Profile = request.user!;
    const methods = await signInMethods(db, profile.id);
    // Deleted between the session check and here.
    if (!methods) {
      return sendError(reply, 401, "unauthenticated", "sign in required");
    }
    const me: Profile & SignInMethods = { ...profile, ...methods };
    return reply.send(me);
  });

  // { displayName?, locale? }: at least one. displayName null clears it;
  // locale is stored in its canonical form.
  app.patch<{ Body: unknown }>("/me", async (request, reply) => {
    const body = isRecord(request.body) ? request.body : {};
    const unknown = Object.keys(body).filter(
      (key) => key !== "displayName" && key !== "locale",
    );
    if (unknown.length > 0) {
      return sendError(
        reply,
        400,
        "invalid_request",
        `unknown field: ${unknown.join(", ")}`,
      );
    }
    if (body.displayName === undefined && body.locale === undefined) {
      return sendError(
        reply,
        400,
        "invalid_request",
        "send displayName or locale",
      );
    }
    const problem = displayNameProblem(body.displayName);
    if (problem !== null) {
      return sendError(reply, 400, "invalid_request", problem);
    }
    const changes: { displayName?: string | null; locale?: string } = {};
    if (body.displayName !== undefined) {
      changes.displayName =
        typeof body.displayName === "string" ? body.displayName.trim() : null;
    }
    if (body.locale !== undefined) {
      const locale =
        typeof body.locale === "string" ? canonicalLocale(body.locale) : null;
      if (locale === null) {
        return sendError(
          reply,
          400,
          "invalid_request",
          "locale must be a BCP-47 language tag",
        );
      }
      changes.locale = locale;
    }

    const updated = await updateProfile(db, request.user!.id, changes);
    // Deleted between the session check and here.
    if (!updated) {
      return sendError(reply, 401, "unauthenticated", "sign in required");
    }
    return updated;
  });

  done();
};
