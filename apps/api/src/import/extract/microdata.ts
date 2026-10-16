import type { CheerioAPI } from "cheerio";
import { isType, type SchemaNode } from "./schema-node.js";

// cheerio does not export domhandler's Element type.
type Element = ReturnType<ReturnType<CheerioAPI["root"]>["find"]>[number];

// Every schema.org Recipe in the page's microdata, in document order, rebuilt
// as the object JSON-LD would carry: one key per itemprop, an array where a
// property repeats, nested itemscopes (HowToStep, HowToSection) as objects.
export function microdataRecipes($: CheerioAPI): SchemaNode[] {
  return $("[itemscope][itemtype]")
    .toArray()
    .map((el) => readItem($, el))
    .filter((item) => isType(item, "Recipe"));
}

function readItem($: CheerioAPI, scope: Element): SchemaNode {
  const types = ($(scope).attr("itemtype") ?? "").split(/\s+/).filter(Boolean);
  const item: SchemaNode = { "@type": types };
  $(scope)
    .find("[itemprop]")
    .each((_, prop) => {
      // Properties inside a nested itemscope belong to that item.
      if ($(prop).parent().closest("[itemscope]").get(0) !== scope) return;
      const value = $(prop).is("[itemscope]")
        ? readItem($, prop)
        : propertyValue($, prop);
      for (const name of ($(prop).attr("itemprop") ?? "").split(/\s+/)) {
        if (name === "") continue;
        const existing = item[name];
        item[name] =
          existing === undefined
            ? value
            : Array.isArray(existing)
              ? [...(existing as unknown[]), value]
              : [existing, value];
      }
    });
  return item;
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
