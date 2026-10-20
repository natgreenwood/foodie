import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { clientKey } from "../auth/client-key.js";
import { errorForLog } from "../db/errors.js";

// The error codes the signed-in api (auth, profile, recipes, admin) answers with,
// as { error, message }. The import preview has its own shape.
export type ApiErrorCode =
  | "invalid_request"
  | "invalid_credentials"
  | "email_taken"
  | "unauthenticated"
  | "forbidden"
  | "untrusted_origin"
  | "cannot_change_own_account"
  | "password_not_allowed"
  | "no_other_sign_in"
  | "rate_limited"
  | "not_found"
  | "invalid_lines"
  | "invalid_steps"
  | "unresolved_lines"
  | "internal_error";

// A request's path as a log line may carry it: never the query string or a
// fragment, which can hold an authorization code or a credential a client
// put there, and never percent-decoded. The raw path is unambiguous and the
// decoded one can be worked out from it; decoded, /admin%2Fai would read as
// the real /admin/ai, and an encoded ? as a query that was never sent.
export function pathForLog(url: string): string {
  return url.replace(/[?#].*$/s, "");
}

// Thrown by @fastify/rate-limit's errorResponseBuilder for a client over a
// route's limit; apiErrorHandler answers it as 429 rate_limited with this
// message, which is always ours.
export class RateLimitedError extends Error {
  readonly statusCode = 429;
}

export function sendError(
  reply: FastifyReply,
  status: number,
  error: ApiErrorCode,
  message: string,
) {
  return reply.code(status).send({ error, message });
}

// Our text for the Fastify 4xx errors a client can cause on these routes.
// Fastify's own messages are not all fixed (a validation error carries the
// validator's message), so none of them reaches a client.
const FASTIFY_4XX_MESSAGES: Record<string, string> = {
  FST_ERR_CTP_BODY_TOO_LARGE: "body is too large",
  FST_ERR_CTP_INVALID_MEDIA_TYPE: "content type is not supported",
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: "body size does not match Content-Length",
};

// An error handler for one plugin: an unparseable body answers in the
// contract's shape, and anything unexpected is logged as one line that names
// the module and the route (NATG-365). That line carries no error message from
// anywhere in the cause chain: Drizzle puts query parameters (a password hash
// or an email) in its message, Postgres quotes the offending value in some of
// its own, and a fetch or AI SDK error can carry a URL or a model's text. So
// only errorForLog's name and code, and where it was thrown.
export function apiErrorHandler(module: string) {
  return (err: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const route = `${request.method} ${request.routeOptions.url ?? pathForLog(request.url)}`;
    if (
      err.code === "FST_ERR_CTP_INVALID_JSON_BODY" ||
      err.code === "FST_ERR_CTP_EMPTY_JSON_BODY"
    ) {
      return sendError(reply, 400, "invalid_request", "body must be JSON");
    }
    if (err instanceof RateLimitedError) {
      request.log.warn(
        { route, key: clientKey(request) },
        `${module}: rate limited`,
      );
      return sendError(reply, 429, "rate_limited", err.message);
    }
    // Fastify's own 4xx errors (a body over the limit, an unsupported content
    // type) are the client's fault: keep the status, and log below error so
    // anyone sending a bad request cannot raise an alert. Only Fastify's, and
    // the message is always ours, never the error's.
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
      return sendError(
        reply,
        err.statusCode,
        "invalid_request",
        FASTIFY_4XX_MESSAGES[err.code] ?? "request was not accepted",
      );
    }
    request.log.error(
      { route, module, ...errorForLog(err), frames: stackFrames(err) },
      `${module}: request failed`,
    );
    return sendError(reply, 500, "internal_error", "something went wrong");
  };
}

const MAX_FRAMES = 5;

// The first few `at …` lines of an error's stack, without the header V8 puts
// before them: that is `name: message`, and the message may run over several
// lines, any of which could itself look like a frame. A stack that does not
// start with that header (the message or name changed after it was captured)
// gives no frames rather than a guess.
function stackFrames(err: unknown): string[] {
  if (!(err instanceof Error) || typeof err.stack !== "string") return [];
  const header = String(err);
  if (!err.stack.startsWith(`${header}\n`)) return [];
  return err.stack
    .slice(header.length + 1)
    .split("\n")
    .slice(0, MAX_FRAMES)
    .map((line) => withoutAlias(line.trim()))
    .filter((line) => line.startsWith("at "));
}

// V8 writes the property a function was called through as `[as key]`, before
// the `(location)` that ends the frame. A computed key can be request data,
// and can hold `]`, so everything from `[as ` up to that last ` (` goes.
function withoutAlias(frame: string): string {
  const alias = frame.indexOf(" [as ");
  if (alias === -1) return frame;
  const location = frame.lastIndexOf(" (");
  return (
    frame.slice(0, alias) + (location > alias ? frame.slice(location) : "")
  );
}
