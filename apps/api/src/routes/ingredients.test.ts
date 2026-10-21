import { asc, eq } from "drizzle-orm";
import type { LightMyRequestResponse as Response } from "fastify";
import { describe, expect, onTestFinished, test } from "vitest";
import { buildApp } from "../app.js";
import { createSession } from "../auth/accounts.js";
import { MAX_NAMES, PAGE_SIZE } from "../db/ingredients.js";
import {
  ingredient,
  ingredientName,
  recipe,
  recipeIngredient,
  user,
} from "../db/schema.js";
import { dbTest as sharedDbTest, type TestTransaction } from "../test/db.js";
import { SESSION_COOKIE } from "./auth.js";
import { parseListQuery } from "./ingredients.js";

const unused = () => Promise.reject(new Error("not used by these tests"));

// These tests list, search and create against a catalogue they build, so
// each starts from an empty one. The seeded catalogue (0015) is deleted
// inside the test's transaction, and the rollback restores it.
const dbTest = sharedDbTest.extend<{ $test: { emptyCatalogue: void } }>({
  emptyCatalogue: [
    async ({ tx }, use) => {
      await tx.delete(ingredient);
      await use();
    },
    { auto: true },
  ],
});

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

  const request = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    token?: string,
    payload?: unknown,
  ): Promise<Response> =>
    app.inject({
      method,
      url,
      cookies: token ? { [SESSION_COOKIE]: token } : {},
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  return { request };
}

interface TestUser {
  id: number;
  token: string;
}

// A user with a signed-in session, and the session's token.
async function signedInUser(
  tx: TestTransaction,
  { isAdmin = false, locale = "en-GB" } = {},
): Promise<TestUser> {
  const [row] = await tx
    .insert(user)
    .values({
      email: `cook-${crypto.randomUUID()}@ingredient-routes.test`,
      isAdmin,
      locale,
    })
    .returning({ id: user.id });
  if (!row) throw new Error("user insert returned no row");
  const { token } = await createSession(tx, row.id);
  return { id: row.id, token };
}

// An ingredient as a seed or a user would leave it. The first name in each
// locale is canonical unless the name says otherwise.
async function newIngredient(
  tx: TestTransaction,
  names: { name: string; locale: string; isCanonical?: boolean }[],
  { createdBy = null as number | null, category = null as string | null } = {},
): Promise<number> {
  const [row] = await tx
    .insert(ingredient)
    .values({ category, createdBy, source: createdBy ? "user" : "seed" })
    .returning({ id: ingredient.id });
  if (!row) throw new Error("ingredient insert returned no row");
  const seen = new Set<string>();
  await tx.insert(ingredientName).values(
    names.map((n) => {
      const isCanonical = n.isCanonical ?? !seen.has(n.locale);
      seen.add(n.locale);
      return { ...n, ingredientId: row.id, isCanonical, createdBy };
    }),
  );
  return row.id;
}

interface PageBody {
  ingredients: {
    id: number;
    name: string | null;
    locale: string | null;
    canEdit: boolean;
    match?: { name: string; locale: string; similarity: number };
  }[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

function page(res: Response): PageBody {
  expect(res.statusCode).toBe(200);
  return res.json<PageBody>();
}

describe("signed out", () => {
  dbTest.for([
    ["GET", "/ingredients"],
    ["GET", "/ingredients?q=cor"],
    ["GET", "/ingredients/1"],
    ["POST", "/ingredients"],
    ["PATCH", "/ingredients/1"],
    ["DELETE", "/ingredients/1"],
    ["POST", "/ingredients/1/names"],
    ["PATCH", "/ingredients/1/names/1"],
    ["DELETE", "/ingredients/1/names/1"],
  ] as const)("%s %s answers 401", async ([method, url], { tx }) => {
    const { request } = start(tx);

    const res = await request(method, url, undefined, {
      names: [{ name: "basil" }],
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: "unauthenticated",
      message: "sign in required",
    });
  });
});

describe("GET /ingredients", () => {
  dbTest(
    "lists by display name: canonical in the caller's locale, else any canonical",
    async ({ tx }) => {
      const { request } = start(tx);
      const me = await signedInUser(tx, { locale: "en-US" });
      const coriander = await newIngredient(tx, [
        { name: "Coriander", locale: "en-GB" },
        { name: "cilantro", locale: "en-US" },
      ]);
      const aubergine = await newIngredient(tx, [
        { name: "aubergine", locale: "en-GB" },
      ]);
      const basil = await newIngredient(tx, [
        { name: "basil", locale: "fr-FR", isCanonical: false },
        { name: "Basil", locale: "en-GB" },
      ]);

      const body = page(await request("GET", "/ingredients", me.token));

      expect(body).toEqual({
        ingredients: [
          {
            id: aubergine,
            name: "aubergine",
            locale: "en-GB",
            category: null,
            source: "seed",
            canEdit: false,
          },
          expect.objectContaining({
            id: basil,
            name: "Basil",
            locale: "en-GB",
          }),
          expect.objectContaining({
            id: coriander,
            name: "cilantro",
            locale: "en-US",
          }),
        ],
        page: 1,
        pageSize: PAGE_SIZE,
        hasMore: false,
      });
    },
  );

  dbTest(
    "shows an en-GB user the bare en name over en-US and de",
    async ({ tx }) => {
      const { request } = start(tx);
      const me = await signedInUser(tx, { locale: "en-GB" });
      const id = await newIngredient(tx, [
        { name: "Aubergine", locale: "de" },
        { name: "eggplant", locale: "en-US" },
        { name: "aubergine", locale: "en" },
      ]);

      const body = page(await request("GET", "/ingredients", me.token));

      expect(body.ingredients).toEqual([
        expect.objectContaining({ id, name: "aubergine", locale: "en" }),
      ]);
    },
  );

  dbTest(
    "shows an en-GB user another en-* name over de, by locale code",
    async ({ tx }) => {
      const { request } = start(tx);
      const me = await signedInUser(tx, { locale: "en-GB" });
      const eggplant = await newIngredient(tx, [
        { name: "Aubergine", locale: "de" },
        { name: "eggplant", locale: "en-US" },
      ]);
      const capsicum = await newIngredient(tx, [
        { name: "Paprika", locale: "de" },
        { name: "bell pepper", locale: "en-US" },
        { name: "capsicum", locale: "en-AU" },
      ]);

      const body = page(await request("GET", "/ingredients", me.token));

      expect(body.ingredients).toEqual([
        expect.objectContaining({
          id: capsicum,
          name: "capsicum",
          locale: "en-AU",
        }),
        expect.objectContaining({
          id: eggplant,
          name: "eggplant",
          locale: "en-US",
        }),
      ]);
    },
  );

  dbTest(
    "uses the same display name in a search hit and a 409",
    async ({ tx }) => {
      const { request } = start(tx);
      const me = await signedInUser(tx, { locale: "en-GB" });
      const id = await newIngredient(tx, [
        { name: "Aubergine", locale: "de" },
        { name: "eggplant", locale: "en-US" },
      ]);

      const search = page(
        await request("GET", "/ingredients?q=auberg", me.token),
      );
      const create = await request("POST", "/ingredients", me.token, {
        names: [{ name: "aubergine", locale: "de" }],
      });

      expect(search.ingredients).toEqual([
        expect.objectContaining({
          id,
          name: "eggplant",
          locale: "en-US",
          match: expect.objectContaining({
            name: "Aubergine",
            locale: "de",
          }) as unknown,
        }),
      ]);
      expect(create.statusCode).toBe(409);
      expect(create.json()).toMatchObject({
        ingredient: { id, name: "eggplant" },
      });
    },
  );

  dbTest("pages the list", async ({ tx }) => {
    const { request } = start(tx);
    const me = await signedInUser(tx);
    for (let i = 0; i <= PAGE_SIZE; i++) {
      await newIngredient(tx, [
        { name: `herb ${String(i).padStart(2, "0")}`, locale: "en-GB" },
      ]);
    }

    const first = page(await request("GET", "/ingredients", me.token));
    const second = page(await request("GET", "/ingredients?page=2", me.token));

    expect(first.ingredients).toHaveLength(PAGE_SIZE);
    expect(first.hasMore).toBe(true);
    expect(second).toMatchObject({ page: 2, hasMore: false });
    expect(second.ingredients.map((i) => i.name)).toEqual([
      `herb ${PAGE_SIZE}`,
    ]);
  });

  dbTest(
    "userAdded=true keeps only user-created ingredients",
    async ({ tx }) => {
      const { request } = start(tx);
      const me = await signedInUser(tx);
      const author = await signedInUser(tx);
      await newIngredient(tx, [{ name: "coriander", locale: "en-GB" }]);
      const mine = await newIngredient(
        tx,
        [{ name: "corn ribs", locale: "en-GB" }],
        { createdBy: author.id },
      );

      for (const url of [
        "/ingredients?userAdded=true",
        "/ingredients?userAdded=true&q=cor",
      ]) {
        const body = page(await request("GET", url, me.token));
        expect(body.ingredients.map((i) => i.id)).toEqual([mine]);
      }
      const all = page(
        await request("GET", "/ingredients?userAdded=false", me.token),
      );
      expect(all.ingredients).toHaveLength(2);
    },
  );

  dbTest.for([
    "page=0",
    "page=-1",
    "page=1.5",
    "page=abc",
    "page=99999999999999999999",
    "userAdded=yes",
    `q=${"a".repeat(101)}`,
    "q=a&q=b",
    "q=a%00b",
    "q=%00",
    "q=cor%00&userAdded=true",
  ])("answers 400 to ?%s", async (query, { tx }) => {
    const { request } = start(tx);
    const me = await signedInUser(tx);

    const res = await request("GET", `/ingredients?${query}`, me.token);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_request" });
  });
});

describe("GET /ingredients?q=", () => {
  async function corianderAndFriends(tx: TestTransaction) {
    return {
      coriander: await newIngredient(tx, [
        { name: "coriander", locale: "en-GB" },
        { name: "cilantro", locale: "en-US" },
      ]),
      cumin: await newIngredient(tx, [{ name: "cumin", locale: "en-GB" }]),
    };
  }

  dbTest.for(["corriander", "cor", "Coriander", "  CORIANDER "])(
    "%s finds coriander",
    async (q, { tx }) => {
      const { request } = start(tx);
      const me = await signedInUser(tx);
      const { coriander } = await corianderAndFriends(tx);

      const body = page(
        await request(
          "GET",
          `/ingredients?q=${encodeURIComponent(q)}`,
          me.token,
        ),
      );

      expect(body.ingredients).toEqual([
        {
          id: coriander,
          name: "coriander",
          locale: "en-GB",
          category: null,
          source: "seed",
          canEdit: false,
          match: {
            name: "coriander",
            locale: "en-GB",
            similarity: expect.any(Number) as number,
          },
        },
      ]);
    },
  );

  dbTest(
    "finds a name in another locale, showing the ingredient's own name",
    async ({ tx }) => {
      const { request } = start(tx);
      const me = await signedInUser(tx, { locale: "en-GB" });
      const { coriander } = await corianderAndFriends(tx);

      const body = page(
        await request("GET", "/ingredients?q=cilantr", me.token),
      );

      expect(body.ingredients).toEqual([
        expect.objectContaining({
          id: coriander,
          name: "coriander",
          locale: "en-GB",
          match: expect.objectContaining({
            name: "cilantro",
            locale: "en-US",
          }) as unknown,
        }),
      ]);
    },
  );

  dbTest("ranks hits by similarity, one per ingredient", async ({ tx }) => {
    const { request } = start(tx);
    const me = await signedInUser(tx);
    const oliveOil = await newIngredient(tx, [
      { name: "olive oil", locale: "en-GB" },
    ]);
    const oil = await newIngredient(tx, [
      { name: "vegetable oil", locale: "en-GB" },
      { name: "oil", locale: "en-GB" },
    ]);
    const boiled = await newIngredient(tx, [
      { name: "boiled egg", locale: "en-GB" },
    ]);
    const oils = await newIngredient(tx, [{ name: "oils", locale: "en-GB" }]);

    const body = page(await request("GET", "/ingredients?q=oil", me.token));

    // oil and olive oil both contain the word whole; the exact name wins.
    expect(body.ingredients.map((i) => [i.id, i.match!.name])).toEqual([
      [oil, "oil"],
      [oliveOil, "olive oil"],
      [oils, "oils"],
    ]);
    expect(body.ingredients.map((i) => i.id)).not.toContain(boiled);
    const scores = body.ingredients.map((i) => i.match!.similarity);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  dbTest(
    "finds nothing for one letter or an unrelated word",
    async ({ tx }) => {
      const { request } = start(tx);
      const me = await signedInUser(tx);
      await corianderAndFriends(tx);

      for (const q of ["c", "saffron"]) {
        const body = page(
          await request("GET", `/ingredients?q=${q}`, me.token),
        );
        expect(body.ingredients).toEqual([]);
      }
    },
  );

  dbTest("a blank q lists instead", async ({ tx }) => {
    const { request } = start(tx);
    const me = await signedInUser(tx);
    await corianderAndFriends(tx);

    const body = page(await request("GET", "/ingredients?q=%20%20", me.token));

    expect(body.ingredients.map((i) => i.name)).toEqual(["coriander", "cumin"]);
    expect(body.ingredients[0]).not.toHaveProperty("match");
  });
});

describe("canEdit", () => {
  dbTest(
    "is true for the creator and an admin, false for another user",
    async ({ tx }) => {
      const { request } = start(tx);
      const creator = await signedInUser(tx);
      const other = await signedInUser(tx);
      const admin = await signedInUser(tx, { isAdmin: true });
      const theirs = await newIngredient(
        tx,
        [{ name: "sumac", locale: "en-GB" }],
        { createdBy: creator.id },
      );
      const seeded = await newIngredient(tx, [
        { name: "sumac berries", locale: "en-GB" },
      ]);

      const expected: [TestUser, { [id: number]: boolean }][] = [
        [creator, { [theirs]: true, [seeded]: false }],
        [other, { [theirs]: false, [seeded]: false }],
        [admin, { [theirs]: true, [seeded]: true }],
      ];
      for (const [who, canEdit] of expected) {
        for (const url of ["/ingredients", "/ingredients?q=sumac"]) {
          const body = page(await request("GET", url, who.token));
          expect(
            Object.fromEntries(body.ingredients.map((i) => [i.id, i.canEdit])),
          ).toEqual(canEdit);
        }
        for (const id of [theirs, seeded]) {
          const res = await request("GET", `/ingredients/${id}`, who.token);
          expect(res.json()).toMatchObject({ canEdit: canEdit[id] });
        }
      }
    },
  );
});

describe("GET /ingredients/:id", () => {
  dbTest(
    "returns every name with its locale and canonical flag, and the category",
    async ({ tx }) => {
      const { request } = start(tx);
      const me = await signedInUser(tx);
      const id = await newIngredient(
        tx,
        [
          { name: "coriander", locale: "en-GB" },
          { name: "cilantro", locale: "en-US" },
          { name: "coriander leaf", locale: "en-GB" },
        ],
        { category: "herbs" },
      );

      const res = await request("GET", `/ingredients/${id}`, me.token);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        id,
        category: "herbs",
        source: "seed",
        canEdit: false,
        names: [
          {
            id: expect.any(Number) as number,
            name: "coriander",
            locale: "en-GB",
            isCanonical: true,
          },
          {
            id: expect.any(Number) as number,
            name: "coriander leaf",
            locale: "en-GB",
            isCanonical: false,
          },
          {
            id: expect.any(Number) as number,
            name: "cilantro",
            locale: "en-US",
            isCanonical: true,
          },
        ],
      });
      expect(res.json()).not.toHaveProperty("createdBy");
    },
  );

  dbTest.for(["abc", "0", "1.5", "99999999999999999999", "9007199254740991"])(
    "returns 404 for the id %s",
    async (id, { tx }) => {
      const { request } = start(tx);
      const me = await signedInUser(tx);

      const res = await request("GET", `/ingredients/${id}`, me.token);

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        error: "not_found",
        message: "ingredient not found",
      });
    },
  );
});

// Text that is not well-formed Unicode (NATG-350). Postgres would store each
// as U+FFFD, so two different inputs would become one name.
const illFormed = [
  ["a lone high surrogate", "cor\ud800"],
  ["a lone low surrogate", "cor\udc00"],
  ["a reversed surrogate pair", "cor\udc00\ud800"],
] as const;

describe("ill-formed Unicode", () => {
  dbTest.for(illFormed)(
    "POST answers 400 to %s in a name, writing nothing",
    async ([, text], { tx }) => {
      const { request } = start(tx);
      const me = await signedInUser(tx);
      const before = await tx.select().from(ingredient);

      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await request("POST", "/ingredients", me.token, {
          names: [{ name: text }],
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ error: "invalid_request" });
      }
      expect(await tx.select().from(ingredient)).toEqual(before);
    },
  );

  dbTest.for(illFormed)(
    "POST answers 400 to %s in the category",
    async ([, text], { tx }) => {
      const { request } = start(tx);
      const me = await signedInUser(tx);

      const res = await request("POST", "/ingredients", me.token, {
        names: [{ name: "coriander" }],
        category: text,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "invalid_request" });
    },
  );

  // A query string is percent-encoded UTF-8, which cannot carry a lone
  // surrogate: Fastify leaves an undecodable escape as it is. So q is checked
  // where it is parsed, and over HTTP the escapes are just text.
  test.for(illFormed)("q refuses %s", ([, text]) => {
    expect(parseListQuery({ q: text })).toEqual({
      invalid: expect.stringContaining("q must be text") as string,
    });
  });

  dbTest(
    "GET treats percent-escaped surrogate bytes in q as text",
    async ({ tx }) => {
      const { request } = start(tx);
      const me = await signedInUser(tx);

      const body = page(
        await request("GET", "/ingredients?q=%ED%A0%80", me.token),
      );

      expect(body.ingredients).toEqual([]);
    },
  );
});

describe("POST /ingredients", () => {
  dbTest(
    "creates the ingredient and its names as the caller's, source user",
    async ({ tx }) => {
      const { request } = start(tx);
      const me = await signedInUser(tx, { locale: "en-AU" });

      const res = await request("POST", "/ingredients", me.token, {
        names: [
          { name: " Capsicum " },
          { name: "bell pepper", locale: "en-us" },
          { name: "red capsicum" },
          { name: "sweet pepper", locale: "en-US" },
        ],
        category: " vegetables ",
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<{ id: number }>();
      expect(body).toEqual({
        id: expect.any(Number) as number,
        category: "vegetables",
        source: "user",
        canEdit: true,
        names: [
          expect.objectContaining({
            name: "Capsicum",
            locale: "en-AU",
            isCanonical: true,
          }),
          expect.objectContaining({
            name: "red capsicum",
            locale: "en-AU",
            isCanonical: false,
          }),
          expect.objectContaining({
            name: "bell pepper",
            locale: "en-US",
            isCanonical: true,
          }),
          expect.objectContaining({
            name: "sweet pepper",
            locale: "en-US",
            isCanonical: false,
          }),
        ],
      });

      const [row] = await tx
        .select({ createdBy: ingredient.createdBy, source: ingredient.source })
        .from(ingredient)
        .where(eq(ingredient.id, body.id));
      expect(row).toEqual({ createdBy: me.id, source: "user" });
      const names = await tx
        .select({
          createdBy: ingredientName.createdBy,
          source: ingredientName.source,
        })
        .from(ingredientName)
        .where(eq(ingredientName.ingredientId, body.id));
      expect(names).toEqual(
        Array.from({ length: 4 }, () => ({ createdBy: me.id, source: "user" })),
      );

      const found = page(
        await request("GET", "/ingredients?q=capsic", me.token),
      );
      expect(found.ingredients.map((i) => i.id)).toEqual([body.id]);
    },
  );

  dbTest("takes no category as null", async ({ tx }) => {
    const { request } = start(tx);
    const me = await signedInUser(tx);

    const res = await request("POST", "/ingredients", me.token, {
      names: [{ name: "sumac" }],
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ category: null });
  });

  dbTest(
    "answers 409 with the ingredient that already has a name, writing nothing",
    async ({ tx }) => {
      const { request } = start(tx);
      const me = await signedInUser(tx, { locale: "en-GB" });
      const coriander = await newIngredient(tx, [
        { name: "coriander", locale: "en-GB" },
        { name: "Cilantro", locale: "en-US" },
      ]);
      const before = await tx.select().from(ingredient);

      const res = await request("POST", "/ingredients", me.token, {
        names: [
          { name: "fresh coriander" },
          { name: "  cilantro", locale: "en-US" },
        ],
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: "name_taken",
        message: 'en-US already has the name "Cilantro"',
        ingredient: { id: coriander, name: "coriander" },
        name: { name: "Cilantro", locale: "en-US" },
      });
      expect(await tx.select().from(ingredient)).toEqual(before);
    },
  );

  dbTest(
    "answers a retry of a create that succeeded with 409 naming it",
    async ({ tx }) => {
      const { request } = start(tx);
      const me = await signedInUser(tx);
      const create = { names: [{ name: "gochujang" }] };

      const first = await request("POST", "/ingredients", me.token, create);
      const retry = await request("POST", "/ingredients", me.token, create);

      expect(first.statusCode).toBe(201);
      expect(retry.statusCode).toBe(409);
      expect(retry.json()).toMatchObject({
        ingredient: { id: first.json<{ id: number }>().id, name: "gochujang" },
      });
    },
  );

  dbTest("allows the same name in another locale", async ({ tx }) => {
    const { request } = start(tx);
    const me = await signedInUser(tx);
    await newIngredient(tx, [{ name: "biscuit", locale: "en-GB" }]);

    const res = await request("POST", "/ingredients", me.token, {
      names: [{ name: "biscuit", locale: "en-US" }],
    });

    expect(res.statusCode).toBe(201);
  });

  dbTest(
    "answers 400 when two of the names are the same in one locale",
    async ({ tx }) => {
      const { request } = start(tx);
      const me = await signedInUser(tx);
      const before = await tx.select().from(ingredient);

      const res = await request("POST", "/ingredients", me.token, {
        names: [{ name: "Basil" }, { name: "basil ", locale: "en-gb" }],
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: "invalid_request",
        message: "names must not repeat a name in the same locale",
      });
      expect(await tx.select().from(ingredient)).toEqual(before);
    },
  );

  dbTest.for([
    ["a malformed locale", { names: [{ name: "basil", locale: "en_GB!" }] }],
    ["an empty locale", { names: [{ name: "basil", locale: "" }] }],
    ["a locale that is not text", { names: [{ name: "basil", locale: 1 }] }],
    ["no names", { names: [] }],
    ["no names field", { category: "herbs" }],
    ["a blank name", { names: [{ name: "   " }] }],
    ["a name with NUL", { names: [{ name: "ba\0sil" }] }],
    ["a long name", { names: [{ name: "a".repeat(101) }] }],
    [
      "too many names",
      { names: Array.from({ length: 21 }, (_, i) => ({ name: `n${i}` })) },
    ],
    ["a name that is not an object", { names: ["basil"] }],
    [
      "an unknown name field",
      { names: [{ name: "basil", isCanonical: true }] },
    ],
    ["an unknown field", { names: [{ name: "basil" }], source: "seed" }],
    ["a blank category", { names: [{ name: "basil" }], category: " " }],
    [
      "a category that is not text",
      { names: [{ name: "basil" }], category: 3 },
    ],
    ["a body that is not an object", [{ name: "basil" }]],
  ] as const)("answers 400 to %s", async ([, body], { tx }) => {
    const { request } = start(tx);
    const me = await signedInUser(tx);

    const res = await request("POST", "/ingredients", me.token, body);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_request" });
  });

  // Valid private-use tags (SEC-1): "en-x-" and six 8-letter subtags is 58.
  const sixSubtags = Array.from({ length: 6 }, () => "aaaaaaaa").join("-");
  const tag64 = `en-x-${sixSubtags}-bbbbb`;
  const tag65 = `en-x-${sixSubtags}-bbbbbb`;

  dbTest("accepts a 64-character locale and refuses 65", async ({ tx }) => {
    const { request } = start(tx);
    const me = await signedInUser(tx);
    expect([tag64.length, tag65.length]).toEqual([64, 65]);

    const ok = await request("POST", "/ingredients", me.token, {
      names: [{ name: "sumac", locale: tag64 }],
    });
    const tooLong = await request("POST", "/ingredients", me.token, {
      names: [{ name: "sumac", locale: tag65 }],
    });

    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ names: [{ locale: tag64 }] });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json()).toEqual({
      error: "invalid_request",
      message: "locale must be a BCP-47 language tag",
    });
  });

  dbTest(
    "answers 400 to a long private-use locale, writing nothing",
    async ({ tx }) => {
      const { request } = start(tx);
      const me = await signedInUser(tx);
      const subtags = Array.from({ length: 1200 }, (_, i) =>
        i.toString(36).padStart(8, "0"),
      );
      const before = await tx.select().from(ingredient);

      const res = await request("POST", "/ingredients", me.token, {
        names: [{ name: "sumac", locale: `en-x-${subtags.join("-")}` }],
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "invalid_request" });
      expect(await tx.select().from(ingredient)).toEqual(before);
    },
  );

  dbTest(
    "answers 400 when the stored profile locale it defaults to is too long",
    async ({ tx }) => {
      const { request } = start(tx);
      const me = await signedInUser(tx, { locale: tag65 });
      const before = await tx.select().from(ingredient);

      const res = await request("POST", "/ingredients", me.token, {
        names: [{ name: "sumac" }],
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: "invalid_request",
        message:
          "your profile locale is not a usable BCP-47 language tag: send a locale with each name, or change it",
      });
      expect(await tx.select().from(ingredient)).toEqual(before);
    },
  );

  dbTest("names the bad locale rule in the 400", async ({ tx }) => {
    const { request } = start(tx);
    const me = await signedInUser(tx);

    const res = await request("POST", "/ingredients", me.token, {
      names: [{ name: "basil", locale: "not a locale" }],
    });

    expect(res.json()).toEqual({
      error: "invalid_request",
      message: "locale must be a BCP-47 language tag",
    });
  });
});

interface DetailBody {
  id: number;
  category: string | null;
  canEdit: boolean;
  names: { id: number; name: string; locale: string; isCanonical: boolean }[];
}

// The ingredient and its names as stored, to show a refused write changed
// nothing.
async function stored(tx: TestTransaction, id: number) {
  return {
    ingredient: await tx.select().from(ingredient).where(eq(ingredient.id, id)),
    names: await tx
      .select()
      .from(ingredientName)
      .where(eq(ingredientName.ingredientId, id))
      .orderBy(asc(ingredientName.id)),
  };
}

async function nameIds(tx: TestTransaction, id: number) {
  const names = await tx
    .select({ id: ingredientName.id, name: ingredientName.name })
    .from(ingredientName)
    .where(eq(ingredientName.ingredientId, id));
  return Object.fromEntries(names.map((n) => [n.name, n.id]));
}

async function useInRecipe(
  tx: TestTransaction,
  ownerId: number,
  ingredientId: number,
) {
  const [row] = await tx
    .insert(recipe)
    .values({ ownerId, title: "stew" })
    .returning({ id: recipe.id });
  if (!row) throw new Error("recipe insert returned no row");
  await tx
    .insert(recipeIngredient)
    .values({ recipeId: row.id, position: 1, ingredientId });
}

describe("who may change an ingredient", () => {
  // Each write, on an ingredient with the names `${tag}` (canonical) and
  // `${tag} seeds`, both en-GB, and the status it answers when allowed.
  const writes: [
    string,
    (
      id: number,
      names: Record<string, number>,
      tag: string,
    ) => [method: "POST" | "PATCH" | "DELETE", url: string, body?: unknown],
    number,
  ][] = [
    [
      "PATCH /ingredients/:id",
      (id) => ["PATCH", `/ingredients/${id}`, { category: "spices" }],
      200,
    ],
    ["DELETE /ingredients/:id", (id) => ["DELETE", `/ingredients/${id}`], 204],
    [
      "POST /ingredients/:id/names",
      (id, _, tag) => [
        "POST",
        `/ingredients/${id}/names`,
        { name: `${tag} powder` },
      ],
      201,
    ],
    [
      "PATCH /ingredients/:id/names/:nameId rename",
      (id, names, tag) => [
        "PATCH",
        `/ingredients/${id}/names/${names[`${tag} seeds`]}`,
        { name: `${tag} pods` },
      ],
      200,
    ],
    [
      "PATCH /ingredients/:id/names/:nameId canonical",
      (id, names, tag) => [
        "PATCH",
        `/ingredients/${id}/names/${names[`${tag} seeds`]}`,
        { isCanonical: true },
      ],
      200,
    ],
    [
      "DELETE /ingredients/:id/names/:nameId",
      (id, names, tag) => [
        "DELETE",
        `/ingredients/${id}/names/${names[`${tag} seeds`]}`,
      ],
      204,
    ],
  ];

  dbTest.for(writes)(
    "%s: the creator and an admin, or only an admin for a prebuilt row",
    async ([, write, allowedStatus], { tx }) => {
      const { request } = start(tx);
      const creator = await signedInUser(tx);
      const other = await signedInUser(tx);
      const admin = await signedInUser(tx, { isAdmin: true });

      const cases: [string, TestUser, "user" | "prebuilt", boolean][] = [
        ["creator", creator, "user", true],
        ["creator", creator, "prebuilt", false],
        ["other", other, "user", false],
        ["other", other, "prebuilt", false],
        ["admin", admin, "user", true],
        ["admin", admin, "prebuilt", true],
      ];
      for (const [who, actor, kind, allowed] of cases) {
        const tag = `cardamom ${who} ${kind}`;
        const id = await newIngredient(
          tx,
          [
            { name: tag, locale: "en-GB" },
            { name: `${tag} seeds`, locale: "en-GB" },
          ],
          { createdBy: kind === "user" ? creator.id : null },
        );
        const [method, url, body] = write(id, await nameIds(tx, id), tag);
        const canEdit = (
          await request("GET", `/ingredients/${id}`, actor.token)
        ).json<DetailBody>().canEdit;
        const before = await stored(tx, id);

        const res = await request(method, url, actor.token, body);

        expect([who, kind, res.statusCode]).toEqual([
          who,
          kind,
          allowed ? allowedStatus : 403,
        ]);
        // The write and canEdit share one rule.
        expect(canEdit).toBe(allowed);
        if (!allowed) {
          expect(res.json()).toEqual({
            error: "forbidden",
            message: "only the ingredient's creator or an admin can change it",
          });
          expect(await stored(tx, id)).toEqual(before);
        }
      }
    },
  );

  dbTest("reads created_by, not source", async ({ tx }) => {
    const { request } = start(tx);
    const me = await signedInUser(tx);
    const [userSourced] = await tx
      .insert(ingredient)
      .values({ source: "user", createdBy: null })
      .returning({ id: ingredient.id });
    const [seedSourced] = await tx
      .insert(ingredient)
      .values({ source: "seed", createdBy: me.id })
      .returning({ id: ingredient.id });

    const refused = await request(
      "PATCH",
      `/ingredients/${userSourced!.id}`,
      me.token,
      { category: "spices" },
    );
    const allowed = await request(
      "PATCH",
      `/ingredients/${seedSourced!.id}`,
      me.token,
      { category: "spices" },
    );

    expect(refused.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(200);
  });

  dbTest.for([
    ["PATCH", "/ingredients/{id}", { category: "spices" }],
    ["DELETE", "/ingredients/{id}", undefined],
    ["POST", "/ingredients/{id}/names", { name: "mace" }],
    ["PATCH", "/ingredients/{id}/names/1", { isCanonical: true }],
    ["DELETE", "/ingredients/{id}/names/1", undefined],
  ] as const)(
    "%s %s answers 404 for an ingredient that is not there",
    async ([method, url, body], { tx }) => {
      const { request } = start(tx);
      const admin = await signedInUser(tx, { isAdmin: true });

      for (const id of ["abc", "0", "99999999999999999999", "999999999"]) {
        const res = await request(
          method,
          url.replace("{id}", id),
          admin.token,
          body,
        );
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({
          error: "not_found",
          message: "ingredient not found",
        });
      }
    },
  );
});

describe("PATCH /ingredients/:id", () => {
  dbTest("sets the category, and null clears it", async ({ tx }) => {
    const { request } = start(tx);
    const me = await signedInUser(tx);
    const id = await newIngredient(tx, [{ name: "sumac", locale: "en-GB" }], {
      createdBy: me.id,
    });

    const set = await request("PATCH", `/ingredients/${id}`, me.token, {
      category: " spices ",
    });
    const again = await request("PATCH", `/ingredients/${id}`, me.token, {
      category: " spices ",
    });

    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual({
      id,
      category: "spices",
      source: "user",
      canEdit: true,
      names: [expect.objectContaining({ name: "sumac", locale: "en-GB" })],
    });
    expect(again.json()).toEqual(set.json());

    const cleared = await request("PATCH", `/ingredients/${id}`, me.token, {
      category: null,
    });
    expect(cleared.json()).toMatchObject({ category: null });
  });

  dbTest.for([
    ["no category field", {}],
    ["an unknown field", { category: "spices", source: "seed" }],
    ["a blank category", { category: " " }],
    ["a long category", { category: "a".repeat(101) }],
    ["a category that is not text", { category: 3 }],
    ["a body that is not an object", ["spices"]],
  ] as const)("answers 400 to %s", async ([, body], { tx }) => {
    const { request } = start(tx);
    const me = await signedInUser(tx);
    const id = await newIngredient(tx, [{ name: "sumac", locale: "en-GB" }], {
      createdBy: me.id,
    });

    const res = await request("PATCH", `/ingredients/${id}`, me.token, body);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_request" });
  });
});

describe("POST /ingredients/:id/names", () => {
  dbTest(
    "adds the name as the caller's, canonical only if first in its locale",
    async ({ tx }) => {
      const { request } = start(tx);
      const creator = await signedInUser(tx);
      const admin = await signedInUser(tx, { isAdmin: true, locale: "en-US" });
      const id = await newIngredient(
        tx,
        [{ name: "coriander", locale: "en-GB" }],
        { createdBy: creator.id },
      );

      const synonym = await request(
        "POST",
        `/ingredients/${id}/names`,
        admin.token,
        { name: " coriander leaf ", locale: "en-gb" },
      );
      const firstInLocale = await request(
        "POST",
        `/ingredients/${id}/names`,
        admin.token,
        { name: "cilantro" },
      );

      expect(synonym.statusCode).toBe(201);
      expect(firstInLocale.statusCode).toBe(201);
      expect(firstInLocale.json<DetailBody>().names).toEqual([
        expect.objectContaining({
          name: "coriander",
          locale: "en-GB",
          isCanonical: true,
        }),
        expect.objectContaining({
          name: "coriander leaf",
          locale: "en-GB",
          isCanonical: false,
        }),
        expect.objectContaining({
          name: "cilantro",
          locale: "en-US",
          isCanonical: true,
        }),
      ]);
      const added = await tx
        .select({
          name: ingredientName.name,
          createdBy: ingredientName.createdBy,
          source: ingredientName.source,
        })
        .from(ingredientName)
        .where(eq(ingredientName.ingredientId, id))
        .orderBy(asc(ingredientName.id));
      expect(added.slice(1)).toEqual([
        { name: "coriander leaf", createdBy: admin.id, source: "user" },
        { name: "cilantro", createdBy: admin.id, source: "user" },
      ]);
    },
  );

  dbTest(
    "adds the 20th name and refuses the 21st with 409, writing nothing",
    async ({ tx }) => {
      const { request } = start(tx);
      const me = await signedInUser(tx);
      const id = await newIngredient(
        tx,
        Array.from({ length: MAX_NAMES - 1 }, (_, i) => ({
          name: `chilli ${i}`,
          locale: "en-GB",
        })),
        { createdBy: me.id },
      );

      const twentieth = await request(
        "POST",
        `/ingredients/${id}/names`,
        me.token,
        { name: "chilli 19" },
      );
      const before = await stored(tx, id);
      const twentyFirst = await request(
        "POST",
        `/ingredients/${id}/names`,
        me.token,
        { name: "chilli 20", locale: "en-US" },
      );
      const retry = await request(
        "POST",
        `/ingredients/${id}/names`,
        me.token,
        { name: "chilli 19" },
      );

      expect(MAX_NAMES).toBe(20);
      expect(twentieth.statusCode).toBe(201);
      expect(twentieth.json<DetailBody>().names).toHaveLength(20);
      expect(twentyFirst.statusCode).toBe(409);
      expect(twentyFirst.json()).toEqual({
        error: "name_limit",
        message: "an ingredient can have at most 20 names: delete one first",
      });
      // A retry of the add that filled it still names the ingredient.
      expect(retry.statusCode).toBe(409);
      expect(retry.json()).toMatchObject({
        error: "name_taken",
        ingredient: { id },
      });
      expect(await stored(tx, id)).toEqual(before);
    },
  );

  dbTest(
    "answers 409 with the ingredient that has the name, and to a retry",
    async ({ tx }) => {
      const { request } = start(tx);
      const me = await signedInUser(tx);
      const coriander = await newIngredient(tx, [
        { name: "Coriander", locale: "en-GB" },
      ]);
      const id = await newIngredient(
        tx,
        [{ name: "parsley", locale: "en-GB" }],
        {
          createdBy: me.id,
        },
      );
      const before = await stored(tx, id);

      const clash = await request(
        "POST",
        `/ingredients/${id}/names`,
        me.token,
        {
          name: "coriander ",
        },
      );

      expect(clash.statusCode).toBe(409);
      expect(clash.json()).toEqual({
        error: "name_taken",
        message: 'en-GB already has the name "Coriander"',
        ingredient: { id: coriander, name: "Coriander" },
        name: { name: "Coriander", locale: "en-GB" },
      });
      expect(await stored(tx, id)).toEqual(before);

      const add = { name: "flat-leaf parsley" };
      const first = await request(
        "POST",
        `/ingredients/${id}/names`,
        me.token,
        add,
      );
      const retry = await request(
        "POST",
        `/ingredients/${id}/names`,
        me.token,
        add,
      );
      expect(first.statusCode).toBe(201);
      expect(retry.statusCode).toBe(409);
      expect(retry.json()).toMatchObject({
        ingredient: { id, name: "parsley" },
      });
    },
  );

  dbTest.for([
    ["a malformed locale", { name: "mace", locale: "en_GB!" }],
    ["a locale that is not text", { name: "mace", locale: 1 }],
    ["a blank name", { name: "  " }],
    ["a name with NUL", { name: "ma\0ce" }],
    ["a long name", { name: "a".repeat(101) }],
    ["an unknown field", { name: "mace", isCanonical: true }],
    ["a list of names", { names: [{ name: "mace" }] }],
  ] as const)("answers 400 to %s", async ([, body], { tx }) => {
    const { request } = start(tx);
    const me = await signedInUser(tx);
    const id = await newIngredient(tx, [{ name: "nutmeg", locale: "en-GB" }], {
      createdBy: me.id,
    });

    const res = await request(
      "POST",
      `/ingredients/${id}/names`,
      me.token,
      body,
    );

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_request" });
  });
});

describe("PATCH /ingredients/:id/names/:nameId", () => {
  dbTest(
    "makes a name canonical, unsetting the old one in that locale only",
    async ({ tx }) => {
      const { request } = start(tx);
      const me = await signedInUser(tx);
      const id = await newIngredient(
        tx,
        [
          { name: "coriander", locale: "en-GB" },
          { name: "coriander leaf", locale: "en-GB" },
          { name: "cilantro", locale: "en-US" },
        ],
        { createdBy: me.id },
      );
      const names = await nameIds(tx, id);

      const res = await request(
        "PATCH",
        `/ingredients/${id}/names/${names["coriander leaf"]}`,
        me.token,
        { isCanonical: true },
      );
      const again = await request(
        "PATCH",
        `/ingredients/${id}/names/${names["coriander leaf"]}`,
        me.token,
        { isCanonical: true },
      );

      expect(res.statusCode).toBe(200);
      expect(res.json<DetailBody>().names).toEqual([
        expect.objectContaining({ name: "coriander leaf", isCanonical: true }),
        expect.objectContaining({ name: "coriander", isCanonical: false }),
        expect.objectContaining({ name: "cilantro", isCanonical: true }),
      ]);
      expect(again.json()).toEqual(res.json());
    },
  );

  dbTest("renames a name, and can make it canonical too", async ({ tx }) => {
    const { request } = start(tx);
    const me = await signedInUser(tx);
    const id = await newIngredient(
      tx,
      [
        { name: "aubergine", locale: "en-GB" },
        { name: "egg plant", locale: "en-GB" },
      ],
      { createdBy: me.id },
    );
    const names = await nameIds(tx, id);

    const recased = await request(
      "PATCH",
      `/ingredients/${id}/names/${names.aubergine}`,
      me.token,
      { name: "Aubergine" },
    );
    const both = await request(
      "PATCH",
      `/ingredients/${id}/names/${names["egg plant"]}`,
      me.token,
      { name: " eggplant ", isCanonical: true },
    );

    expect(recased.statusCode).toBe(200);
    expect(recased.json<DetailBody>().names).toEqual([
      expect.objectContaining({ name: "Aubergine", isCanonical: true }),
      expect.objectContaining({ name: "egg plant", isCanonical: false }),
    ]);
    expect(both.statusCode).toBe(200);
    expect(both.json<DetailBody>().names).toEqual([
      {
        id: names["egg plant"],
        name: "eggplant",
        locale: "en-GB",
        isCanonical: true,
      },
      expect.objectContaining({ name: "Aubergine", isCanonical: false }),
    ]);
  });

  dbTest(
    "answers 409 to a rename onto a name already in the locale, changing nothing",
    async ({ tx }) => {
      const { request } = start(tx);
      const me = await signedInUser(tx);
      const coriander = await newIngredient(tx, [
        { name: "coriander", locale: "en-GB" },
      ]);
      const id = await newIngredient(
        tx,
        [
          { name: "parsley", locale: "en-GB" },
          { name: "persil", locale: "en-GB" },
        ],
        { createdBy: me.id },
      );
      const names = await nameIds(tx, id);
      const before = await stored(tx, id);

      const other = await request(
        "PATCH",
        `/ingredients/${id}/names/${names.persil}`,
        me.token,
        { name: "Coriander", isCanonical: true },
      );
      const own = await request(
        "PATCH",
        `/ingredients/${id}/names/${names.persil}`,
        me.token,
        { name: "PARSLEY" },
      );

      expect(other.statusCode).toBe(409);
      expect(other.json()).toEqual({
        error: "name_taken",
        message: 'en-GB already has the name "coriander"',
        ingredient: { id: coriander, name: "coriander" },
        name: { name: "coriander", locale: "en-GB" },
      });
      expect(own.statusCode).toBe(409);
      expect(own.json()).toMatchObject({ ingredient: { id } });
      expect(await stored(tx, id)).toEqual(before);
    },
  );

  dbTest(
    "answers 404 for a name of another ingredient, or none",
    async ({ tx }) => {
      const { request } = start(tx);
      const admin = await signedInUser(tx, { isAdmin: true });
      const id = await newIngredient(tx, [{ name: "mace", locale: "en-GB" }]);
      const other = await newIngredient(tx, [
        { name: "nutmeg", locale: "en-GB" },
      ]);
      const { nutmeg } = await nameIds(tx, other);

      for (const nameId of [String(nutmeg), "abc", "0", "999999999"]) {
        const patch = await request(
          "PATCH",
          `/ingredients/${id}/names/${nameId}`,
          admin.token,
          { isCanonical: true },
        );
        const del = await request(
          "DELETE",
          `/ingredients/${id}/names/${nameId}`,
          admin.token,
        );
        for (const res of [patch, del]) {
          expect(res.statusCode).toBe(404);
          expect(res.json()).toEqual({
            error: "not_found",
            message: "name not found",
          });
        }
      }
      expect(await nameIds(tx, other)).toEqual({ nutmeg });
    },
  );

  dbTest.for([
    ["an empty body", {}],
    ["isCanonical false", { isCanonical: false }],
    ["a blank name", { name: " " }],
    ["a long name", { name: "a".repeat(101) }],
    ["a locale", { name: "mace", locale: "en-US" }],
    ["a body that is not an object", ["mace"]],
  ] as const)("answers 400 to %s", async ([, body], { tx }) => {
    const { request } = start(tx);
    const me = await signedInUser(tx);
    const id = await newIngredient(tx, [{ name: "mace", locale: "en-GB" }], {
      createdBy: me.id,
    });
    const { mace } = await nameIds(tx, id);

    const res = await request(
      "PATCH",
      `/ingredients/${id}/names/${mace}`,
      me.token,
      body,
    );

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_request" });
  });
});

describe("DELETE /ingredients/:id/names/:nameId", () => {
  dbTest("refuses the last name with 409, keeping it", async ({ tx }) => {
    const { request } = start(tx);
    const me = await signedInUser(tx);
    const id = await newIngredient(tx, [{ name: "mace", locale: "en-GB" }], {
      createdBy: me.id,
    });
    const { mace } = await nameIds(tx, id);

    const res = await request(
      "DELETE",
      `/ingredients/${id}/names/${mace}`,
      me.token,
    );

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: "last_name",
      message:
        "an ingredient's last name cannot be deleted: delete the ingredient instead",
    });
    expect(await nameIds(tx, id)).toEqual({ mace });
  });

  dbTest(
    "deleting the canonical name makes the next in its locale canonical",
    async ({ tx }) => {
      const { request } = start(tx);
      const me = await signedInUser(tx);
      const id = await newIngredient(
        tx,
        [
          { name: "coriander", locale: "en-GB" },
          { name: "coriander leaf", locale: "en-GB" },
          { name: "chinese parsley", locale: "en-GB" },
          { name: "cilantro", locale: "en-US" },
        ],
        { createdBy: me.id },
      );
      const names = await nameIds(tx, id);

      const res = await request(
        "DELETE",
        `/ingredients/${id}/names/${names.coriander}`,
        me.token,
      );
      const retry = await request(
        "DELETE",
        `/ingredients/${id}/names/${names.coriander}`,
        me.token,
      );

      expect(res.statusCode).toBe(204);
      expect(retry.statusCode).toBe(404);
      const after = await request("GET", `/ingredients/${id}`, me.token);
      expect(after.json<DetailBody>().names).toEqual([
        expect.objectContaining({ name: "chinese parsley", isCanonical: true }),
        expect.objectContaining({ name: "coriander leaf", isCanonical: false }),
        expect.objectContaining({ name: "cilantro", isCanonical: true }),
      ]);
    },
  );

  dbTest(
    "deleting a locale's only name leaves the other locales as they were",
    async ({ tx }) => {
      const { request } = start(tx);
      const me = await signedInUser(tx);
      const id = await newIngredient(
        tx,
        [
          { name: "coriander", locale: "en-GB" },
          { name: "cilantro", locale: "en-US" },
        ],
        { createdBy: me.id },
      );
      const names = await nameIds(tx, id);

      const res = await request(
        "DELETE",
        `/ingredients/${id}/names/${names.cilantro}`,
        me.token,
      );

      expect(res.statusCode).toBe(204);
      const after = await request("GET", `/ingredients/${id}`, me.token);
      expect(after.json<DetailBody>().names).toEqual([
        expect.objectContaining({ name: "coriander", isCanonical: true }),
      ]);
    },
  );
});

describe("DELETE /ingredients/:id", () => {
  dbTest("deletes the ingredient and its names", async ({ tx }) => {
    const { request } = start(tx);
    const me = await signedInUser(tx);
    const id = await newIngredient(
      tx,
      [
        { name: "mace", locale: "en-GB" },
        { name: "mace blade", locale: "en-GB" },
      ],
      { createdBy: me.id },
    );

    const res = await request("DELETE", `/ingredients/${id}`, me.token);
    const retry = await request("DELETE", `/ingredients/${id}`, me.token);

    expect(res.statusCode).toBe(204);
    expect(retry.statusCode).toBe(404);
    expect(await stored(tx, id)).toEqual({ ingredient: [], names: [] });
  });

  dbTest(
    "refuses with 409 when a recipe uses it, keeping it",
    async ({ tx }) => {
      const { request } = start(tx);
      const creator = await signedInUser(tx);
      const cook = await signedInUser(tx);
      const admin = await signedInUser(tx, { isAdmin: true });
      const id = await newIngredient(tx, [{ name: "mace", locale: "en-GB" }], {
        createdBy: creator.id,
      });
      await useInRecipe(tx, cook.id, id);
      const before = await stored(tx, id);

      for (const who of [creator, admin]) {
        const res = await request("DELETE", `/ingredients/${id}`, who.token);
        expect(res.statusCode).toBe(409);
        expect(res.json()).toEqual({
          error: "in_use",
          message: "a recipe uses this ingredient, so it cannot be deleted",
        });
      }
      expect(await stored(tx, id)).toEqual(before);
    },
  );
});
