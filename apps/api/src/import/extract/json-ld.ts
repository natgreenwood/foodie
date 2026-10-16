import type { CheerioAPI } from "cheerio";
import { isType, type SchemaNode } from "./schema-node.js";

// Every schema.org Recipe in the page's JSON-LD, in document order: blocks
// in page order, each walked depth-first, so a Recipe in an @graph, under a
// WebPage's mainEntity or in a top-level array is found. @type may be a
// string or an array. A block that is not valid JSON is skipped: one broken
// block should not hide a recipe in another.
export function jsonLdRecipes($: CheerioAPI): SchemaNode[] {
  const recipes: SchemaNode[] = [];
  $("script").each((_, el) => {
    const type = ($(el).attr("type") ?? "").split(";")[0]?.trim();
    if (type?.toLowerCase() !== "application/ld+json") return;
    let data: unknown;
    try {
      data = JSON.parse($(el).text());
    } catch {
      return;
    }
    collect(data, recipes);
  });
  return recipes;
}

function collect(data: unknown, into: SchemaNode[]): void {
  if (Array.isArray(data)) {
    for (const item of data) collect(item, into);
    return;
  }
  if (typeof data !== "object" || data === null) return;
  const node = data as SchemaNode;
  if (isType(node, "Recipe")) {
    // Its own properties are parts of it, not further recipes.
    into.push(node);
    return;
  }
  for (const value of Object.values(node)) collect(value, into);
}
