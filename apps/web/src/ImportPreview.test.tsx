import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportPreview } from "./ImportPreview";

function respondWith(status: number, body: unknown) {
  return Promise.resolve(Response.json(body, { status }));
}

// Shaped like GET /measurements (NATG-339).
const units = [
  {
    id: 1,
    key: "pound",
    type: "mass",
    names: [
      { locale: "en-GB", name: "pound", abbreviation: "lb", isCanonical: true },
    ],
  },
  {
    id: 2,
    key: "gram",
    type: "mass",
    names: [
      { locale: "en-GB", name: "gram", abbreviation: "g", isCanonical: true },
    ],
  },
  {
    id: 9,
    key: "cup_us",
    type: "volume",
    names: [
      {
        locale: "en-GB",
        name: "cup (US)",
        abbreviation: null,
        isCanonical: true,
      },
    ],
  },
  {
    id: 12,
    key: "tablespoon",
    type: "volume",
    names: [
      {
        locale: "en-GB",
        name: "tablespoon",
        abbreviation: "tbsp",
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
];

const flour = {
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
  ingredientId: 31,
  candidates: [
    { ingredientId: 31, name: "plain flour", locale: "en-GB", similarity: 1 },
  ],
};

const salt = {
  position: 2,
  rawText: "salt to taste",
  quantity: null,
  quantityText: null,
  unit: null,
  unitText: null,
  ingredientText: "salt",
  prepNotes: null,
  notes: "to taste",
  section: null,
  flags: ["no_quantity", "something_new"],
  ingredientId: 40,
  candidates: [
    { ingredientId: 40, name: "salt", locale: "en-GB", similarity: 1 },
  ],
};

const gochujang = {
  position: 3,
  rawText: "1 tbsp gochujang",
  quantity: "1",
  quantityText: "1",
  unit: { measurementId: 12, key: "tablespoon" },
  unitText: "tbsp",
  ingredientText: "gochujang",
  prepNotes: null,
  notes: null,
  section: null,
  flags: ["ingredient_unmatched"],
  ingredientId: null,
  candidates: [
    { ingredientId: 50, name: "gochugaru", locale: "en-US", similarity: 0.5 },
    {
      ingredientId: 51,
      name: "chilli paste",
      locale: "en-GB",
      similarity: 0.3,
    },
  ],
};

// Shaped like the 200 in the NATG-245 contract, with NATG-321's matching.
const preview = {
  sourceUrl: "https://example.co.uk/pancakes",
  fetchedAt: "2026-10-16T12:00:00Z",
  fetchStrategy: "impit",
  extraction: "json-ld",
  warnings: ["multiple_recipes_found"],
  recipe: {
    title: "Buttermilk pancakes",
    servings: 4,
    prepMinutes: 15,
    cookMinutes: 90,
    ingredients: [flour, salt],
    steps: [
      { position: 1, text: "Whisk everything together." },
      { position: 2, text: "Fry in a hot pan." },
    ],
    tags: ["Breakfast", "Vegetarian"],
  },
  ingredientMatching: { status: "ok" },
};

type Handler = (init?: RequestInit) => Promise<Response>;

// Answers each "METHOD /path" from `routes`; anything else fails the test.
function stubApi(routes: Record<string, Handler>) {
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${input}`;
    const handler: Handler | undefined = {
      "GET /api/measurements": () => respondWith(200, { measurements: units }),
      ...routes,
    }[key];
    if (!handler) throw new Error(`unexpected request: ${key}`);
    return handler(init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function previewOf(ingredients: unknown[], extra: object = {}) {
  return {
    "POST /api/imports/preview": () =>
      respondWith(200, {
        ...preview,
        ...extra,
        recipe: { ...preview.recipe, ingredients },
      }),
  };
}

function bodyOf(fetchMock: ReturnType<typeof stubApi>, key: string): unknown {
  const call = fetchMock.mock.calls.findLast(
    ([input, init]) => `${init?.method ?? "GET"} ${input}` === key,
  );
  const body = call?.[1]?.body;
  return typeof body === "string" ? JSON.parse(body) : undefined;
}

async function importUrl(url = "https://example.co.uk/pancakes") {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Recipe page address"), url);
  await user.click(screen.getByRole("button", { name: "Import" }));
  return user;
}

function line(position: number) {
  const li = document.getElementById(`line-${position}`);
  if (!li) throw new Error(`no line ${position}`);
  return within(li);
}

function saveButton() {
  return screen.getByRole<HTMLButtonElement>("button", { name: "Save recipe" });
}

describe("ImportPreview", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  it("posts the url and shows each line's proposed ingredient, unit and quantity, editable", async () => {
    const fetchMock = stubApi(previewOf([flour, salt]));
    render(<ImportPreview locale="en-GB" />);

    await importUrl();

    expect(
      await screen.findByRole("heading", { name: "Buttermilk pancakes" }),
    ).toBeDefined();
    expect(bodyOf(fetchMock, "POST /api/imports/preview")).toEqual({
      url: "https://example.co.uk/pancakes",
    });

    expect(
      screen.getByText(
        "This page had more than one recipe; we imported the first.",
      ),
    ).toBeDefined();
    expect(screen.getByText("15 min")).toBeDefined();
    expect(screen.getByText("1 h 30 min")).toBeDefined();

    const sifted = line(1);
    expect(sifted.getByText("1 1/2 cups plain flour, sifted")).toBeDefined();
    expect(sifted.getByText("Ready")).toBeDefined();
    expect(
      sifted.getByLabelText<HTMLInputElement>(
        "Quantity for 1 1/2 cups plain flour, sifted",
      ).value,
    ).toBe("1.5");
    const unit = sifted.getByLabelText<HTMLSelectElement>(
      "Unit for 1 1/2 cups plain flour, sifted",
    );
    expect(unit.selectedOptions[0]?.textContent).toBe("cup (US)");
    expect(
      sifted.getByRole<HTMLInputElement>("combobox", {
        name: "Ingredient for 1 1/2 cups plain flour, sifted",
      }).value,
    ).toBe("plain flour");
    expect(sifted.getByText("Prep notes: sifted")).toBeDefined();

    // Flagged: the unit waits for the cook, with the flag and its hint.
    const toTaste = line(2);
    expect(toTaste.getByText("Check the amount")).toBeDefined();
    expect(
      toTaste.getByLabelText<HTMLSelectElement>("Unit for salt to taste")
        .selectedOptions[0]?.textContent,
    ).toBe("Choose a unit…");
    expect(toTaste.getByText("No quantity")).toBeDefined();
    expect(
      toTaste.getByText(
        "No amount given. Choose No unit to keep “to taste” in the notes.",
      ),
    ).toBeDefined();
    expect(toTaste.getByText("something_new")).toBeDefined();

    // Units by type, each sorted by name.
    const groups = Array.from(unit.querySelectorAll("optgroup")).map(
      (group) => [
        group.label,
        Array.from(group.querySelectorAll("option")).map((o) => o.textContent),
      ],
    );
    expect(groups).toEqual([
      ["Mass", ["gram (g)", "pound (lb)"]],
      ["Volume", ["cup (US)", "tablespoon (tbsp)"]],
      ["Count", ["clove"]],
    ]);

    expect(screen.getByText("Structured data (JSON-LD)")).toBeDefined();
    expect(screen.getByText("Browser-like fetch (impit)")).toBeDefined();
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(
      expect.arrayContaining([
        "Whisk everything together.",
        "Fry in a hot pan.",
        "Breakfast",
        "Vegetarian",
      ]),
    );
  });

  it("disables save while a line is unresolved and lists the unresolved lines", async () => {
    stubApi(previewOf([flour, salt, gochujang]));
    render(<ImportPreview locale="en-GB" />);

    await importUrl();
    await screen.findByRole("heading", { name: "Buttermilk pancakes" });

    expect(
      screen.getByText(/2 of 3 ingredient lines need you before you can save/),
    ).toBeDefined();
    expect(line(3).getByText("Needs an ingredient")).toBeDefined();
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText("You can save once every line is fixed.")).toBe(
      document.getElementById("save-hint"),
    );
    expect(
      screen.getByRole("heading", { name: "Before you can save" }),
    ).toBeDefined();
    const list = within(document.getElementById("unresolved")!);
    expect(list.getByText("Fix these 2 lines:")).toBeDefined();
    expect(list.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "salt to taste — Check the amount",
      "1 tbsp gochujang — Needs an ingredient",
    ]);

    // A link goes to the control that needs the cook.
    const user = userEvent.setup();
    await user.click(list.getByRole("link", { name: "1 tbsp gochujang" }));
    expect(document.activeElement).toBe(
      line(3).getByRole("combobox", {
        name: "Ingredient for 1 tbsp gochujang",
      }),
    );
  });

  it("resolves a line by picking one of its candidates", async () => {
    stubApi({
      ...previewOf([gochujang]),
      "GET /api/ingredients?q=gochujang": () =>
        respondWith(200, {
          ingredients: [],
          page: 1,
          pageSize: 25,
          hasMore: false,
        }),
    });
    render(<ImportPreview locale="en-GB" />);
    const user = await importUrl();
    const combobox = await screen.findByRole("combobox", {
      name: "Ingredient for 1 tbsp gochujang",
    });

    await user.click(combobox);
    const listbox = screen.getByRole("listbox");
    const suggested = within(listbox).getByRole("group", {
      name: "Suggested for this line",
    });
    expect(
      within(suggested)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["gochugaruEnglish (US)", "chilli pasteEnglish (UK)"]);
    expect(
      within(listbox).getByRole("option", { name: /Create “gochujang”/ }),
    ).toBeDefined();

    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");

    expect((combobox as HTMLInputElement).value).toBe("chilli paste");
    expect(combobox.getAttribute("aria-expanded")).toBe("false");
    expect(line(3).getByText("Ready")).toBeDefined();
    expect(saveButton().disabled).toBe(false);
    expect(screen.getByText(/All 1 ingredient lines are ready/)).toBeDefined();
  });

  it("puts the chosen ingredient back on Escape", async () => {
    stubApi(previewOf([flour]));
    render(<ImportPreview locale="en-GB" />);
    const user = await importUrl();
    const combobox = await screen.findByRole<HTMLInputElement>("combobox", {
      name: "Ingredient for 1 1/2 cups plain flour, sifted",
    });

    await user.clear(combobox);
    await user.type(combobox, "x");
    expect(combobox.getAttribute("aria-expanded")).toBe("true");
    await user.keyboard("{Escape}");

    expect(combobox.value).toBe("plain flour");
    expect(combobox.getAttribute("aria-expanded")).toBe("false");
  });

  it("resolves a line by searching the catalogue", async () => {
    const fetchMock = stubApi({
      ...previewOf([gochujang]),
      "GET /api/ingredients?q=go": () =>
        respondWith(200, {
          ingredients: [
            // Already suggested, so not listed twice.
            { id: 50, name: "gochugaru", locale: "en-US", category: null },
            { id: 60, name: "Korean chilli paste", locale: "en-GB" },
          ],
          page: 1,
          pageSize: 25,
          hasMore: false,
        }),
    });
    render(<ImportPreview locale="en-GB" />);
    const user = await importUrl();
    const combobox = await screen.findByRole("combobox", {
      name: "Ingredient for 1 tbsp gochujang",
    });

    await user.type(combobox, "go");

    const matches = await screen.findByRole("group", {
      name: "All ingredients matching “go”",
    });
    const option = await within(matches).findByRole("option", {
      name: /Korean chilli paste/,
    });
    expect(within(matches).getAllByRole("option")).toHaveLength(1);
    expect(screen.getByText("2 suggestions, 1 match")).toBeDefined();
    // Typing "g" alone searched nothing.
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).startsWith("/api/ingredients"),
      ),
    ).toHaveLength(1);

    await user.click(option);

    expect((combobox as HTMLInputElement).value).toBe("Korean chilli paste");
    expect(line(3).getByText("Ready")).toBeDefined();
  });

  it("says when a search fails, inside the list", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubApi({
      ...previewOf([gochujang]),
      "GET /api/ingredients?q=gochujang": () =>
        respondWith(502, { message: "Bad Gateway" }),
    });
    render(<ImportPreview locale="en-GB" />);
    const user = await importUrl();

    await user.click(
      await screen.findByRole("combobox", {
        name: "Ingredient for 1 tbsp gochujang",
      }),
    );

    expect(
      await screen.findByText("Search failed. Close and try again."),
    ).toBeDefined();
    // Suggestions and Create are still offered.
    expect(
      within(screen.getByRole("listbox")).getAllByRole("option"),
    ).toHaveLength(3);
  });

  it("resolves a line by creating an ingredient", async () => {
    const fetchMock = stubApi({
      ...previewOf([gochujang]),
      "GET /api/ingredients?q=gochujang": () =>
        respondWith(200, {
          ingredients: [],
          page: 1,
          pageSize: 25,
          hasMore: false,
        }),
      "POST /api/ingredients": () =>
        respondWith(201, {
          id: 77,
          category: "Sauces",
          source: "user",
          canEdit: true,
          names: [
            { id: 1, name: "gochujang", locale: "en-GB", isCanonical: true },
          ],
        }),
    });
    render(<ImportPreview locale="en-GB" />);
    const user = await importUrl();
    const combobox = await screen.findByRole("combobox", {
      name: "Ingredient for 1 tbsp gochujang",
    });

    await user.click(combobox);
    await user.click(
      screen.getByRole("option", { name: /Create “gochujang”/ }),
    );

    const form = screen.getByRole("form", {
      name: "New ingredient for “1 tbsp gochujang”",
    });
    const name = within(form).getByLabelText<HTMLInputElement>("Name 1");
    expect(name.value).toBe("gochujang");
    expect(document.activeElement).toBe(name);
    // The page is .co.uk, so its names are British English.
    expect(
      within(form).getByLabelText<HTMLSelectElement>("Language").value,
    ).toBe("en-GB");

    await user.type(
      within(form).getByLabelText("Category (optional)"),
      "Sauces",
    );
    await user.click(
      within(form).getByRole("button", { name: "Create ingredient" }),
    );

    await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
    expect(bodyOf(fetchMock, "POST /api/ingredients")).toEqual({
      names: [{ name: "gochujang", locale: "en-GB" }],
      category: "Sauces",
    });
    expect((combobox as HTMLInputElement).value).toBe("gochujang");
    expect(document.activeElement).toBe(combobox);
    expect(line(3).getByText("Created gochujang.").getAttribute("role")).toBe(
      "status",
    );
    expect(line(3).getByText("Ready")).toBeDefined();
  });

  it("resolves a flagged line with No unit, keeping the page's text in notes", async () => {
    const knob = {
      position: 4,
      rawText: "a knob of butter",
      quantity: "1",
      quantityText: "a",
      unit: null,
      unitText: "knob",
      ingredientText: "butter",
      prepNotes: null,
      notes: null,
      section: null,
      flags: ["unit_unmatched"],
      ingredientId: 70,
      candidates: [
        { ingredientId: 70, name: "butter", locale: "en-GB", similarity: 1 },
      ],
    };
    const fetchMock = stubApi({
      ...previewOf([knob, salt]),
      "POST /api/imports": () =>
        respondWith(201, {
          id: 5,
          title: "Buttermilk pancakes",
          alreadyImported: false,
        }),
    });
    render(<ImportPreview locale="en-GB" />);
    const user = await importUrl();
    await screen.findByRole("heading", { name: "Buttermilk pancakes" });

    expect(
      line(4).getByText(
        "We don’t recognise “knob”. Choose a unit, or No unit to keep the page’s text in the notes.",
      ),
    ).toBeDefined();

    await user.selectOptions(
      line(4).getByLabelText("Unit for a knob of butter"),
      "No unit (keep the page’s text in notes)",
    );
    await user.selectOptions(
      line(2).getByLabelText("Unit for salt to taste"),
      "No unit (keep the page’s text in notes)",
    );

    expect(line(4).getByText("Ready")).toBeDefined();
    expect(line(4).getByText("Notes: a knob of butter")).toBeDefined();
    expect(line(4).queryByText("Unit not recognised")).toBeNull();
    expect(line(2).getByText("Notes: to taste")).toBeDefined();

    // A real unit afterwards drops that note again.
    await user.selectOptions(
      line(4).getByLabelText("Unit for a knob of butter"),
      "gram (g)",
    );
    expect(line(4).queryByText(/Notes:/)).toBeNull();
    await user.selectOptions(
      line(4).getByLabelText("Unit for a knob of butter"),
      "No unit (keep the page’s text in notes)",
    );

    await user.click(saveButton());

    await waitFor(() => expect(window.location.pathname).toBe("/recipes/5"));
    expect(
      (
        bodyOf(fetchMock, "POST /api/imports") as {
          recipe: { ingredients: unknown };
        }
      ).recipe.ingredients,
    ).toEqual([
      {
        position: 4,
        ingredientId: 70,
        measurementId: null,
        quantity: "1",
        prepNotes: null,
        notes: "a knob of butter",
      },
      {
        position: 2,
        ingredientId: 40,
        measurementId: null,
        quantity: null,
        prepNotes: null,
        notes: "to taste",
      },
    ]);
  });

  // NATG-373: the parser's notes are only "500ml", so keeping them alone
  // would lose "pint".
  it.each([
    ["unit_ambiguous", "pint", "500ml"],
    ["unit_unmatched", "pint", "500ml"],
  ])(
    "keeps the page's unit with No unit on a %s line",
    async (flag, unitText, notes) => {
      const milk = {
        position: 1,
        rawText: "1 pint (500ml) milk",
        quantity: "1",
        quantityText: "1",
        unit: null,
        unitText,
        ingredientText: "milk",
        prepNotes: null,
        notes,
        section: null,
        flags: [flag],
        ingredientId: 80,
        candidates: [
          { ingredientId: 80, name: "milk", locale: "en-GB", similarity: 1 },
        ],
      };
      const fetchMock = stubApi({
        ...previewOf([milk]),
        "POST /api/imports": () =>
          respondWith(201, { id: 5, title: "x", alreadyImported: false }),
      });
      render(<ImportPreview locale="en-GB" />);
      const user = await importUrl();

      await user.selectOptions(
        await screen.findByLabelText("Unit for 1 pint (500ml) milk"),
        "No unit (keep the page’s text in notes)",
      );
      expect(line(1).getByText("Notes: 1 pint (500ml) milk")).toBeDefined();
      await user.click(saveButton());

      await waitFor(() => expect(window.location.pathname).toBe("/recipes/5"));
      const body = bodyOf(fetchMock, "POST /api/imports") as {
        recipe: { ingredients: unknown[] };
      };
      expect(body.recipe.ingredients).toEqual([
        {
          position: 1,
          ingredientId: 80,
          measurementId: null,
          quantity: "1",
          prepNotes: null,
          notes: "1 pint (500ml) milk",
        },
      ]);
    },
  );

  it.each([
    ["½", "0.5"],
    ["1 1/2", "1.5"],
    ["1½", "1.5"],
    ["0.25", "0.25"],
    ["", null],
  ])("takes the quantity %j and sends %j", async (typed, sent) => {
    const fetchMock = stubApi({
      ...previewOf([flour]),
      "POST /api/imports": () =>
        respondWith(201, {
          id: 5,
          title: "Buttermilk pancakes",
          alreadyImported: false,
        }),
    });
    render(<ImportPreview locale="en-GB" />);
    const user = await importUrl();
    const quantity = await screen.findByLabelText(
      "Quantity for 1 1/2 cups plain flour, sifted",
    );

    await user.clear(quantity);
    if (typed) await user.type(quantity, typed);
    await user.click(saveButton());

    await waitFor(() => expect(window.location.pathname).toBe("/recipes/5"));
    const body = bodyOf(fetchMock, "POST /api/imports") as {
      recipe: { ingredients: { quantity: unknown }[] };
    };
    expect(body.recipe.ingredients[0]?.quantity).toBe(sent);
  });

  it.each(["2-3", "a few", "0", "1/0"])(
    "refuses the quantity %j until it is a number",
    async (typed) => {
      stubApi(previewOf([flour]));
      render(<ImportPreview locale="en-GB" />);
      const user = await importUrl();
      const quantity = await screen.findByLabelText(
        "Quantity for 1 1/2 cups plain flour, sifted",
      );

      await user.clear(quantity);
      await user.type(quantity, typed);

      expect(line(1).getByText("Enter a number, like 1.5.")).toBeDefined();
      expect(quantity.getAttribute("aria-invalid")).toBe("true");
      expect(line(1).getByText("Check the amount")).toBeDefined();
      expect(saveButton().disabled).toBe(true);
    },
  );

  it("posts the reviewed recipe and lands on the new recipe, passing alreadyImported along", async () => {
    const fetchMock = stubApi({
      ...previewOf([flour]),
      "POST /api/imports": () =>
        respondWith(201, {
          id: 12,
          title: "Buttermilk pancakes",
          sourceUrl: "https://example.co.uk/pancakes",
          alreadyImported: true,
        }),
    });
    render(<ImportPreview locale="en-GB" />);
    const user = await importUrl();
    await screen.findByRole("heading", { name: "Buttermilk pancakes" });

    await user.click(saveButton());

    await waitFor(() => expect(window.location.pathname).toBe("/recipes/12"));
    expect(window.history.state).toEqual({
      saved: true,
      alreadyImported: true,
    });
    expect(bodyOf(fetchMock, "POST /api/imports")).toEqual({
      sourceUrl: "https://example.co.uk/pancakes",
      recipe: {
        title: "Buttermilk pancakes",
        servings: 4,
        prepMinutes: 15,
        cookMinutes: 90,
        ingredients: [
          {
            position: 1,
            ingredientId: 31,
            measurementId: 9,
            quantity: "1.5",
            prepNotes: "sifted",
            notes: null,
          },
        ],
        steps: preview.recipe.steps,
        tags: preview.recipe.tags,
      },
    });
  });

  it("shows that it is saving, and keeps the fields while it does", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    stubApi({
      ...previewOf([flour]),
      "POST /api/imports": () =>
        gate.then(() =>
          respondWith(201, { id: 5, title: "x", alreadyImported: false }),
        ),
    });
    render(<ImportPreview locale="en-GB" />);
    const user = await importUrl();
    await screen.findByRole("heading", { name: "Buttermilk pancakes" });

    await user.click(saveButton());

    const saving = screen.getByRole("button", { name: "Saving…" });
    expect(saving.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Saving the recipe…").getAttribute("role")).toBe(
      "status",
    );
    expect(
      screen.getByLabelText<HTMLInputElement>(
        "Quantity for 1 1/2 cups plain flour, sifted",
      ).readOnly,
    ).toBe(true);

    release();
    await waitFor(() => expect(window.location.pathname).toBe("/recipes/5"));
  });

  it("maps a 422's positions back onto the lines", async () => {
    stubApi({
      ...previewOf([
        flour,
        { ...salt, unit: { measurementId: 9, key: null }, flags: [] },
      ]),
      "POST /api/imports": () =>
        respondWith(422, {
          error: "unresolved_lines",
          message: "some lines name an ingredient or unit that does not exist",
          positions: [2],
        }),
    });
    render(<ImportPreview locale="en-GB" />);
    const user = await importUrl();
    await screen.findByRole("heading", { name: "Buttermilk pancakes" });

    await user.click(saveButton());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "We couldn't save the recipe: 1 line name an ingredient or unit that is no longer in the catalogue. Choose them again, then save.",
    );
    expect(document.activeElement).toBe(alert);
    expect(line(2).getByText("Couldn't save this line")).toBeDefined();
    expect(
      line(2).getByText(
        "Its ingredient or unit is no longer in the catalogue. Choose them again.",
      ),
    ).toBeDefined();
    expect(line(1).getByText("Ready")).toBeDefined();
    expect(
      within(document.getElementById("unresolved")!)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["salt to taste — Couldn't save this line"]);
    expect(saveButton().disabled).toBe(true);

    // Choosing again clears it.
    await user.selectOptions(
      line(2).getByLabelText("Unit for salt to taste"),
      "gram (g)",
    );
    expect(line(2).getByText("Ready")).toBeDefined();
    expect(saveButton().disabled).toBe(false);
  });

  it("keeps the review when a save fails, and says so", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubApi({
      ...previewOf([flour]),
      "POST /api/imports": () =>
        respondWith(500, { error: "internal_error", message: "x" }),
    });
    render(<ImportPreview locale="en-GB" />);
    const user = await importUrl();
    await screen.findByRole("heading", { name: "Buttermilk pancakes" });

    await user.click(saveButton());

    const alert = await screen.findByRole("alert");
    expect(
      within(alert).getByText(
        "We couldn't save the recipe. Your changes are still here, so try again.",
      ),
    ).toBeDefined();
    expect(document.activeElement).toBe(alert);
    expect(saveButton().disabled).toBe(false);
    expect(window.location.pathname).toBe("/");
  });

  it("says when ingredients could not be matched", async () => {
    stubApi(
      previewOf([gochujang], {
        ingredientMatching: {
          status: "ai_not_configured",
          message: "No AI provider is set up, so ingredients were not matched.",
        },
      }),
    );
    render(<ImportPreview locale="en-GB" />);
    await importUrl();

    expect(
      await screen.findByText(
        "No AI provider is set up, so ingredients were not matched.",
      ),
    ).toBeDefined();
  });

  it("explains when the units cannot be loaded, and tries again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    stubApi({
      ...previewOf([flour]),
      "GET /api/measurements": () =>
        fail
          ? respondWith(502, { message: "Bad Gateway" })
          : respondWith(200, { measurements: units }),
    });
    render(<ImportPreview locale="en-GB" />);
    const user = await importUrl();

    expect(
      within(await screen.findByRole("alert")).getByText(
        "We couldn't load the list of units, so the lines can't be checked yet.",
      ),
    ).toBeDefined();
    expect(saveButton().disabled).toBe(true);

    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Ready")).toBeDefined();
  });

  // NATG-262: the parser keeps the rest of a mixed amount in notes.
  it("asks for one amount for a mixed amount, so it is not lost", async () => {
    stubApi(
      previewOf([
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
          ingredientId: null,
          candidates: [],
        },
      ]),
    );
    render(<ImportPreview locale="en-GB" />);

    await importUrl();

    const chicken = line(1);
    expect(await chicken.findByText("Mixed amount")).toBeDefined();
    expect(
      chicken.getByText(
        "“1 lb 4 oz” is two amounts. Enter it as one amount (for example 1.25 lb), or choose No unit to keep the page’s text in the notes.",
      ),
    ).toBeDefined();
    expect(chicken.getByText("Needs ingredient · check amount")).toBeDefined();
    expect(
      chicken.getByLabelText<HTMLInputElement>("Quantity for 1 lb 4 oz chicken")
        .value,
    ).toBe("");
  });

  // NATG-263: group headers on the page arrive as each line's section.
  it("groups ingredients under their section headings", async () => {
    stubApi(
      previewOf([
        { ...flour, position: 1, section: "For the cake" },
        { ...flour, position: 2, section: "For the icing" },
      ]),
    );
    render(<ImportPreview locale="en-GB" />);

    await importUrl();

    await screen.findByRole("heading", { name: "For the cake" });
    expect(
      screen
        .getAllByRole("heading")
        .map((h) => h.textContent)
        .filter((text) => text?.startsWith("For the")),
    ).toEqual(["For the cake", "For the icing"]);
  });

  it("labels the unit_ambiguous flag and accepts a unit without a key", async () => {
    stubApi(
      previewOf([
        {
          ...flour,
          rawText: "1 c milk",
          unit: { measurementId: 9, key: null },
          unitText: "c",
          flags: ["unit_ambiguous"],
        },
      ]),
    );
    render(<ImportPreview locale="en-GB" />);

    await importUrl();

    expect(await screen.findByText("Unit ambiguous")).toBeDefined();
    expect(
      screen.getByText("“c” could mean more than one unit. Choose which."),
    ).toBeDefined();
  });

  it("says when the page lists no ingredients, steps or tags", async () => {
    stubApi({
      "POST /api/imports/preview": () =>
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
    });
    render(<ImportPreview locale="en-GB" />);

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
    stubApi({
      "POST /api/imports/preview": () =>
        new Promise<Response>((r) => (resolve = r)),
    });
    render(<ImportPreview locale="en-GB" />);

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
    expect(screen.queryByText("Fetching the recipe…")).toBeNull();
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
    stubApi({
      "POST /api/imports/preview": () =>
        respondWith(status, { ...body, message: "x", url: "y" }),
    });
    render(<ImportPreview locale="en-GB" />);

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
    stubApi({
      "POST /api/imports/preview": () =>
        respondWith(422, {
          error: "fetch_failed",
          reason,
          message: "x",
          url: "y",
        }),
    });
    render(<ImportPreview locale="en-GB" />);

    await importUrl();

    const alert = await screen.findByRole("alert");
    expect(
      within(alert).getByText("We couldn't fetch that page"),
    ).toBeDefined();
    expect(within(alert).getByText(detail)).toBeDefined();
  });

  it("explains when the api itself cannot be reached", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubApi({
      "POST /api/imports/preview": () =>
        respondWith(502, { message: "Bad Gateway" }),
    });
    render(<ImportPreview locale="en-GB" />);

    await importUrl();

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Can't reach the API: the server answered with HTTP 502/,
    );
  });

  it("fetches the same url again with refresh: true", async () => {
    const fetchMock = stubApi(previewOf([flour]));
    render(<ImportPreview locale="en-GB" />);

    const user = await importUrl();
    await screen.findByRole("heading", { name: "Buttermilk pancakes" });

    await user.click(screen.getByRole("button", { name: "Fetch again" }));

    await screen.findByRole("heading", { name: "Buttermilk pancakes" });
    expect(bodyOf(fetchMock, "POST /api/imports/preview")).toEqual({
      url: "https://example.co.uk/pancakes",
      refresh: true,
    });
  });
});
