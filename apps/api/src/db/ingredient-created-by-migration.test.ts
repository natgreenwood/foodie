import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { testDatabaseUrl } from "../test/env.js";

// 0014_ingredient_created_by adds a nullable created_by to the catalogue
// tables. The shared test database migrates empty, so this stops a scratch
// database just before 0014 (after 0013_ai_reasoning_level), adds catalogue
// rows as main has them, then applies the rest.

const MIGRATION = "0014_ingredient_created_by";
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);

interface Journal {
  entries: { idx: number; tag: string }[];
}

const testUrl = new URL(testDatabaseUrl());
// Ends in _test like the shared one.
const scratchName = `${decodeURIComponent(testUrl.pathname.slice(1))}_ingredient_created_by_test`;
const scratchUrl = new URL(testUrl);
scratchUrl.pathname = `/${scratchName}`;
const adminUrl = new URL(testUrl);
adminUrl.pathname = "/postgres";

let beforeFolder: string;

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

async function migrateScratch(folder: string) {
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  try {
    await migrate(drizzle(pool), { migrationsFolder: folder });
  } finally {
    await pool.end();
  }
}

let db: pg.Client;

beforeAll(async () => {
  // A copy of the migrations folder whose journal stops before 0014.
  beforeFolder = await mkdtemp(path.join(os.tmpdir(), "foodie-0013-"));
  await cp(migrationsFolder, beforeFolder, { recursive: true });
  const journalPath = path.join(beforeFolder, "meta/_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as Journal;
  const cut = journal.entries.findIndex((e) => e.tag === MIGRATION);
  if (cut < 0) throw new Error(`${MIGRATION} is not in the journal`);
  journal.entries = journal.entries.slice(0, cut);
  await writeFile(journalPath, JSON.stringify(journal));

  await dropScratch();
  await withAdmin((admin) =>
    admin
      .query(`create database ${admin.escapeIdentifier(scratchName)}`)
      .then(() => undefined),
  );
  await migrateScratch(beforeFolder);
  db = new pg.Client({ connectionString: scratchUrl.toString() });
  await db.connect();
});

afterAll(async () => {
  await db?.end();
  await dropScratch();
  await rm(beforeFolder, { recursive: true, force: true });
});

describe(MIGRATION, () => {
  test("applies on top of existing catalogue rows, leaving them prebuilt", async () => {
    // 0013_ai_reasoning_level is already applied.
    const { rows: before } = await db.query(
      `select 1 from information_schema.columns
       where table_name = 'ai_model_selection' and column_name = 'reasoning_level'`,
    );
    expect(before).toHaveLength(1);
    const { rows } = await db.query<{ id: string }>(
      `insert into ingredient (category, source) values ('herbs', 'seed') returning id`,
    );
    const id = rows[0]!.id;
    await db.query(
      `insert into ingredient_name (ingredient_id, name, locale, is_canonical, source)
       values ($1, 'coriander', 'en-GB', true, 'seed')`,
      [id],
    );

    await migrateScratch(migrationsFolder);

    const ingredients = await db.query(
      `select category, source, created_by from ingredient`,
    );
    expect(ingredients.rows).toEqual([
      { category: "herbs", source: "seed", created_by: null },
    ]);
    const names = await db.query(
      `select name, created_by from ingredient_name`,
    );
    expect(names.rows).toEqual([{ name: "coriander", created_by: null }]);
    const { rows: fks } = await db.query(
      `select conname, confdeltype from pg_constraint
       where conname in ('ingredient_created_by_user_id_fk',
         'ingredient_name_created_by_user_id_fk')
       order by conname`,
    );
    // n: on delete set null.
    expect(fks).toEqual([
      { conname: "ingredient_created_by_user_id_fk", confdeltype: "n" },
      { conname: "ingredient_name_created_by_user_id_fk", confdeltype: "n" },
    ]);
  });
});
