import cookie from "@fastify/cookie";
import type {
  FastifyError,
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
import { describeError } from "../db/errors.js";

export interface AuthDeps {
  db: Db;
  // Secure on the session cookie: everywhere except local development.
  secureCookies: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    // Set by requireUser on every route behind it; null elsewhere.
    user: Profile | null;
  }
}

export const SESSION_COOKIE = "foodie_session";

export type AuthErrorCode =
  | "invalid_request"
  | "invalid_credentials"
  | "email_taken"
  | "unauthenticated"
  | "internal_error";

export function sendError(
  reply: FastifyReply,
  status: number,
  error: AuthErrorCode,
  message: string,
) {
  return reply.code(status).send({ error, message });
}

// Registers the cookie parser and the request.user slot on the root app, so
// every plugin sees them.
export function registerSessionSupport(app: FastifyInstance) {
  app.register(cookie);
  app.decorateRequest("user", null);
}

// For the auth and profile plugins: an unparseable body answers in the
// contract's shape, and anything unexpected is logged as one line. Drizzle
// puts query parameters (here a password hash or an email) in the error
// message after the first line, and describeError keeps only the first.
export function authErrorHandler(
  err: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (
    err.code === "FST_ERR_CTP_INVALID_JSON_BODY" ||
    err.code === "FST_ERR_CTP_EMPTY_JSON_BODY"
  ) {
    return sendError(reply, 400, "invalid_request", "body must be JSON");
  }
  request.log.error({ error: describeError(err) }, "auth: request failed");
  return sendError(reply, 500, "internal_error", "something went wrong");
}

// onRequest hook for every route that needs a signed-in user: loads the
// session's user onto request.user, or answers 401.
export function requireUser({ db }: AuthDeps) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.cookies[SESSION_COOKIE];
    const found = token ? await sessionUser(db, token) : null;
    if (!found) {
      if (token) reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return sendError(reply, 401, "unauthenticated", "sign in required");
    }
    request.user = found;
  };
}

// POST /auth/register, /auth/login and /auth/logout. Open to anyone.
export const authRoutes: FastifyPluginCallback<AuthDeps> = (
  app,
  deps,
  done,
) => {
  const { db } = deps;
  app.setErrorHandler(authErrorHandler);

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
    if (body.password.length > PASSWORD_MAX_LENGTH) {
      return sendError(
        reply,
        400,
        "invalid_request",
        `password must be at most ${PASSWORD_MAX_LENGTH} characters`,
      );
    }
    const email = body.email.trim();
    const found = await checkCredentials(db, email, body.password);
    if (!found) {
      // The one line a failed sign-in writes: who was tried, from where.
      request.log.warn({ email, ip: request.ip }, "auth: sign-in failed");
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
