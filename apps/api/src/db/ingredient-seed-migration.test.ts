import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { testDatabaseUrl } from "../test/env.js";

// 0015_seed_ingredient_catalogue is 1,312 hand-listed names, too many to
// review by eye, so these tests check what the approved list on NATG-247
// guarantees. They migrate a scratch database of their own from empty, as
// the shared test database's contents depend on which other tests are
// running.

const MIGRATION = "0015_seed_ingredient_catalogue";
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);

const CATEGORIES = [
  "produce",
  "herbs-spices",
  "dairy-eggs",
  "meat-poultry",
  "fish-seafood",
  "bakery-grains",
  "pantry",
  "oils-condiments",
  "frozen",
  "drinks",
];

const testUrl = new URL(testDatabaseUrl());
// Ends in _test like the shared one.
const scratchName = `${decodeURIComponent(testUrl.pathname.slice(1))}_ingredient_seed_test`;
const scratchUrl = new URL(testUrl);
scratchUrl.pathname = `/${scratchName}`;
const adminUrl = new URL(testUrl);
adminUrl.pathname = "/postgres";

async function withAdmin(run: (admin: pg.Client) => Promise<void>) {
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await run(admin);
  } finally {
    await admin.end();
  }
}

async function dropScratch() {
  await withAdmin((admin) =>
    admin
      .query(
        `drop database if exists ${admin.escapeIdentifier(scratchName)} with (force)`,
      )
      .then(() => undefined),
  );
}

async function migrateScratch() {
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  try {
    await migrate(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
}

let db: pg.Client;

async function counts() {
  const { rows } = await db.query<{ ingredients: number; names: number }>(
    `select (select count(*)::int from ingredient) as ingredients,
      (select count(*)::int from ingredient_name) as names`,
  );
  return rows[0];
}

beforeAll(async () => {
  await dropScratch();
  await withAdmin((admin) =>
    admin
      .query(`create database ${admin.escapeIdentifier(scratchName)}`)
      .then(() => undefined),
  );
  await migrateScratch();
  db = new pg.Client({ connectionString: scratchUrl.toString() });
  await db.connect();
});

afterAll(async () => {
  await db?.end();
  await dropScratch();
});

describe(MIGRATION, () => {
  test("seeds 357 ingredients and 1,312 names on an empty database", async () => {
    expect(await counts()).toEqual({ ingredients: 357, names: 1312 });
    const { rows } = await db.query<{ locale: string; n: number }>(
      `select locale, count(*)::int as n from ingredient_name
       group by locale order by locale`,
    );
    expect(rows).toEqual([
      { locale: "en-GB", n: 660 },
      { locale: "en-US", n: 652 },
    ]);
  });

  test("gives every ingredient exactly one canonical name per seeded locale", async () => {
    const { rows } = await db.query<{
      id: string;
      gb: number;
      us: number;
    }>(
      `select i.id,
        count(*) filter (where n.is_canonical and n.locale = 'en-GB')::int as gb,
        count(*) filter (where n.is_canonical and n.locale = 'en-US')::int as us
       from ingredient i left join ingredient_name n on n.ingredient_id = i.id
       group by i.id
       having count(*) filter (where n.is_canonical and n.locale = 'en-GB') <> 1
         or count(*) filter (where n.is_canonical and n.locale = 'en-US') <> 1`,
    );
    expect(rows).toEqual([]);
  });

  test("marks every row as seeded", async () => {
    const { rows } = await db.query<{ source: string | null; n: number }>(
      `select source, count(*)::int as n from (
         select source from ingredient
         union all select source from ingredient_name
       ) s group by source`,
    );
    expect(rows).toEqual([{ source: "seed", n: 357 + 1312 }]);
  });

  // A null created_by is what makes a catalogue row prebuilt (NATG-210).
  test("leaves created_by null on every row", async () => {
    const { rows } = await db.query<{ created_by: string | null; n: number }>(
      `select created_by, count(*)::int as n from (
         select created_by from ingredient
         union all select created_by from ingredient_name
       ) s group by created_by`,
    );
    expect(rows).toEqual([{ created_by: null, n: 357 + 1312 }]);
  });

  test("uses only the ten category slugs, and null only for water", async () => {
    const { rows } = await db.query<{ category: string | null }>(
      `select distinct category from ingredient`,
    );
    expect(rows.map((r) => r.category).sort()).toEqual(
      [...CATEGORIES, null].sort(),
    );
    const { rows: uncategorised } = await db.query<{ name: string }>(
      `select n.name from ingredient i
       join ingredient_name n on n.ingredient_id = i.id
       where i.category is null and n.is_canonical`,
    );
    expect(uncategorised.map((r) => r.name)).toEqual(["water", "water"]);
  });

  test("a second migrate succeeds and leaves the counts unchanged", async () => {
    await migrateScratch();

    expect(await counts()).toEqual({ ingredients: 357, names: 1312 });
  });
});
