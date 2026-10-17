import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { describeError } from "../db/errors.js";

// The error codes the signed-in api (auth, profile, recipes, admin) answers with,
// as { error, message }. The import preview has its own shape.
export type ApiErrorCode =
  | "invalid_request"
  | "invalid_credentials"
  | "email_taken"
  | "unauthenticated"
  | "forbidden"
  | "cannot_change_own_account"
  | "password_not_allowed"
  | "no_local_password"
  | "not_found"
  | "internal_error";

// A request's path as a log line may carry it: percent-decoded, so every
// spelling of a route reads the same, and never the query string, which can
// hold an authorization code or a credential a client put there.
export function pathForLog(url: string): string {
  const [path = ""] = url.split("?", 1);
  try {
    return decodeURIComponent(path);
  } catch {
    // A malformed escape: the raw path, still without its query.
    return path;
  }
}

export function sendError(
  reply: FastifyReply,
  status: number,
  error: ApiErrorCode,
  message: string,
) {
  return reply.code(status).send({ error, message });
}

// An error handler for one plugin: an unparseable body answers in the
// contract's shape, and anything unexpected is logged as one line that names
// the module and the route. Drizzle puts query parameters (a password hash or
// an email) in the error message after the first line, and describeError
// keeps only the first.
export function apiErrorHandler(module: string) {
  return (err: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    if (
      err.code === "FST_ERR_CTP_INVALID_JSON_BODY" ||
      err.code === "FST_ERR_CTP_EMPTY_JSON_BODY"
    ) {
      return sendError(reply, 400, "invalid_request", "body must be JSON");
    }
    request.log.error(
      {
        route: `${request.method} ${request.routeOptions.url ?? pathForLog(request.url)}`,
        error: describeError(err),
      },
      `${module}: request failed`,
    );
    return sendError(reply, 500, "internal_error", "something went wrong");
  };
}
