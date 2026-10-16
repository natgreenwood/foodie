import { describe, expect, it } from "vitest";
import { BudgetExceededError, LIMITS } from "./budget.js";
import {
  extractRecipe,
  MAX_LINE_CHARS,
  type ExtractContext,
} from "./extract.js";
import { measurements } from "./__fixtures__/units.js";

// SEC-2 on NATG-245: pages built to make extraction slow. Each must fail
// fast, as no recipe, rather than hold the event loop. These took 50-230 ms
// locally and up to about 600 ms on CI, nearly all of it cheerio parsing the
// page. The reader they replace took 7.8 s on 40,000 repeated properties and
// grew quadratically, so 2 s still catches it with room for a slow runner.
const BOUND_MS = 2_000;

const ctx: ExtractContext = {
  sourceHost: "example.com",
  measurements,
};

function timed(html: string): { ms: number; error: unknown } {
  const start = performance.now();
  try {
    extractRecipe(html, ctx);
    return { ms: performance.now() - start, error: undefined };
  } catch (err) {
    return { ms: performance.now() - start, error: err };
  }
}

function microdataRecipe(body: string): string {
  return `<html><body><div itemscope itemtype="https://schema.org/Recipe">${body}</div></body></html>`;
}

function jsonLd(json: string): string {
  return `<html><head><script type="application/ld+json">${json}</script></head></html>`;
}

describe("extraction budget", () => {
  it("stops a microdata Recipe with 100,000 repeated meta properties", () => {
    const html = microdataRecipe(
      '<meta itemprop="recipeIngredient" content="1 egg">'.repeat(100_000),
    );

    const { ms, error } = timed(html);

    expect(error).toEqual(new BudgetExceededError("valuesPerProperty"));
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it("stops a JSON-LD @graph nested 100,000 deep", () => {
    const html = jsonLd('{"@graph":['.repeat(100_000) + "]}".repeat(100_000));

    const { ms, error } = timed(html);

    expect(error).toEqual(new BudgetExceededError("depth"));
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it("does not read microdata scopes that are not recipes", () => {
    const html = `<html><body><div itemscope itemtype="https://schema.org/Thing">${'<meta itemprop="x" content="a">'.repeat(100_000)}</div></body></html>`;

    const { ms, error } = timed(html);

    expect(error).toBeUndefined();
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it("limits distinct properties on one item", () => {
    const props = Array.from(
      { length: LIMITS.propertiesPerItem + 1 },
      (_, i) => `<meta itemprop="p${i}" content="a">`,
    ).join("");

    expect(() => extractRecipe(microdataRecipe(props), ctx)).toThrow(
      new BudgetExceededError("propertiesPerItem"),
    );
  });

  it("limits element depth below a microdata Recipe", () => {
    const depth = LIMITS.depth + 1;
    const html = microdataRecipe(
      "<div>".repeat(depth) +
        '<span itemprop="name">Deep</span>' +
        "</div>".repeat(depth),
    );

    expect(() => extractRecipe(html, ctx)).toThrow(
      new BudgetExceededError("depth"),
    );
  });

  it("limits the nodes visited across the page", () => {
    // Each array within the per-property limit, but too many of them.
    const chunk = Array.from({ length: 500 }, () => "{}").join(",");
    const many = Array.from({ length: 250 }, () => `[${chunk}]`).join(",");
    expect(() => extractRecipe(jsonLd(`{"@graph":[${many}]}`), ctx)).toThrow(
      new BudgetExceededError("nodes"),
    );
  });

  it("limits the lines a single instructions string splits into", () => {
    const html = jsonLd(
      JSON.stringify({
        "@type": "Recipe",
        name: "Many steps",
        recipeInstructions: "Stir.\n".repeat(LIMITS.valuesPerProperty + 1),
      }),
    );

    expect(() => extractRecipe(html, ctx)).toThrow(
      new BudgetExceededError("valuesPerProperty"),
    );
  });

  it("cuts each ingredient line and step at MAX_LINE_CHARS before parsing", () => {
    const long = "1 cup " + "flour ".repeat(1_000);
    const html = jsonLd(
      JSON.stringify({
        "@type": "Recipe",
        name: "Long lines",
        recipeIngredient: [long, "2 eggs"],
        recipeInstructions: [
          { "@type": "HowToStep", text: "Stir ".repeat(1_000) },
        ],
      }),
    );

    const recipe = extractRecipe(html, ctx)?.recipe;

    expect(recipe?.ingredients[0]?.rawText).toBe(
      long.slice(0, MAX_LINE_CHARS).trimEnd(),
    );
    expect(recipe?.ingredients[0]?.quantity).toBe("1");
    expect(recipe?.ingredients[1]?.rawText).toBe("2 eggs");
    expect(recipe?.steps[0]?.text).toBe(
      "Stir ".repeat(1_000).slice(0, MAX_LINE_CHARS).trimEnd(),
    );
  });
});
