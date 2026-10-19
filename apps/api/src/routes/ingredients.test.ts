import { eq } from "drizzle-orm";
import type { LightMyRequestResponse as Response } from "fastify";
import { describe, expect, onTestFinished } from "vitest";
import { buildApp } from "../app.js";
import { createSession } from "../auth/accounts.js";
import { PAGE_SIZE } from "../db/ingredients.js";
import { ingredient, ingredientName, user } from "../db/schema.js";
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

  const request = (
    method: "GET" | "POST",
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
