import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractRecipe, type ExtractContext } from "./extract.js";
import { measurements, UNIT, unitKeys } from "./__fixtures__/units.js";

function fixture(name: string): string {
  return readFileSync(
    new URL(`./__fixtures__/${name}`, import.meta.url),
    "utf8",
  );
}

const ctx: ExtractContext = {
  sourceHost: "www.example.com.au",
  measurements,
  unitKeys,
};

function extract(html: string, context = ctx) {
  return extractRecipe(html, context);
}

// A page with one JSON-LD Recipe holding just the given properties.
function jsonLdPage(recipe: object): string {
  const json = JSON.stringify({ "@type": "Recipe", name: "Test", ...recipe });
  return `<html><head><script type="application/ld+json">${json}</script></head></html>`;
}

describe("extractRecipe: JSON-LD", () => {
  it("reads a single Recipe object", () => {
    const result = extract(fixture("json-ld-single.html"));

    expect(result?.extraction).toBe("json-ld");
    expect(result?.warnings).toEqual([]);
    expect(result?.recipe).toMatchObject({
      title: "Spaghetti with Tomato & Basil Sauce",
      servings: 4,
      prepMinutes: 15,
      cookMinutes: 90,
      steps: [
        {
          position: 1,
          text: "Make the pasta dough and rest it for 30 minutes.",
        },
        { position: 2, text: "Simmer the tomatoes with the garlic." },
        { position: 3, text: "Toss the pasta through the sauce." },
      ],
      tags: ["pasta", "Dinner", "vegetarian", "Main course"],
    });
  });

  it("runs ingredient lines through the line parser, with the unit's key", () => {
    const [flour] =
      extract(fixture("json-ld-single.html"))?.recipe.ingredients ?? [];

    // .com.au: an unqualified cup is the metric cup (NATG-218 rule 2).
    expect(flour).toEqual({
      position: 1,
      rawText: "1 1/2 cups plain flour, sifted",
      quantity: "1.5",
      quantityText: "1 1/2",
      unit: { measurementId: UNIT.cupMetric, key: "cup_metric" },
      unitText: "cups",
      ingredientText: "plain flour, sifted",
      prepNotes: null,
      notes: null,
      flags: [],
      section: null,
    });
  });

  it("carries group headers as each following line's section", () => {
    const ingredients =
      extract(fixture("json-ld-single.html"))?.recipe.ingredients ?? [];

    expect(ingredients.map((i) => [i.position, i.rawText, i.section])).toEqual([
      [1, "1 1/2 cups plain flour, sifted", null],
      [2, "2 eggs", null],
      [3, "400g tinned tomatoes", "For the sauce"],
      [4, "2 cloves garlic", "For the sauce"],
      [5, "Salt, to taste", "For the sauce"],
      [6, "1 handful basil leaves", "To serve"],
    ]);
  });

  it("returns a null key for a unit the seed did not ship", () => {
    const basil = extract(fixture("json-ld-single.html"))?.recipe
      .ingredients[5];

    expect(basil?.unit).toEqual({ measurementId: UNIT.handful, key: null });
  });

  it.each([
    ["For the sauce", "For the sauce"],
    ["for the topping", "for the topping"],
    ["Dressing:", "Dressing"],
    // A trailing colon is a header whatever precedes it.
    ["For the 2 cakes:", "For the 2 cakes"],
  ])("treats %j as a section header", (header, section) => {
    const result = extract(
      jsonLdPage({ recipeIngredient: [header, "2 eggs"] }),
    );

    expect(result?.recipe.ingredients).toHaveLength(1);
    expect(result?.recipe.ingredients[0]?.section).toBe(section);
  });

  it.each([
    ["For the garnish: fresh parsley", "For the garnish", "fresh parsley"],
    ["For serving: lemon wedges", "For serving", "lemon wedges"],
    ["FOR THE 2 CAKES: 1 cup sugar", "FOR THE 2 CAKES", "1 cup sugar"],
  ])(
    "splits %j into a section and an ingredient",
    (entry, section, rawText) => {
      const result = extract(
        jsonLdPage({ recipeIngredient: [entry, "2 eggs"] }),
      );

      expect(
        result?.recipe.ingredients.map((i) => [
          i.position,
          i.rawText,
          i.section,
        ]),
      ).toEqual([
        [1, rawText, section],
        [2, "2 eggs", section],
      ]);
    },
  );

  it.each([
    // Only a "For ..." line splits at its colon.
    "Salt: to taste",
    "Sauce: 2 tbsp soy sauce",
    "Fortified wine",
    "For the 2 cakes",
  ])("keeps %j as an ingredient", (line) => {
    const result = extract(jsonLdPage({ recipeIngredient: [line] }));

    expect(result?.recipe.ingredients[0]?.rawText).toBe(line);
  });

  it("finds the Recipe in an @graph, with @type as an array", () => {
    const result = extract(fixture("json-ld-graph.html"));

    expect(result?.extraction).toBe("json-ld");
    expect(result?.warnings).toEqual([]);
    expect(result?.recipe).toMatchObject({
      title: "Pancakes",
      servings: 6,
      prepMinutes: 10,
      cookMinutes: 20,
      tags: [],
    });
  });

  it("finds a Recipe under a WebPage's mainEntity", () => {
    const result = extract(fixture("json-ld-main-entity.html"));

    expect(result?.extraction).toBe("json-ld");
    expect(result?.recipe.servings).toBe(8);
    expect(
      result?.recipe.ingredients.map((i) => [i.rawText, i.section]),
    ).toEqual([
      ["200g plain flour", "For the pastry"],
      ["4 lemons, juiced", "For the filling"],
      ["3 eggs", "For the filling"],
    ]);
  });

  it("takes the page's <title>, trimmed, when the Recipe has no name", () => {
    const result = extract(fixture("json-ld-main-entity.html"));

    expect(result?.recipe.title).toBe("Lemon tart | Example Kitchen");
  });

  it("returns an empty title when there is no name and no <title>", () => {
    const result = extract(jsonLdPage({ name: undefined }));

    expect(result?.recipe.title).toBe("");
  });

  it("does not search a Recipe's own properties for further recipes", () => {
    const result = extract(
      jsonLdPage({ hasPart: { "@type": "Recipe", name: "Inner" } }),
    );

    expect(result?.recipe.title).toBe("Test");
    expect(result?.warnings).toEqual([]);
  });

  it("splits string recipeInstructions into one step per line", () => {
    const result = extract(fixture("json-ld-graph.html"));

    expect(result?.recipe.steps).toEqual([
      { position: 1, text: "Whisk everything together." },
      { position: 2, text: "Cook in a hot pan." },
      { position: 3, text: "Serve warm." },
    ]);
  });

  it("reads a top-level array and skips a block that is not valid JSON", () => {
    const result = extract(fixture("json-ld-array.html"));

    expect(result?.recipe).toMatchObject({
      title: "Lemon slice",
      servings: 16,
      prepMinutes: null,
      cookMinutes: null,
      steps: [
        { position: 1, text: "Melt the butter." },
        { position: 2, text: "Stir in the zest." },
      ],
    });
    expect(result?.recipe.ingredients.map((i) => i.rawText)).toEqual([
      "200g butter",
      "1 lemon, zested",
    ]);
  });

  it("imports the first of two recipes and warns about the other", () => {
    const result = extract(fixture("json-ld-two-recipes.html"));

    expect(result?.warnings).toEqual(["multiple_recipes_found"]);
    expect(result?.recipe.title).toBe("Roast chicken");
  });

  it("flattens HowToSection steps in order", () => {
    const result = extract(fixture("json-ld-two-recipes.html"));

    expect(result?.recipe.steps.map((s) => s.text)).toEqual([
      "Heat the oven to 200C.",
      "Rub the chicken with oil.",
      "Roast for 1 hour.",
      "Rest before carving.",
    ]);
  });

  it.each([
    ["4 servings", 4],
    ["Serves 4", 4],
    ["4", 4],
    [4, 4],
    ["4-6", 4],
    [["4", "4 servings"], 4],
    [["a few", "Makes 12"], 12],
    ["a crowd", null],
    ["0", null],
    [undefined, null],
    ["1 loaf (12 slices)", 1],
    ["4 large pancakes", 4],
    ["500g", null],
    ["500 g", null],
    ["1.5 kg", null],
    ["750ml", null],
    ["2 l", null],
    ["12 oz", null],
    ["2 lbs", null],
    [["500g", "Serves 4"], 4],
  ])("reads recipeYield %j as %j", (recipeYield, servings) => {
    const result = extract(jsonLdPage({ recipeYield }));

    expect(result?.recipe.servings).toBe(servings);
  });

  it.each([
    ["PT15M", 15],
    ["PT1H30M", 90],
    ["PT2H", 120],
    ["P1DT2H", 1560],
    ["PT90S", 2],
    ["PT0.5H", 30],
    ["pt20m", 20],
    ["PT0M", 0],
    ["PT", null],
    ["P", null],
    ["20 minutes", null],
    [undefined, null],
  ])("reads the duration %j as %j minutes", (duration, minutes) => {
    const result = extract(
      jsonLdPage({ prepTime: duration, cookTime: duration }),
    );

    expect(result?.recipe.prepMinutes).toBe(minutes);
    expect(result?.recipe.cookMinutes).toBe(minutes);
  });

  it("merges keywords and categories into tags, de-duplicated case-insensitively", () => {
    const result = extract(
      jsonLdPage({
        keywords: ["Quick", " easy ", "quick"],
        recipeCategory: "Dessert, EASY",
      }),
    );

    expect(result?.recipe.tags).toEqual(["Quick", "easy", "Dessert"]);
  });
});

describe("extractRecipe: microdata", () => {
  it("reads a Recipe from microdata when the JSON-LD has none", () => {
    const result = extract(fixture("microdata.html"), {
      ...ctx,
      sourceHost: "oldrecipeblog.com",
    });

    expect(result?.extraction).toBe("microdata");
    expect(result?.warnings).toEqual([]);
    expect(result?.recipe).toMatchObject({
      // Not the author's itemprop="name", which belongs to the Person.
      title: "Grandma's Scones",
      servings: 12,
      prepMinutes: 20,
      cookMinutes: 12,
      steps: [
        { position: 1, text: "Heat the oven to 220°C." },
        { position: 2, text: "Mix the flour, cream and lemonade." },
        { position: 3, text: "Do not overwork it." },
        { position: 4, text: "Cut out and bake for 12 minutes." },
      ],
      tags: ["scones", "afternoon tea", "Baking"],
    });
    expect(
      result?.recipe.ingredients.map((i) => [i.rawText, i.unit?.key]),
    ).toEqual([
      // .com: an unqualified cup is the US cup.
      ["3 cups self-raising flour", "cup_us"],
      ["1 cup cream", "cup_us"],
      ["1 cup lemonade", "cup_us"],
    ]);
  });
});

describe("extractRecipe: no structured recipe", () => {
  it("returns null for a page with neither JSON-LD nor microdata recipe", () => {
    expect(extract(fixture("no-recipe.html"))).toBeNull();
  });

  it("returns null for a page that is not HTML at all", () => {
    expect(extract("not html { at all")).toBeNull();
  });
});
