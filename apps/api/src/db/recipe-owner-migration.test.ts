import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { testDatabaseUrl } from "../test/env.js";

// 0008_recipe_owner gives recipes that existed before accounts an owner.
// That only matters on a database that already has recipes, which the
// shared test database never does when it migrates, so these tests stop a
// scratch database at 0007, add rows, then apply the rest.

const MIGRATION = "0008_recipe_owner";
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);

interface Journal {
  entries: { idx: number; tag: string }[];
}

const testUrl = new URL(testDatabaseUrl());
// Ends in _test like the shared one, and is dropped and recreated per test.
const scratchName = `${decodeURIComponent(testUrl.pathname.slice(1))}_recipe_owner_test`;
const scratchUrl = new URL(testUrl);
scratchUrl.pathname = `/${scratchName}`;
const adminUrl = new URL(testUrl);
adminUrl.pathname = "/postgres";

let beforeOwnerFolder: string;

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
  // A copy of the migrations folder whose journal stops before 0008.
  beforeOwnerFolder = await mkdtemp(path.join(os.tmpdir(), "foodie-0007-"));
  await cp(migrationsFolder, beforeOwnerFolder, { recursive: true });
  const journalPath = path.join(beforeOwnerFolder, "meta/_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as Journal;
  const cut = journal.entries.findIndex((e) => e.tag === MIGRATION);
  if (cut < 0) throw new Error(`${MIGRATION} is not in the journal`);
  journal.entries = journal.entries.slice(0, cut);
  await writeFile(journalPath, JSON.stringify(journal));
});

beforeEach(async () => {
  await dropScratch();
  await withAdmin((admin) =>
    admin
      .query(`create database ${admin.escapeIdentifier(scratchName)}`)
      .then(() => undefined),
  );
  await migrateScratch(beforeOwnerFolder);
  db = new pg.Client({ connectionString: scratchUrl.toString() });
  await db.connect();
  return async () => {
    await db.end();
  };
});

afterAll(async () => {
  await dropScratch();
  await rm(beforeOwnerFolder, { recursive: true, force: true });
});

async function insertUser(email: string, isAdmin: boolean): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `insert into "user" (email, is_admin) values ($1, $2) returning id`,
    [email, isAdmin],
  );
  return Number(rows[0]!.id);
}

async function insertRecipes(...titles: string[]) {
  for (const title of titles) {
    await db.query(`insert into recipe (title) values ($1)`, [title]);
  }
}

async function ownerIdColumnExists(): Promise<boolean> {
  const { rows } = await db.query(
    `select 1 from information_schema.columns
     where table_name = 'recipe' and column_name = 'owner_id'`,
  );
  return rows.length > 0;
}

describe(MIGRATION, () => {
  test("gives existing recipes to the lowest-id admin", async () => {
    await insertUser("cook@migration.test", false);
    const firstAdmin = await insertUser("first-admin@migration.test", true);
    await insertUser("second-admin@migration.test", true);
    await insertRecipes("Dal", "Shakshuka");

    await migrateScratch(migrationsFolder);

    const { rows } = await db.query<{ owner_id: string }>(
      `select owner_id from recipe`,
    );
    expect(rows.map((r) => Number(r.owner_id))).toEqual([
      firstAdmin,
      firstAdmin,
    ]);
  });

  test("applies to a database with no recipes and no admin", async () => {
    await insertUser("cook@migration.test", false);

    await migrateScratch(migrationsFolder);

    expect(await ownerIdColumnExists()).toBe(true);
  });

  test("fails, changing nothing, when recipes exist and no admin does", async () => {
    await insertUser("cook@migration.test", false);
    await insertRecipes("Dal");

    await expect(migrateScratch(migrationsFolder)).rejects.toMatchObject({
      cause: {
        message:
          "recipe.owner_id: 1 existing recipe(s) need an owner but there is no admin user to assign them to",
      },
    });
    expect(await ownerIdColumnExists()).toBe(false);
  });
});
