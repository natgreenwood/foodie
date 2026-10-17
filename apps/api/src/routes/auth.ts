import cookie from "@fastify/cookie";
import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import {
  checkCredentials,
  createSession,
  createUser,
  deleteSession,
  sessionId,
  sessionUser,
  type Db,
  type Profile,
} from "../auth/accounts.js";
import {
  displayNameProblem,
  normaliseEmail,
  PASSWORD_MAX_LENGTH,
  passwordProblem,
} from "../auth/credentials.js";
import type { AdminActor, AdminRefusal } from "../auth/admin.js";
import { apiErrorHandler, sendError } from "./errors.js";

export interface AuthDeps {
  db: Db;
  // Secure on the session cookie: everywhere except local development.
  secureCookies: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    // Set by requireUser on every route behind it; null elsewhere.
    user: Profile | null;
    // The session table id of the cookie requireUser accepted; null elsewhere.
    sessionId: string | null;
  }
}

export const SESSION_COOKIE = "foodie_session";

// Registers the cookie parser and the request.user slot on the root app, so
// every plugin sees them.
export function registerSessionSupport(app: FastifyInstance) {
  app.register(cookie);
  app.decorateRequest("user", null);
  app.decorateRequest("sessionId", null);
}

// onRequest hook for every route that needs a signed-in user: loads the
// session's user onto request.user, or answers 401.
export function requireUser({ db }: AuthDeps) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.cookies[SESSION_COOKIE];
    const found = token ? await sessionUser(db, token) : null;
    if (!token || !found) {
      if (token) reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return sendError(reply, 401, "unauthenticated", "sign in required");
    }
    request.user = found;
    request.sessionId = sessionId(token);
  };
}

// onRequest hook, after requireUser, for every admin route: answers 403 to
// a signed-in user who is not an admin. request.user is read from the
// database on each request, so a revoked admin is refused at once.
export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (!request.user?.isAdmin) {
    return sendError(reply, 403, "forbidden", "admin only");
  }
}

// The signed-in admin as the actor of a privileged change, for asAdmin.
export function adminActor(request: FastifyRequest): AdminActor {
  return { userId: request.user!.id, sessionId: request.sessionId! };
}

// The answer when asAdmin finds the actor is no longer allowed to act: the
// same as requireUser and requireAdmin would now give.
export function sendAdminRefusal(reply: FastifyReply, refusal: AdminRefusal) {
  return refusal === "forbidden"
    ? sendError(reply, 403, "forbidden", "admin only")
    : sendError(reply, 401, "unauthenticated", "sign in required");
}

// POST /auth/register, /auth/login and /auth/logout. Open to anyone.
export const authRoutes: FastifyPluginCallback<AuthDeps> = (
  app,
  deps,
  done,
) => {
  const { db } = deps;
  app.setErrorHandler(apiErrorHandler("auth"));

  async function signIn(reply: FastifyReply, userId: number) {
    const { token, expiresAt } = await createSession(db, userId);
    reply.setCookie(SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: deps.secureCookies,
      expires: expiresAt,
    });
  }

  // { email, password, displayName? }: creates the account and signs it in.
  app.post<{ Body: unknown }>("/auth/register", async (request, reply) => {
    const body = isRecord(request.body) ? request.body : {};
    if (typeof body.email !== "string" || typeof body.password !== "string") {
      return sendError(
        reply,
        400,
        "invalid_request",
        "email and password must be strings",
      );
    }
    const email = normaliseEmail(body.email);
    if (email === null) {
      return sendError(reply, 400, "invalid_request", "email is not valid");
    }
    const problem =
      passwordProblem(body.password) ?? displayNameProblem(body.displayName);
    if (problem !== null) {
      return sendError(reply, 400, "invalid_request", problem);
    }

    const created = await createUser(db, {
      email,
      password: body.password,
      displayName:
        typeof body.displayName === "string" ? body.displayName.trim() : null,
    });
    if (!created) {
      return sendError(
        reply,
        409,
        "email_taken",
        "an account with this email already exists",
      );
    }
    await signIn(reply, created.id);
    request.log.info({ userId: created.id }, "auth: registered");
    return reply.code(201).send(created);
  });

  // { email, password }. Unknown email, wrong password, an account with no
  // password and a disabled account all get the same 401 after the same
  // amount of work.
  app.post<{ Body: unknown }>("/auth/login", async (request, reply) => {
    const body = isRecord(request.body) ? request.body : {};
    if (typeof body.email !== "string" || typeof body.password !== "string") {
      return sendError(
        reply,
        400,
        "invalid_request",
        "email and password must be strings",
      );
    }
    const email = body.email.trim();
    // The one line a failed sign-in writes: who was tried, from where.
    const logFailure = () =>
      request.log.warn({ email, ip: request.ip }, "auth: sign-in failed");
    // Refused before hashing, but still a failed sign-in.
    if (body.password.length > PASSWORD_MAX_LENGTH) {
      logFailure();
      return sendError(
        reply,
        400,
        "invalid_request",
        `password must be at most ${PASSWORD_MAX_LENGTH} characters`,
      );
    }
    const found = await checkCredentials(db, email, body.password);
    if (!found) {
      logFailure();
      return sendError(
        reply,
        401,
        "invalid_credentials",
        "email or password is incorrect",
      );
    }
    await signIn(reply, found.id);
    return found;
  });

  // Ends the cookie's session, if any. Always 204, so a retry is harmless.
  app.post("/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await deleteSession(db, token);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.code(204).send();
  });

  done();
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
