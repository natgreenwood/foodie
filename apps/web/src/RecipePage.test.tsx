import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecipePage, recipeIdFrom } from "./RecipePage";

function respondWith(status: number, body: unknown) {
  return Promise.resolve(Response.json(body, { status }));
}

const units = [
  {
    id: 3,
    key: "teaspoon",
    type: "volume",
    names: [
      {
        locale: "en-GB",
        name: "teaspoon",
        abbreviation: "tsp",
        isCanonical: true,
      },
    ],
  },
  {
    id: 20,
    key: "clove",
    type: "count",
    names: [
      { locale: "en-GB", name: "clove", abbreviation: null, isCanonical: true },
    ],
  },
  {
    // No en-GB name: shown by its en-US one.
    id: 21,
    key: null,
    type: "count",
    names: [
      { locale: "en-US", name: "stick", abbreviation: null, isCanonical: true },
    ],
  },
];

// GET /recipes/:id as NATG-370 extends it.
const recipe = {
  id: 12,
  title: "Chicken adobo",
  sourceUrl: "https://www.example.com/recipes/chicken-adobo?ref=x",
  servings: 4,
  prepMinutes: 15,
  cookMinutes: 70,
  createdAt: "2026-10-19T09:12:04Z",
  updatedAt: "2026-10-19T09:12:04Z",
  ingredients: [
    {
      position: 1,
      ingredient: { id: 1, name: "chicken thigh, boneless", locale: "en-GB" },
      measurementId: null,
      quantity: null,
      prepNotes: null,
      notes: "1 lb 4 oz boneless chicken thighs",
    },
    {
      position: 2,
      ingredient: { id: 2, name: "garlic", locale: "en-GB" },
      measurementId: 20,
      quantity: "6",
      prepNotes: "crushed",
      notes: null,
    },
    {
      position: 3,
      ingredient: { id: 3, name: "black peppercorns", locale: "en-GB" },
      measurementId: 3,
      quantity: "1.5",
      prepNotes: null,
      notes: null,
    },
    {
      position: 4,
      ingredient: { id: 4, name: "butter", locale: "en-US" },
      measurementId: 21,
      quantity: "1",
      prepNotes: null,
      notes: null,
    },
  ],
  steps: [
    { position: 1, text: "Put everything in a pan." },
    { position: 2, text: "Simmer for 40 minutes." },
  ],
  tags: ["Filipino", "dinner"],
};

function stubApi(recipeResponse: () => Promise<Response>) {
  const fetchMock = vi.fn((input: string) => {
    if (input === "/api/recipes/12") return recipeResponse();
    if (input === "/api/measurements") {
      return respondWith(200, { measurements: units });
    }
    throw new Error(`unexpected request: ${input}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("RecipePage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  it("reads the id from /recipes/:id paths only", () => {
    expect(recipeIdFrom("/recipes/12")).toBe(12);
    expect(recipeIdFrom("/recipes/012")).toBeNull();
    expect(recipeIdFrom("/recipes/12/edit")).toBeNull();
    expect(recipeIdFrom("/recipes/99999999999999999999")).toBeNull();
    expect(recipeIdFrom("/recipes")).toBeNull();
  });

  it("shows the recipe: facts, a flat ingredient list, steps, tags and source", async () => {
    stubApi(() => respondWith(200, recipe));
    render(<RecipePage id={12} locale="en-GB" />);

    expect(screen.getByRole("status").textContent).toBe("Loading the recipe…");
    expect(
      await screen.findByRole("heading", { name: "Chicken adobo" }),
    ).toBeDefined();
    expect(screen.getByText("1 h 10 min")).toBeDefined();
    expect(screen.queryByText("Recipe saved.")).toBeNull();

    const list = screen.getAllByRole("list")[0]!;
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      // No quantity and no unit: the amount is empty, the notes keep it.
      "chicken thigh, boneless1 lb 4 oz boneless chicken thighs",
      // No abbreviation: the unit's name, not pluralised.
      "6 clovegarlic, crushed",
      "1.5 tspblack peppercorns",
      // No name in the user's locale: its name in another.
      "1 stickbutter",
    ]);

    expect(screen.getByText("Put everything in a pan.")).toBeDefined();
    expect(screen.getByText("Filipino")).toBeDefined();
    const page = screen.getByRole("link", {
      name: "www.example.com/recipes/chicken-adobo",
    });
    expect(page.getAttribute("href")).toBe(recipe.sourceUrl);
    expect(page.getAttribute("target")).toBeNull();
    expect(screen.getByText("19 October 2026")).toBeDefined();
    expect(
      screen.getByRole("link", { name: "Import another recipe" }),
    ).toBeDefined();
  });

  it("leaves out facts and tags it does not have", async () => {
    stubApi(() =>
      respondWith(200, {
        ...recipe,
        servings: null,
        prepMinutes: null,
        cookMinutes: 30,
        tags: [],
      }),
    );
    render(<RecipePage id={12} locale="en-GB" />);

    await screen.findByRole("heading", { name: "Chicken adobo" });
    expect(screen.queryByText("Servings")).toBeNull();
    expect(screen.queryByText("Prep time")).toBeNull();
    expect(screen.getByText("Cook time")).toBeDefined();
    expect(screen.queryByRole("heading", { name: "Tags" })).toBeNull();
  });

  it("says it was saved, focused, on arrival from a save, and not on reload", async () => {
    stubApi(() => respondWith(200, recipe));
    window.history.replaceState(
      { saved: true, alreadyImported: false },
      "",
      "/recipes/12",
    );
    render(<RecipePage id={12} locale="en-GB" />);

    const saved = await screen.findByText("Recipe saved.");
    expect(saved.getAttribute("role")).toBe("status");
    expect(document.activeElement).toBe(saved);
    expect(screen.queryByText(/imported this page before/)).toBeNull();
    // The entry no longer carries it, so a reload shows the plain page.
    expect(window.history.state).toBeNull();

    cleanup();
    render(<RecipePage id={12} locale="en-GB" />);
    await screen.findByRole("heading", { name: "Chicken adobo" });
    expect(screen.queryByText("Recipe saved.")).toBeNull();
  });

  it("says when the page had been imported before", async () => {
    stubApi(() => respondWith(200, recipe));
    window.history.replaceState(
      { saved: true, alreadyImported: true },
      "",
      "/recipes/12",
    );
    render(<RecipePage id={12} locale="en-GB" />);

    expect(
      await screen.findByText(
        "You had imported this page before. This is a second copy; the earlier recipe is unchanged.",
      ),
    ).toBeDefined();
  });

  it("says when there is no such recipe", async () => {
    stubApi(() =>
      respondWith(404, { error: "not_found", message: "recipe not found" }),
    );
    render(<RecipePage id={12} locale="en-GB" />);

    expect(
      await screen.findByRole("heading", { name: "Recipe not found" }),
    ).toBeDefined();
    expect(screen.getByRole("alert").textContent).toMatch(
      /There is no recipe of yours at this address/,
    );
    expect(screen.getByRole("link", { name: "Import a recipe" })).toBeDefined();
  });

  it("explains when the api cannot be reached, and tries again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    stubApi(() =>
      fail
        ? respondWith(502, { message: "Bad Gateway" })
        : respondWith(200, recipe),
    );
    render(<RecipePage id={12} locale="en-GB" />);

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Can't reach the API: the server answered with HTTP 502. Check the api container is running (docker compose ps), then try again.",
    );

    fail = false;
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("heading", { name: "Chicken adobo" }),
    ).toBeDefined();
  });
});
