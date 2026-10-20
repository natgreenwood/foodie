import { describe, expect, it } from "vitest";
import { describeError, describeTarget, errorForLog } from "./errors.js";

function withCode(message: string, code: string, cause?: unknown): Error {
  return Object.assign(new Error(message, { cause }), { code });
}

describe("errorForLog", () => {
  it("keeps the name and the SQLSTATE, and nothing of the query", () => {
    const pgError = Object.assign(
      new Error('violates check constraint "x"', { cause: undefined }),
      { code: "23514", detail: "Failing row contains (SECRET-ROW)." },
    );
    const drizzleError = Object.assign(
      new Error("Failed query: insert ...\nparams: SECRET-PARAM", {
        cause: pgError,
      }),
      { name: "DrizzleQueryError", params: ["SECRET-PARAM"] },
    );

    const fields = errorForLog(drizzleError);

    expect(fields).toEqual({ errorName: "DrizzleQueryError", code: "23514" });
    expect(JSON.stringify(fields)).not.toContain("SECRET");
  });

  it("keeps a Node system error code from the cause", () => {
    const err = new Error("Failed query: select 1", {
      cause: withCode("connect ECONNREFUSED 10.0.0.5:5432", "ECONNREFUSED"),
    });

    expect(errorForLog(err)).toEqual({
      errorName: "Error",
      code: "ECONNREFUSED",
    });
  });

  it.each([
    ["a code that is free text", withCode("x", "duplicate key SECRET")],
    ["a non-error", "SECRET"],
    [
      "a name that is not an identifier",
      Object.assign(new Error("x"), { name: "SECRET value" }),
    ],
  ])("drops %s", (_, err) => {
    expect(JSON.stringify(errorForLog(err))).not.toContain("SECRET");
  });
});

describe("describeError", () => {
  it("includes the driver error that Drizzle wraps in cause", () => {
    const pgError = withCode(
      'password authentication failed for user "foodie"',
      "28P01",
    );
    const drizzleError = new Error(
      'Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"\nparams: ',
      {
        cause: pgError,
      },
    );

    expect(describeError(drizzleError)).toBe(
      'Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle" <- [28P01] password authentication failed for user "foodie"',
    );
  });

  it("lists the inner errors of an AggregateError with no message", () => {
    const refused = Object.assign(
      new AggregateError(
        [
          new Error("connect ECONNREFUSED ::1:5432"),
          new Error("connect ECONNREFUSED 127.0.0.1:5432"),
        ],
        "",
      ),
      { code: "ECONNREFUSED" },
    );

    expect(
      describeError(new Error("Failed query: select 1", { cause: refused })),
    ).toBe(
      "Failed query: select 1 <- [ECONNREFUSED] connect ECONNREFUSED ::1:5432; connect ECONNREFUSED 127.0.0.1:5432",
    );
  });

  it("falls back to the error name when there is no message at all", () => {
    expect(describeError(new TypeError(""))).toBe("TypeError");
  });

  it("handles non-Error values and cyclic causes", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    a.cause = b;

    expect(describeError("boom")).toBe("boom");
    expect(describeError(a)).toBe("a <- b");
  });
});

describe("describeTarget", () => {
  it("returns host, port and database without credentials", () => {
    const target = describeTarget(
      "postgres://foodie:s3cret@db.internal:6543/foodie",
    );

    expect(target).toBe("db.internal:6543/foodie");
    expect(target).not.toContain("s3cret");
  });

  it("defaults the port and survives a malformed URL", () => {
    expect(describeTarget("postgres://u:p@postgres/foodie")).toBe(
      "postgres:5432/foodie",
    );
    expect(describeTarget("not a url")).toBe("(unparseable DATABASE_URL)");
  });
});
