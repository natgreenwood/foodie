import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportPreview } from "./ImportPreview";

function respondWith(status: number, body: unknown) {
  return Promise.resolve(Response.json(body, { status }));
}

// Shaped like the 200 in the NATG-245 contract.
const preview = {
  sourceUrl: "https://example.com/pancakes",
  fetchedAt: "2026-10-16T12:00:00Z",
  fetchStrategy: "impit",
  extraction: "json-ld",
  warnings: ["multiple_recipes_found"],
  recipe: {
    title: "Buttermilk pancakes",
    servings: 4,
    prepMinutes: 15,
    cookMinutes: 90,
    ingredients: [
      {
        position: 1,
        rawText: "1 1/2 cups plain flour, sifted",
        quantity: "1.5",
        quantityText: "1 1/2",
        unit: { measurementId: 9, key: "cup_us" },
        unitText: "cups",
        ingredientText: "plain flour",
        prepNotes: "sifted",
        notes: null,
        section: null,
        flags: [],
      },
      {
        position: 2,
        rawText: "salt to taste",
        quantity: null,
        quantityText: null,
        unit: null,
        unitText: null,
        ingredientText: "salt to taste",
        prepNotes: null,
        notes: null,
        section: null,
        flags: ["no_quantity", "something_new"],
      },
    ],
    steps: [
      { position: 1, text: "Whisk everything together." },
      { position: 2, text: "Fry in a hot pan." },
    ],
    tags: ["Breakfast", "Vegetarian"],
  },
};

async function importUrl(url = "https://example.com/pancakes") {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Recipe page address"), url);
  await user.click(screen.getByRole("button", { name: "Import" }));
  return user;
}

describe("ImportPreview", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("posts the url and renders the returned draft read-only", async () => {
    const fetchMock = vi.fn(() => respondWith(200, preview));
    vi.stubGlobal("fetch", fetchMock);
    render(<ImportPreview />);

    await importUrl();

    expect(
      await screen.findByRole("heading", { name: "Buttermilk pancakes" }),
    ).toBeDefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/imports/preview",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ url: "https://example.com/pancakes" }),
      }),
    );

    expect(
      screen.getByText(
        "This page had more than one recipe; we imported the first.",
      ),
    ).toBeDefined();
    expect(screen.getByText("4")).toBeDefined();
    expect(screen.getByText("15 min")).toBeDefined();
    expect(screen.getByText("1 h 30 min")).toBeDefined();

    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows.map((row) => row.textContent)).toEqual([
      "QuantityUnitIngredientPrep notesFlags",
      "1 1/2cupsplain floursifted",
      "——salt to taste—No quantitysomething_new",
    ]);

    const steps = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(steps).toEqual(
      expect.arrayContaining([
        "Whisk everything together.",
        "Fry in a hot pan.",
        "Breakfast",
        "Vegetarian",
      ]),
    );

    expect(screen.getByText("Structured data (JSON-LD)")).toBeDefined();
    expect(screen.getByText("Browser-like fetch (impit)")).toBeDefined();
    expect(
      screen.getByRole("link", { name: "https://example.com/pancakes" }),
    ).toBeDefined();

    // Read-only: nothing to edit or save in the draft.
    const draft = screen.getByRole("article");
    expect(within(draft).queryByRole("textbox")).toBeNull();
    expect(within(draft).queryByRole("button")).toBeNull();
  });

  function respondWithIngredients(ingredients: unknown[]) {
    vi.stubGlobal("fetch", () =>
      respondWith(200, {
        ...preview,
        recipe: { ...preview.recipe, ingredients },
      }),
    );
  }

  // NATG-262: the parser keeps the rest of a mixed amount in notes.
  it("shows an ingredient's notes so a mixed amount is not lost", async () => {
    respondWithIngredients([
      {
        position: 1,
        rawText: "1 lb 4 oz chicken",
        quantity: "1",
        quantityText: "1",
        unit: { measurementId: 1, key: "pound" },
        unitText: "lb",
        ingredientText: "chicken",
        prepNotes: null,
        notes: "1 lb 4 oz chicken",
        section: null,
        flags: ["mixed_amount"],
      },
    ]);
    render(<ImportPreview />);

    await importUrl();

    expect(await screen.findByText(/1 lb 4 oz/)).toBeDefined();
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows[1]?.textContent).toBe(
      "1lbchickenNote: 1 lb 4 oz chicken—Mixed amount",
    );
  });

  // NATG-263: group headers on the page arrive as each line's section.
  it("groups ingredients under their section headings", async () => {
    const sugar = {
      rawText: "1 cup sugar",
      quantity: "1",
      quantityText: "1",
      unit: { measurementId: 9, key: "cup_us" },
      unitText: "cup",
      ingredientText: "sugar",
      prepNotes: null,
      notes: null,
      flags: [],
    };
    respondWithIngredients([
      { ...sugar, position: 1, section: "For the cake" },
      { ...sugar, position: 2, section: "For the icing" },
    ]);
    render(<ImportPreview />);

    await importUrl();

    const table = await screen.findByRole("table");
    expect(
      within(table)
        .getAllByRole("row")
        .map((row) => row.textContent),
    ).toEqual([
      "QuantityUnitIngredientPrep notesFlags",
      "For the cake",
      "1cupsugar—",
      "For the icing",
      "1cupsugar—",
    ]);
  });

  it("labels the unit_ambiguous flag and accepts a unit without a key", async () => {
    respondWithIngredients([
      {
        position: 1,
        rawText: "1 c milk",
        quantity: "1",
        quantityText: "1",
        unit: { measurementId: 9, key: null },
        unitText: "c",
        ingredientText: "milk",
        prepNotes: null,
        notes: null,
        section: null,
        flags: ["unit_ambiguous"],
      },
    ]);
    render(<ImportPreview />);

    await importUrl();

    expect(await screen.findByText("Unit ambiguous")).toBeDefined();
  });

  it("says when the page lists no ingredients, steps or tags", async () => {
    vi.stubGlobal("fetch", () =>
      respondWith(200, {
        ...preview,
        warnings: [],
        recipe: {
          ...preview.recipe,
          servings: null,
          prepMinutes: null,
          cookMinutes: null,
          ingredients: [],
          steps: [],
          tags: [],
        },
      }),
    );
    render(<ImportPreview />);

    await importUrl();

    expect(
      await screen.findByText("The page lists no ingredients."),
    ).toBeDefined();
    expect(screen.getByText("The page lists no steps.")).toBeDefined();
    expect(screen.getByText("No tags.")).toBeDefined();
    expect(screen.getAllByText("Not given")).toHaveLength(3);
    expect(screen.queryByText(/more than one recipe/)).toBeNull();
  });

  it("shows progress while the preview is on its way", async () => {
    let resolve: (res: Response) => void = () => {};
    vi.stubGlobal("fetch", () => new Promise<Response>((r) => (resolve = r)));
    render(<ImportPreview />);

    await importUrl();

    expect(screen.getByRole("status").textContent).toBe("Fetching the recipe…");
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Import" })
        .disabled,
    ).toBe(true);

    resolve(Response.json(preview));
    expect(
      await screen.findByRole("heading", { name: "Buttermilk pancakes" }),
    ).toBeDefined();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each([
    [400, { error: "invalid_url" }, "That doesn't look like a web address"],
    [
      404,
      { error: "no_recipe_found" },
      "We couldn't find a recipe on that page",
    ],
    [
      451,
      { error: "import_not_permitted" },
      "This site does not permit importing its recipes",
    ],
  ])("renders HTTP %i %o as its own message", async (status, body, message) => {
    vi.stubGlobal("fetch", () =>
      respondWith(status, { ...body, message: "x", url: "y" }),
    );
    render(<ImportPreview />);

    await importUrl();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(message);
  });

  it.each([
    [
      "unreachable",
      "The site didn't respond. Check the address, or try later.",
    ],
    ["blocked", "The site refused our request."],
    ["challenged", "The site asked for a human check that we can't complete."],
    ["http_error", "The site answered with an error instead of the page."],
    ["not_html", "Reason: not_html"],
  ])("renders fetch_failed with reason %s", async (reason, detail) => {
    vi.stubGlobal("fetch", () =>
      respondWith(422, {
        error: "fetch_failed",
        reason,
        message: "x",
        url: "y",
      }),
    );
    render(<ImportPreview />);

    await importUrl();

    const alert = await screen.findByRole("alert");
    expect(
      within(alert).getByText("We couldn't fetch that page"),
    ).toBeDefined();
    expect(within(alert).getByText(detail)).toBeDefined();
  });

  it("explains when the api itself cannot be reached", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", () => respondWith(502, { message: "Bad Gateway" }));
    render(<ImportPreview />);

    await importUrl();

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Can't reach the API: the server answered with HTTP 502/,
    );
  });

  it("fetches the same url again with refresh: true", async () => {
    const fetchMock = vi.fn(() => respondWith(200, preview));
    vi.stubGlobal("fetch", fetchMock);
    render(<ImportPreview />);

    const user = await importUrl();
    await screen.findByRole("heading", { name: "Buttermilk pancakes" });

    await user.click(screen.getByRole("button", { name: "Fetch again" }));

    await screen.findByRole("heading", { name: "Buttermilk pancakes" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/imports/preview",
      expect.objectContaining({
        body: JSON.stringify({
          url: "https://example.com/pancakes",
          refresh: true,
        }),
      }),
    );
  });
});
