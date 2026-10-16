import { describe, expect, test } from "vitest";
import { dbTest } from "../test/db.js";
import {
  buildMeasurementLookup,
  loadMeasurementLookup,
  type MeasurementNameRow,
} from "./measurement-lookup.js";
import { parseIngredientLine } from "./parse-line.js";

// The seeded units these tests use, with the seed's en-GB and en-US names
// (drizzle/0001_seed_measurement_units.sql) and made-up ids.
const ID = {
  gram: 1,
  pound: 4,
  ounce: 3,
  millilitre: 5,
  tablespoon: 8,
  cupUs: 9,
  cupMetric: 10,
  flOzUs: 11,
  flOzImperial: 12,
  clove: 17,
  can: 21,
} as const;

function unit(
  measurementId: number,
  type: MeasurementNameRow["type"],
  factorToBase: string | null,
  names: [string, string | null][],
): MeasurementNameRow[] {
  return names.map(([name, abbreviation]) => ({
    measurementId,
    type,
    factorToBase,
    name,
    abbreviation,
  }));
}

const measurements = buildMeasurementLookup([
  ...unit(ID.gram, "mass", "1", [["gram", "g"]]),
  ...unit(ID.ounce, "mass", "28.349523125", [["ounce", "oz"]]),
  ...unit(ID.pound, "mass", "453.59237", [["pound", "lb"]]),
  ...unit(ID.millilitre, "volume", "1", [
    ["millilitre", "ml"],
    ["milliliter", "mL"],
  ]),
  ...unit(ID.tablespoon, "volume", "15", [["tablespoon", "tbsp"]]),
  ...unit(ID.cupUs, "volume", "236.5882365", [
    ["US cup", "US cup"],
    ["cup", "cup"],
  ]),
  ...unit(ID.cupMetric, "volume", "250", [
    ["cup", "cup"],
    ["metric cup", "metric cup"],
  ]),
  ...unit(ID.flOzUs, "volume", "29.5735295625", [
    ["US fluid ounce", "US fl oz"],
    ["fluid ounce", "fl oz"],
  ]),
  ...unit(ID.flOzImperial, "volume", "28.4130625", [
    ["fluid ounce", "fl oz"],
    ["imperial fluid ounce", "imp fl oz"],
  ]),
  ...unit(ID.clove, "count", null, [["clove", null]]),
  ...unit(ID.can, "count", null, [
    ["tin", null],
    ["can", null],
  ]),
]);

function parse(line: string, sourceHost = "example.com") {
  return parseIngredientLine(line, { sourceHost, measurements });
}

describe("parseIngredientLine", () => {
  test("parses the example line from the issue", () => {
    expect(
      parse("1 1/2 cups (375ml) plain flour, sifted", "www.example.com"),
    ).toEqual({
      rawText: "1 1/2 cups (375ml) plain flour, sifted",
      quantity: "1.5",
      quantityText: "1 1/2",
      // 375 ml is 1.5 metric cups, which decides it over the .com host.
      measurementId: ID.cupMetric,
      unitText: "cups",
      ingredientText: "plain flour, sifted",
      prepNotes: null,
      notes: "375ml",
      flags: [],
    });
  });

  test("plain integer", () => {
    expect(parse("2 tbsp olive oil")).toMatchObject({
      quantity: "2",
      quantityText: "2",
      measurementId: ID.tablespoon,
      unitText: "tbsp",
      ingredientText: "olive oil",
      notes: null,
      flags: [],
    });
  });

  test("a line with no unit keeps the quantity and no measurement", () => {
    expect(parse("3 eggs")).toMatchObject({
      quantity: "3",
      measurementId: null,
      unitText: null,
      ingredientText: "eggs",
      flags: [],
    });
  });

  test("fraction", () => {
    expect(parse("1/2 tbsp honey")).toMatchObject({
      quantity: "0.5",
      quantityText: "1/2",
    });
  });

  test("unicode fraction", () => {
    expect(parse("½ tbsp honey")).toMatchObject({
      quantity: "0.5",
      quantityText: "½",
    });
  });

  test("mixed number", () => {
    expect(parse("1 1/2 tbsp honey")).toMatchObject({ quantity: "1.5" });
    expect(parse("1½ tbsp honey")).toMatchObject({ quantity: "1.5" });
  });

  test.each([
    ["2-3 cloves garlic", "2-3"],
    ["2 to 3 cloves garlic", "2 to 3"],
  ])(
    "range %j stores the lower bound and the range in notes",
    (line, range) => {
      expect(parse(line)).toMatchObject({
        quantity: "2",
        quantityText: range,
        measurementId: ID.clove,
        ingredientText: "garlic",
        notes: range,
        flags: [],
      });
    },
  );

  test.each(["salt to taste", "Salt, to taste"])(
    "%j stores no quantity and no unit",
    (line) => {
      const parsed = parse(line);
      expect(parsed).toMatchObject({
        quantity: null,
        quantityText: null,
        measurementId: null,
        unitText: null,
        notes: "to taste",
        flags: [],
      });
      expect(parsed.ingredientText.toLowerCase()).toBe("salt");
    },
  );

  test("a quantity next to 'or to taste' is kept", () => {
    expect(parse("1 tbsp sugar, or to taste")).toMatchObject({
      quantity: "1",
      measurementId: ID.tablespoon,
    });
  });

  test("a line with no quantity at all", () => {
    expect(parse("salt")).toEqual({
      rawText: "salt",
      quantity: null,
      quantityText: null,
      measurementId: null,
      unitText: null,
      ingredientText: "salt",
      prepNotes: null,
      notes: null,
      flags: [],
    });
  });

  test.each([
    ["200 g butter", ID.gram, "g"],
    ["200g butter", ID.gram, "g"],
    ["2 Tbsp butter", ID.tablespoon, "Tbsp"],
    ["2 tablespoons butter", ID.tablespoon, "tablespoons"],
    ["1 tin chopped tomatoes", ID.can, "tin"],
    ["2 cans chopped tomatoes", ID.can, "cans"],
  ])("%j matches by name or abbreviation", (line, measurementId, unitText) => {
    expect(parse(line)).toMatchObject({ measurementId, unitText, flags: [] });
  });

  test("a recognised unit with no measurement_name is flagged and kept", () => {
    expect(parse("2 sticks butter")).toMatchObject({
      quantity: "2",
      measurementId: null,
      unitText: "sticks",
      ingredientText: "butter",
      flags: ["unit_unmatched"],
    });
  });

  test("a unit naming two measurements is flagged, not guessed", () => {
    expect(parse("2 fl oz rum")).toMatchObject({
      quantity: "2",
      measurementId: null,
      unitText: "fl oz",
      flags: ["unit_ambiguous"],
    });
  });

  test("sizes are not units", () => {
    expect(parse("1 large onion")).toMatchObject({
      quantity: "1",
      unitText: null,
      ingredientText: "large onion",
      flags: [],
    });
  });

  test.each([
    ["1 lb 4 oz beef mince", "1", ID.pound, "beef mince"],
    ["1 cup plus 2 tbsp sugar", "1", ID.cupUs, "sugar"],
  ])(
    "mixed amount %j stores the first amount and the line in notes",
    (line, quantity, measurementId, ingredientText) => {
      expect(parse(line)).toMatchObject({
        quantity,
        measurementId,
        ingredientText,
        notes: line,
        flags: ["mixed_amount"],
      });
    },
  );

  test("a metric equivalent does not hide a mixed amount", () => {
    const line = "1 cup (250ml) plus 2 tbsp sugar";
    expect(parse(line, "example.com")).toMatchObject({
      quantity: "1",
      measurementId: ID.cupMetric,
      ingredientText: "sugar",
      notes: `250ml; ${line}`,
      flags: ["mixed_amount"],
    });
  });

  test("an empty line parses to nothing", () => {
    expect(parse("  ")).toMatchObject({
      rawText: "",
      quantity: null,
      measurementId: null,
      ingredientText: "",
      flags: [],
    });
  });
});

describe("cup resolution", () => {
  describe("rule 1: a metric equivalent next to the cup", () => {
    test.each([
      ["1 cup (250ml) milk", ID.cupMetric],
      ["½ cup (125 ml) milk", ID.cupMetric],
      ["1 cup (240 ml) milk", ID.cupUs],
      ["1 1/2 cups (355ml) milk", ID.cupUs],
    ])("%j on a .com host", (line, measurementId) => {
      expect(parse(line, "example.com")).toMatchObject({ measurementId });
    });

    test("overrides the host", () => {
      expect(parse("1 cup (240ml) milk", "example.com.au")).toMatchObject({
        measurementId: ID.cupUs,
      });
      expect(parse("1 cup (250ml) milk", "example.co.uk")).toMatchObject({
        measurementId: ID.cupMetric,
      });
    });

    test("a rounded equivalent that fits both cups falls back to the host", () => {
      // 1/3 metric cup is 83 ml and 1/3 US cup 79 ml; "80ml" fits both.
      expect(parse("1/3 cup (80ml) oil", "recipetineats.com")).toMatchObject({
        measurementId: ID.cupMetric,
        notes: "80ml",
      });
      expect(parse("1/3 cup (80ml) oil", "example.com")).toMatchObject({
        measurementId: ID.cupUs,
      });
    });

    test("grams in brackets do not decide a cup", () => {
      expect(parse("1 cup (150g) flour", "example.com")).toMatchObject({
        measurementId: ID.cupUs,
        ingredientText: "flour",
        notes: "150g",
      });
    });

    test("grams with the cup in brackets store the grams", () => {
      expect(parse("150g (1 cup) plain flour", "example.com")).toMatchObject({
        quantity: "150",
        measurementId: ID.gram,
        unitText: "g",
        ingredientText: "plain flour",
        notes: "1 cup",
        flags: [],
      });
    });

    test("a line already in ml stores the ml", () => {
      expect(parse("250ml (1 cup) milk", "example.com")).toMatchObject({
        quantity: "250",
        measurementId: ID.millilitre,
        ingredientText: "milk",
        notes: "1 cup",
      });
    });
  });

  describe("rule 2: the source host", () => {
    test.each([
      ["www.taste.com.au", ID.cupMetric],
      ["www.chelseasugar.co.nz", ID.cupMetric],
      ["www.canadianliving.ca", ID.cupMetric],
      ["www.bbcgoodfood.co.uk", ID.cupUs],
      ["www.allrecipes.com", ID.cupUs],
      ["WWW.TASTE.COM.AU.", ID.cupMetric],
      ["", ID.cupUs],
    ])("%j", (host, measurementId) => {
      expect(parse("2 cups flour", host)).toMatchObject({
        quantity: "2",
        measurementId,
        unitText: "cups",
        ingredientText: "flour",
        flags: [],
      });
    });
  });

  describe("rule 3: known metric-cup sites on .com", () => {
    test.each([
      "recipetineats.com",
      "www.recipetineats.com",
      "www.ricardocuisine.com",
    ])("%j", (host) => {
      expect(parse("1 cup sugar", host)).toMatchObject({
        measurementId: ID.cupMetric,
      });
    });

    test("matches whole domain labels only", () => {
      expect(parse("1 cup sugar", "notrecipetineats.com")).toMatchObject({
        measurementId: ID.cupUs,
      });
    });
  });

  test("a qualified cup is not resolved by the rules", () => {
    expect(parse("1 metric cup sugar", "example.com")).toMatchObject({
      measurementId: ID.cupMetric,
      unitText: "metric cup",
    });
    expect(parse("2 US cups sugar", "example.com.au")).toMatchObject({
      measurementId: ID.cupUs,
    });
  });
});

describe("with the lookup built from the seeded units", () => {
  dbTest("parses lines against the real measurement rows", async ({ tx }) => {
    const seeded = await loadMeasurementLookup(tx);
    const run = (line: string, sourceHost = "example.com") =>
      parseIngredientLine(line, { sourceHost, measurements: seeded });

    const id = (name: string) => {
      const ids = seeded.byName.get(name);
      expect(ids, name).toHaveLength(1);
      return ids?.[0];
    };

    expect(run("2 cups flour").measurementId).toBe(seeded.cup.cup_us);
    expect(run("2 cups flour", "taste.com.au").measurementId).toBe(
      seeded.cup.cup_metric,
    );
    expect(run("2 tbsp oil").measurementId).toBe(id("tbsp"));
    expect(run("500 g beef").measurementId).toBe(id("g"));
    expect(run("1 tin tomatoes").measurementId).toBe(id("tin"));
    expect(run("1 handful basil")).toMatchObject({
      measurementId: id("handful"),
      ingredientText: "basil",
      flags: [],
    });
    expect(run("2 slices bread").measurementId).toBe(id("slice"));
    expect(run("1 pint milk").flags).toEqual(["unit_ambiguous"]);
    expect(run("2 sticks butter")).toMatchObject({
      unitText: "sticks",
      flags: ["unit_unmatched"],
    });
  });
});
