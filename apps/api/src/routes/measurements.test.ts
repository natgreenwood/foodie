import type { LightMyRequestResponse as Response } from "fastify";
import { describe, expect, onTestFinished } from "vitest";
import { buildApp } from "../app.js";
import { createSession } from "../auth/accounts.js";
import type { Measurement } from "../db/measurements.js";
import { measurement, measurementName, user } from "../db/schema.js";
import { dbTest, type TestTransaction } from "../test/db.js";
import { SESSION_COOKIE } from "./auth.js";

const unused = () => Promise.reject(new Error("not used by these tests"));

function start(tx: TestTransaction) {
  const app = buildApp({
    pingDatabase: () => Promise.resolve(),
    fetchPage: unused,
    loadUnits: unused,
    matchIngredients: unused,
    db: tx,
    secureCookies: true,
    settingsKey: Buffer.alloc(32),
  });
  onTestFinished(() => app.close());

  const list = (token?: string): Promise<Response> =>
    app.inject({
      method: "GET",
      url: "/measurements",
      cookies: token ? { [SESSION_COOKIE]: token } : {},
    });
  return { list };
}

async function signedIn(tx: TestTransaction): Promise<string> {
  const [row] = await tx
    .insert(user)
    .values({ email: `cook-${crypto.randomUUID()}@measurement-routes.test` })
    .returning({ id: user.id });
  if (!row) throw new Error("user insert returned no row");
  return (await createSession(tx, row.id)).token;
}

// The keys 0001_seed_measurement_units.sql and 0006_measurement_key.sql
// gave the system units.
const seededKeys = [
  "gram",
  "kilogram",
  "ounce",
  "pound",
  "millilitre",
  "litre",
  "teaspoon",
  "tablespoon",
  "cup_us",
  "cup_metric",
  "fl_oz_us",
  "fl_oz_imperial",
  "pint_us",
  "pint_imperial",
  "quart_us",
  "each",
  "clove",
  "pinch",
  "dash",
  "slice",
  "can",
  "bunch",
  "sprig",
  "handful",
  "packet",
];

function byKey(units: Measurement[], key: string): Measurement {
  const unit = units.find((u) => u.key === key);
  if (!unit) throw new Error(`no unit with key ${key}`);
  return unit;
}

describe("GET /measurements", () => {
  dbTest("returns every seeded unit with its names", async ({ tx }) => {
    const { list } = start(tx);

    const res = await list(await signedIn(tx));

    expect(res.statusCode).toBe(200);
    const { measurements } = res.json<{ measurements: Measurement[] }>();
    expect(measurements.map((u) => u.key).sort()).toEqual(
      [...seededKeys].sort(),
    );
    expect(byKey(measurements, "cup_us")).toEqual({
      id: expect.any(Number) as number,
      key: "cup_us",
      type: "volume",
      names: [
        {
          locale: "en-GB",
          name: "US cup",
          abbreviation: "US cup",
          isCanonical: true,
        },
        {
          locale: "en-US",
          name: "cup",
          abbreviation: "cup",
          isCanonical: true,
        },
      ],
    });
    expect(byKey(measurements, "clove").names).toEqual([
      { locale: "en-GB", name: "clove", abbreviation: null, isCanonical: true },
      { locale: "en-US", name: "clove", abbreviation: null, isCanonical: true },
    ]);
  });

  dbTest("orders units by type, then name", async ({ tx }) => {
    const { list } = start(tx);

    const res = await list(await signedIn(tx));

    const { measurements } = res.json<{ measurements: Measurement[] }>();
    const types = measurements.map((u) => u.type);
    expect(types).toEqual([
      ...types.filter((t) => t === "mass"),
      ...types.filter((t) => t === "volume"),
      ...types.filter((t) => t === "count"),
    ]);
    // Not the seed's order. can sorts by "can" (en-US) ahead of "tin"
    // (en-GB), packet by "package" (en-US) ahead of "packet" (en-GB).
    expect(
      measurements.filter((u) => u.type === "count").map((u) => u.key),
    ).toEqual([
      "bunch",
      "can",
      "clove",
      "dash",
      "each",
      "handful",
      "packet",
      "pinch",
      "slice",
      "sprig",
    ]);
  });

  dbTest("includes a user-created unit and every name", async ({ tx }) => {
    const { list } = start(tx);
    const [named] = await tx
      .insert(measurement)
      .values({ type: "count" })
      .returning({ id: measurement.id });
    const [unnamed] = await tx
      .insert(measurement)
      .values({ type: "count" })
      .returning({ id: measurement.id });
    if (!named || !unnamed)
      throw new Error("measurement insert returned no row");
    await tx.insert(measurementName).values([
      { measurementId: named.id, locale: "en-GB", name: "punnet" },
      {
        measurementId: named.id,
        locale: "en-GB",
        name: "basket",
        isCanonical: true,
      },
    ]);

    const res = await list(await signedIn(tx));

    const { measurements } = res.json<{ measurements: Measurement[] }>();
    expect(measurements.find((u) => u.id === named.id)).toEqual({
      id: named.id,
      key: null,
      type: "count",
      names: [
        {
          locale: "en-GB",
          name: "basket",
          abbreviation: null,
          isCanonical: true,
        },
        {
          locale: "en-GB",
          name: "punnet",
          abbreviation: null,
          isCanonical: false,
        },
      ],
    });
    // No canonical name to sort by: last.
    expect(measurements.at(-1)).toEqual({
      id: unnamed.id,
      key: null,
      type: "count",
      names: [],
    });
  });
});

describe("without a session", () => {
  dbTest("GET /measurements returns 401", async ({ tx }) => {
    const { list } = start(tx);

    const res = await list();

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: "unauthenticated",
      message: "sign in required",
    });
  });

  dbTest("an unknown session token gets 401", async ({ tx }) => {
    const { list } = start(tx);

    const res = await list("not-a-session");

    expect(res.statusCode).toBe(401);
  });
});
