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
  | "not_found"
  | "internal_error";

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
    const route = `${request.method} ${request.routeOptions.url ?? request.url}`;
    if (
      err.code === "FST_ERR_CTP_INVALID_JSON_BODY" ||
      err.code === "FST_ERR_CTP_EMPTY_JSON_BODY"
    ) {
      return sendError(reply, 400, "invalid_request", "body must be JSON");
    }
    // Fastify's own 4xx errors (a body over the limit, an unsupported content
    // type) are the client's fault: keep the status, and log below error so
    // anyone sending a bad request cannot raise an alert. Only Fastify's, so
    // the message is one of its fixed texts and never a thrown error's detail.
    if (
      err.code?.startsWith("FST_") &&
      err.statusCode !== undefined &&
      err.statusCode >= 400 &&
      err.statusCode < 500
    ) {
      request.log.warn(
        { route, status: err.statusCode, code: err.code },
        `${module}: request refused`,
      );
      return sendError(reply, err.statusCode, "invalid_request", err.message);
    }
    request.log.error(
      { route, error: describeError(err) },
      `${module}: request failed`,
    );
    return sendError(reply, 500, "internal_error", "something went wrong");
  };
}
