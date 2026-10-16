import { load } from "cheerio";
import type { MeasurementLookup } from "../measurement-lookup.js";
import { parseIngredientLine, type ParseFlag } from "../parse-line.js";
import { jsonLdRecipes } from "./json-ld.js";
import { microdataRecipes } from "./microdata.js";
import { isType, type SchemaNode } from "./schema-node.js";

// The recipe a page declares in structured data, as the preview returns it
// (NATG-245). JSON-LD first, then microdata; no AI. Nothing here is stored.

export type Extraction = "json-ld" | "microdata";
export type ExtractWarning = "multiple_recipes_found";

export interface DraftIngredient {
  position: number;
  rawText: string;
  quantity: string | null;
  quantityText: string | null;
  // key is null for a unit the seed did not ship (see unit-keys.ts).
  unit: { measurementId: number; key: string | null } | null;
  unitText: string | null;
  ingredientText: string;
  prepNotes: string | null;
  notes: string | null;
  flags: ParseFlag[];
  // The group header the line sits under ("For the sauce"), or null.
  section: string | null;
}

export interface DraftRecipe {
  title: string;
  servings: number | null;
  prepMinutes: number | null;
  cookMinutes: number | null;
  ingredients: DraftIngredient[];
  steps: { position: number; text: string }[];
  tags: string[];
}

export interface ExtractedRecipe {
  extraction: Extraction;
  warnings: ExtractWarning[];
  recipe: DraftRecipe;
}

export interface ExtractContext {
  // The page's host, for the cup rules.
  sourceHost: string;
  measurements: MeasurementLookup;
  unitKeys: ReadonlyMap<number, string>;
}

// The first Recipe the page declares, or null if it declares none. When the
// method that found it found more than one, a warning says so: the others are
// not returned.
export function extractRecipe(
  html: string,
  ctx: ExtractContext,
): ExtractedRecipe | null {
  const $ = load(html);
  const methods: [Extraction, () => SchemaNode[]][] = [
    ["json-ld", () => jsonLdRecipes($)],
    ["microdata", () => microdataRecipes($)],
  ];
  for (const [extraction, find] of methods) {
    const [first, ...others] = find();
    if (first === undefined) continue;
    return {
      extraction,
      warnings: others.length > 0 ? ["multiple_recipes_found"] : [],
      recipe: draft(first, ctx),
    };
  }
  return null;
}

function draft(node: SchemaNode, ctx: ExtractContext): DraftRecipe {
  return {
    title: values(node.name).map(singleLine).find(Boolean) ?? "",
    servings: servings(node.recipeYield),
    prepMinutes: minutes(node.prepTime),
    cookMinutes: minutes(node.cookTime),
    ingredients: ingredients(
      // Older microdata uses the retired `ingredients` property.
      values(node.recipeIngredient ?? node.ingredients).flatMap(lines),
      ctx,
    ),
    steps: steps(node.recipeInstructions).map((text, i) => ({
      position: i + 1,
      text,
    })),
    tags: tags([...values(node.keywords), ...values(node.recipeCategory)]),
  };
}

function ingredients(
  entries: readonly string[],
  ctx: ExtractContext,
): DraftIngredient[] {
  const result: DraftIngredient[] = [];
  let section: string | null = null;
  for (const entry of entries) {
    const header = sectionHeader(entry);
    if (header !== null) {
      section = header;
      continue;
    }
    const { measurementId, ...parsed } = parseIngredientLine(entry, ctx);
    result.push({
      position: result.length + 1,
      rawText: parsed.rawText,
      quantity: parsed.quantity,
      quantityText: parsed.quantityText,
      unit:
        measurementId === null
          ? null
          : { measurementId, key: ctx.unitKeys.get(measurementId) ?? null },
      unitText: parsed.unitText,
      ingredientText: parsed.ingredientText,
      prepNotes: parsed.prepNotes,
      notes: parsed.notes,
      flags: parsed.flags,
      section,
    });
  }
  return result;
}

// NATG-244: an entry with no digits that ends in a colon or reads "For the
// ..." is a group header, not an ingredient. Its text, less the colon, is the
// section of the lines after it.
function sectionHeader(entry: string): string | null {
  if (/\d/.test(entry)) return null;
  if (!entry.endsWith(":") && !/^for the\b/i.test(entry)) return null;
  return entry.replace(/:+$/, "").trim() || null;
}

// Text, HowToStep and HowToSection, flattened in order. A text value with
// several lines (or <li>, <p>, <br> in it) is one step per line.
function steps(instructions: unknown): string[] {
  return values(instructions).flatMap((item): string[] => {
    if (typeof item === "string") return lines(item);
    if (typeof item !== "object" || item === null) return [];
    const node = item as SchemaNode;
    if (isType(node, "HowToSection") || "itemListElement" in node) {
      return steps(node.itemListElement);
    }
    const text = values(node.text ?? node.name)
      .map(singleLine)
      .join(" ");
    return text === "" ? [] : [text];
  });
}

// Keywords and categories, which may be comma-separated strings, trimmed
// and de-duplicated case-insensitively; the first spelling wins.
function tags(raw: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    for (const tag of singleLine(value).split(",")) {
      const trimmed = tag.trim();
      const folded = trimmed.toLowerCase();
      if (trimmed === "" || seen.has(folded)) continue;
      seen.add(folded);
      result.push(trimmed);
    }
  }
  return result;
}

// "4", 4, "4 servings", "Serves 4", "4-6": the first whole number in the
// first value that has one. Absent, zero or unreadable is null.
function servings(recipeYield: unknown): number | null {
  for (const value of values(recipeYield)) {
    const n =
      typeof value === "number"
        ? Math.floor(value)
        : typeof value === "string"
          ? Number(/\d+/.exec(value)?.[0] ?? NaN)
          : NaN;
    if (Number.isSafeInteger(n) && n > 0) return n;
  }
  return null;
}

const DURATION =
  /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i;

// ISO 8601 durations ("PT1H30M", "P1DT2H") as whole minutes, rounded.
// Anything else is null.
function minutes(duration: unknown): number | null {
  const [value] = values(duration);
  if (typeof value !== "string") return null;
  const text = value.trim();
  const match = DURATION.exec(text);
  if (match === null || text === "P" || text.toUpperCase().endsWith("T")) {
    return null;
  }
  const [, d = "0", h = "0", m = "0", s = "0"] = match;
  return Math.round(
    Number(d) * 1440 + Number(h) * 60 + Number(m) + Number(s) / 60,
  );
}

function values(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

// HTML or plain text to its lines of text, entities decoded, whitespace in
// each line collapsed, blank lines dropped. JSON-LD strings often carry
// markup or entities; microdata values are the element's HTML.
function lines(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return htmlToText(value)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "");
}

function singleLine(value: unknown): string {
  return lines(value).join(" ");
}

const BLOCK = "p, li, div, br, h1, h2, h3, h4, h5, h6, ol, ul, tr";

function htmlToText(value: string): string {
  if (!/[<&]/.test(value)) return value;
  const $ = load(value, null, false);
  $(BLOCK).after("\n");
  return $.root().text();
}
