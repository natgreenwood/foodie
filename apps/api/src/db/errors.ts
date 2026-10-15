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

// host:port/database from a connection string, without user or password.
export function describeTarget(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    return `${url.hostname}:${url.port || "5432"}${url.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}
