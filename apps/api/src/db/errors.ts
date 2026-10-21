// Formats a database error and its `cause` chain on one line. Drizzle wraps
// driver errors as "Failed query: <sql>" and keeps the real reason (auth
// failure, DNS, refused connection) in `cause`, so logging only the top-level
// message hides it.
export function describeError(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    parts.push(describeOne(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(" <- ");
}

function describeOne(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  // Drizzle appends the query params on following lines; keep the first.
  const message = err.message.split("\n", 1)[0]?.trim() ?? "";
  const code = (err as { code?: unknown }).code;
  const prefix = typeof code === "string" && code !== "" ? `[${code}] ` : "";
  // Node reports a refused connection to a host with several addresses
  // (localhost -> ::1 and 127.0.0.1) as an AggregateError with no message.
  const detail =
    message ||
    (err instanceof AggregateError
      ? err.errors
          .map((inner) =>
            inner instanceof Error ? inner.message : String(inner),
          )
          .join("; ")
      : "") ||
    err.name;
  return `${prefix}${detail}`;
}

// What a log line may carry of an error that can be a failed query (SEC-2 on
// NATG-248): its name and one code, never its message, stack or cause. Those
// are where Drizzle and Postgres put the query, its parameters and the
// failing row, which for an import is page text and model output. `code` is
// the first Postgres SQLSTATE (five characters, e.g. 23514) or Node system
// error code (e.g. ECONNREFUSED) down the cause chain; anything else is
// dropped, as is a name that is not a plain identifier.
export function errorForLog(err: unknown): {
  errorName: string;
  code: string | null;
} {
  // Drizzle's DrizzleQueryError leaves name as "Error"; its class says more.
  const name =
    err instanceof Error
      ? err.name === "Error"
        ? err.constructor.name
        : err.name
      : "";
  let code: string | null = null;
  const seen = new Set<unknown>();
  for (
    let current: unknown = err;
    code === null && current instanceof Error && !seen.has(current);
    current = current.cause
  ) {
    seen.add(current);
    const own = (current as { code?: unknown }).code;
    if (typeof own === "string" && LOGGABLE_CODE.test(own)) code = own;
  }
  return { errorName: ERROR_NAME.test(name) ? name : "Error", code };
}

const LOGGABLE_CODE = /^(?:[0-9A-Z]{5}|E[A-Z0-9_]{2,40})$/;
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

// host:port/database from a connection string, without user or password.
export function describeTarget(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    return `${url.hostname}:${url.port || "5432"}${url.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}
