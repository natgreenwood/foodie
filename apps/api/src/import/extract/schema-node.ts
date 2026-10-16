// A schema.org object as JSON-LD carries it, and as microdata.ts rebuilds it
// from the page's markup, so extract.ts reads both the same way.
export type SchemaNode = Record<string, unknown>;

// @type may be a string or an array; either may be a full URL
// ("http://schema.org/Recipe").
export function isType(node: SchemaNode, type: string): boolean {
  const types = node["@type"];
  return (Array.isArray(types) ? types : [types]).some(
    (t) => typeof t === "string" && t.split("/").pop() === type,
  );
}
