import { describe, expect, it } from "vitest";
import {
  localeForHost,
  unitAbbreviation,
  unitOptions,
  type Measurement,
} from "./catalogue";

function unit(
  id: number,
  names: Measurement["names"],
  type: Measurement["type"] = "count",
): Measurement {
  return { id, key: null, type, names };
}

const name = (
  locale: string,
  text: string,
  { abbreviation = null as string | null, isCanonical = true } = {},
) => ({ locale, name: text, abbreviation, isCanonical });

function labels(units: Measurement[], locale: string) {
  return unitOptions(units, locale).map((group) => [
    group.label,
    group.units.map((u) => u.label),
  ]);
}

describe("unitOptions", () => {
  it("groups by type and sorts each group in the user's locale, whatever the api's order", () => {
    // The database's collation puts capitalised names first.
    const units = [
      unit(1, [name("en-GB", "Pinch")], "count"),
      unit(2, [name("en-GB", "clove")], "count"),
      unit(3, [name("en-GB", "litre", { abbreviation: "l" })], "volume"),
      unit(4, [name("en-GB", "gram", { abbreviation: "g" })], "mass"),
      unit(5, [name("en-GB", "Égg")], "count"),
    ];
    expect(labels(units, "en-GB")).toEqual([
      ["Mass", ["gram (g)"]],
      ["Volume", ["litre (l)"]],
      ["Count", ["clove", "Égg", "Pinch"]],
    ]);
  });

  it("shows a unit by its canonical name in the user's locale", () => {
    const cup = unit(1, [
      name("en-GB", "US cup"),
      name("en-US", "cup", { abbreviation: "c" }),
      name("en-US", "cups", { isCanonical: false }),
    ]);
    expect(labels([cup], "en-US")).toEqual([["Count", ["cup (c)"]]]);
    expect(labels([cup], "en-GB")).toEqual([["Count", ["US cup"]]]);
  });

  it("falls back to the en-GB canonical name, then another locale's", () => {
    const units = [
      unit(1, [name("de-DE", "Prise"), name("en-GB", "pinch")]),
      unit(2, [name("de-DE", "Bund")]),
    ];
    expect(labels(units, "en-US")).toEqual([["Count", ["Bund", "pinch"]]]);
  });

  it("falls back to any name when a unit has no canonical one", () => {
    const units = [unit(1, [name("en-US", "knob", { isCanonical: false })])];
    expect(labels(units, "en-GB")).toEqual([["Count", ["knob"]]]);
  });

  it("leaves out units with no names", () => {
    const units = [unit(1, []), unit(2, [name("en-GB", "clove")])];
    expect(labels(units, "en-GB")).toEqual([["Count", ["clove"]]]);
    expect(labels([unit(1, [])], "en-GB")).toEqual([]);
  });

  it("sorts even when the profile locale is not one Intl takes", () => {
    const units = [
      unit(1, [name("en-GB", "b")]),
      unit(2, [name("en-GB", "a")]),
    ];
    expect(labels(units, "not a locale!")).toEqual([["Count", ["a", "b"]]]);
  });
});

describe("unitAbbreviation", () => {
  it("is the abbreviation in the user's locale, else the unit's name", () => {
    const teaspoon = unit(1, [
      name("en-GB", "teaspoon", { abbreviation: "tsp" }),
    ]);
    const clove = unit(2, [name("en-GB", "clove")]);
    const stick = unit(3, [name("en-US", "stick", { abbreviation: "st" })]);
    expect(unitAbbreviation(teaspoon, "en-GB")).toBe("tsp");
    expect(unitAbbreviation(clove, "en-GB")).toBe("clove");
    // en-US's abbreviation is not the user's; its name is shown instead.
    expect(unitAbbreviation(stick, "en-GB")).toBe("stick");
  });
});

describe("localeForHost", () => {
  it.each([
    ["www.bbcgoodfood.com", "en-US"],
    ["example.co.uk", "en-GB"],
    ["example.com.au.", "en-GB"],
  ])("takes %s as %s", (host, locale) => {
    expect(localeForHost(host)).toBe(locale);
  });
});
