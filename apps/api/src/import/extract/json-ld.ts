import type { CheerioAPI } from "cheerio";
import type { Budget } from "./budget.js";
import { isType, type SchemaNode } from "./schema-node.js";

// Every schema.org Recipe in the page's JSON-LD, in document order: blocks
// in page order, each walked depth-first, so a Recipe in an @graph, under a
// WebPage's mainEntity or in a top-level array is found. @type may be a
// string or an array. A block that is not valid JSON is skipped: one broken
// block should not hide a recipe in another.
export function jsonLdRecipes($: CheerioAPI, budget: Budget): SchemaNode[] {
  const recipes: SchemaNode[] = [];
  for (const el of $("script").toArray()) {
    const type = ($(el).attr("type") ?? "").split(";")[0]?.trim();
    if (type?.toLowerCase() !== "application/ld+json") continue;
    let data: unknown;
    try {
      data = JSON.parse($(el).text());
    } catch {
      continue;
    }
    walk(data, 0, budget, recipes);
  }
  return recipes;
}

// The whole document is walked within the budget, a Recipe's own properties
// included, so the draft only ever reads what fitted. Those properties are
// parts of the Recipe, not further recipes: `into` is null below one.
function walk(
  data: unknown,
  depth: number,
  budget: Budget,
  into: SchemaNode[] | null,
): void {
  budget.visit(depth);
  if (Array.isArray(data)) {
    budget.check("valuesPerProperty", data.length);
    for (const item of data) walk(item, depth + 1, budget, into);
    return;
  }
  if (typeof data !== "object" || data === null) return;
  const node = data as SchemaNode;
  const values = Object.values(node);
  budget.check("propertiesPerItem", values.length);
  const recipe = into !== null && isType(node, "Recipe");
  if (recipe) into.push(node);
  for (const value of values) {
    walk(value, depth + 1, budget, recipe ? null : into);
  }
}
