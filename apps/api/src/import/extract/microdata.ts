import type { CheerioAPI } from "cheerio";
import type { Budget } from "./budget.js";
import { isType, type SchemaNode } from "./schema-node.js";

// cheerio does not export domhandler's Element type.
type Element = ReturnType<ReturnType<CheerioAPI["root"]>["find"]>[number];

// Every schema.org Recipe in the page's microdata, in document order, rebuilt
// as the object JSON-LD would carry: one key per itemprop, an array where a
// property repeats, nested itemscopes (HowToStep, HowToSection) as objects.
// Only Recipe scopes and the scopes inside them are read, each element once,
// within the budget.
export function microdataRecipes($: CheerioAPI, budget: Budget): SchemaNode[] {
  const recipes: SchemaNode[] = [];
  // Scopes already read as part of a recipe, so a Recipe nested in another
  // is not read again as one of its own.
  const read = new Set<Element>();
  for (const scope of $("[itemscope][itemtype]").toArray()) {
    budget.visit(0);
    if (read.has(scope)) continue;
    const types = itemTypes($, scope);
    if (!isType({ "@type": types }, "Recipe")) continue;
    recipes.push(readItem($, scope, types, 0, budget, read));
  }
  return recipes;
}

function itemTypes($: CheerioAPI, scope: Element): string[] {
  return ($(scope).attr("itemtype") ?? "").split(/\s+/).filter(Boolean);
}

function readItem(
  $: CheerioAPI,
  scope: Element,
  types: string[],
  depth: number,
  budget: Budget,
  read: Set<Element>,
): SchemaNode {
  read.add(scope);
  const properties = new Map<string, unknown[]>();
  readProperties($, scope, depth, budget, read, properties);
  const item: SchemaNode = { "@type": types };
  for (const [name, values] of properties) {
    item[name] = values.length === 1 ? values[0] : values;
  }
  return item;
}

// One walk over the scope's descendants. A nested itemscope's properties are
// its own, so the walk reads it as an item (when it is a property) and does
// not descend into it.
function readProperties(
  $: CheerioAPI,
  parent: Element,
  depth: number,
  budget: Budget,
  read: Set<Element>,
  into: Map<string, unknown[]>,
): void {
  for (const child of $(parent).children().toArray()) {
    budget.visit(depth + 1);
    const isScope = $(child).attr("itemscope") !== undefined;
    const names = ($(child).attr("itemprop") ?? "").split(/\s+/);
    if (names.some((name) => name !== "")) {
      const value = isScope
        ? readItem($, child, itemTypes($, child), depth + 1, budget, read)
        : propertyValue($, child);
      for (const name of names) {
        if (name === "") continue;
        let values = into.get(name);
        if (values === undefined) {
          values = [];
          into.set(name, values);
          budget.check("propertiesPerItem", into.size);
        }
        values.push(value);
        budget.check("valuesPerProperty", values.length);
      }
    }
    if (!isScope) readProperties($, child, depth + 1, budget, read, into);
  }
}

// The value the microdata spec gives each element: an attribute for meta,
// time, links and media, otherwise the element's content. Content is kept as
// HTML so extract.ts can split instructions on <li> and <br> the same way as
// it does for HTML in JSON-LD strings.
function propertyValue($: CheerioAPI, prop: Element): string {
  const el = $(prop);
  if (el.is("meta")) return el.attr("content") ?? "";
  if (el.is("time")) return el.attr("datetime") ?? el.text();
  if (el.is("a, link, area")) return el.attr("href") ?? "";
  if (el.is("img, audio, video, source, embed, iframe, track")) {
    return el.attr("src") ?? "";
  }
  if (el.is("data, meter")) return el.attr("value") ?? "";
  return el.html() ?? "";
}
