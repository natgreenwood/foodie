import { load } from "cheerio";
import type { IngredientCandidate } from "../match-ingredients.js";
import type { MeasurementLookup } from "../measurement-lookup.js";
import { parseIngredientLine, type ParseFlag } from "../parse-line.js";
import { Budget } from "./budget.js";
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
  // key is measurement.key: null for a unit the seed did not ship.
  unit: { measurementId: number; key: string | null } | null;
  unitText: string | null;
  ingredientText: string;
  prepNotes: string | null;
  notes: string | null;
  flags: ParseFlag[];
  // The group header the line sits under ("For the sauce"), or null.
  section: string | null;
  // The catalogue ingredient proposed for the line, and the candidates it was
  // chosen from (NATG-321). Null and empty here; the ingredient match in
  // match-ingredients.ts fills them in, and flags ingredient_unmatched.
  ingredientId: number | null;
  candidates: IngredientCandidate[];
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
}

// The first Recipe the page declares, or null if it declares none. When the
// method that found it found more than one, a warning says so: the others are
// not returned. Throws BudgetExceededError for a page that needs more work
// than budget.ts allows; the route answers that as no_recipe_found.
export function extractRecipe(
  html: string,
  ctx: ExtractContext,
): ExtractedRecipe | null {
  const $ = load(html);
  const budget = new Budget();
  const methods: [Extraction, () => SchemaNode[]][] = [
    ["json-ld", () => jsonLdRecipes($, budget)],
    ["microdata", () => microdataRecipes($, budget)],
  ];
  for (const [extraction, find] of methods) {
    const [first, ...others] = find();
    if (first === undefined) continue;
    return {
      extraction,
      warnings: others.length > 0 ? ["multiple_recipes_found"] : [],
      recipe: draft(first, $("title").first().text().trim(), budget, ctx),
    };
  }
  return null;
}

// A Recipe with no name takes the page's <title>.
// A text value split into lines can hold more lines than the budget let it
// hold values, so the lines are checked too.
function draft(
  node: SchemaNode,
  pageTitle: string,
  budget: Budget,
  ctx: ExtractContext,
): DraftRecipe {
  // Older microdata uses the retired `ingredients` property.
  const entries = values(node.recipeIngredient ?? node.ingredients)
    .flatMap(lines)
    .map(capLength);
  budget.check("valuesPerProperty", entries.length);
  const stepTexts = steps(node.recipeInstructions).map(capLength);
  budget.check("valuesPerProperty", stepTexts.length);
  return {
    title:
      values(node.name).map(singleLine).find(Boolean) ?? singleLine(pageTitle),
    servings: servings(node.recipeYield),
    prepMinutes: minutes(node.prepTime),
    cookMinutes: minutes(node.cookTime),
    ingredients: ingredients(entries, ctx),
    steps: stepTexts.map((text, i) => ({
      position: i + 1,
      text,
    })),
    tags: tags([...values(node.keywords), ...values(node.recipeCategory)]),
  };
}

// No real ingredient line or step comes near this. Longer text is cut
// rather than handed whole to the line parser (SEC-2 on NATG-245).
export const MAX_LINE_CHARS = 1_000;

function capLength(text: string): string {
  return text.length > MAX_LINE_CHARS
    ? text.slice(0, MAX_LINE_CHARS).trimEnd()
    : text;
}

function ingredients(
  entries: readonly string[],
  ctx: ExtractContext,
): DraftIngredient[] {
  const result: DraftIngredient[] = [];
  let section: string | null = null;
  for (const entry of entries) {
    const header = sectionHeader(entry);
    if (header !== null) section = header.section;
    const line = header === null ? entry : header.rest;
    if (line === null) continue;
    const { measurementId, ...parsed } = parseIngredientLine(line, ctx);
    result.push({
      position: result.length + 1,
      rawText: parsed.rawText,
      quantity: parsed.quantity,
      quantityText: parsed.quantityText,
      unit:
        measurementId === null
          ? null
          : {
              measurementId,
              key: ctx.measurements.keys.get(measurementId) ?? null,
            },
      unitText: parsed.unitText,
      ingredientText: parsed.ingredientText,
      prepNotes: parsed.prepNotes,
      notes: parsed.notes,
      flags: parsed.flags,
      section,
      ingredientId: null,
      candidates: [],
    });
  }
  return result;
}

// NATG-244, refined on NATG-245. A group header is an entry ending in a
// colon (no ingredient line does), or "For the ..." on its own with no
// digits. Its text is the section of the lines after it. A "For ..." entry
// with text after the colon is both: "For the garnish: parsley" is the
// header, then "parsley" as the first line under it. Any other entry,
// "Salt: to taste" included, is an ingredient line.
function sectionHeader(
  entry: string,
): { section: string; rest: string | null } | null {
  const trimmed = entry.trim();
  if (trimmed.endsWith(":")) {
    const section = trimmed.replace(/:+$/, "").trim();
    return section === "" ? null : { section, rest: null };
  }
  const colon = trimmed.indexOf(":");
  if (colon === -1) {
    return /^for the\b/i.test(trimmed) && !/\d/.test(trimmed)
      ? { section: trimmed, rest: null }
      : null;
  }
  const before = trimmed.slice(0, colon).trim();
  if (!/^for\b/i.test(before)) return null;
  return { section: before, rest: trimmed.slice(colon + 1).trim() };
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
// first value that has one. A number followed by a mass or volume unit
// ("500g", "1.5 l") is an amount, not servings. Absent, zero or unreadable
// is null.
function servings(recipeYield: unknown): number | null {
  for (const value of values(recipeYield)) {
    const n =
      typeof value === "number"
        ? Math.floor(value)
        : typeof value === "string"
          ? servingsIn(value)
          : NaN;
    if (Number.isSafeInteger(n) && n > 0) return n;
  }
  return null;
}

const AMOUNT_UNIT = /^\s*(?:g|kg|ml|l|oz|lbs?)\b/i;

function servingsIn(text: string): number {
  const match = /\d+(?:[.,]\d+)?/.exec(text);
  if (match === null) return NaN;
  if (AMOUNT_UNIT.test(text.slice(match.index + match[0].length))) return NaN;
  return Math.floor(Number(match[0].replace(",", ".")));
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
