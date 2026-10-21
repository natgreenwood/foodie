import type { ChosenIngredient } from "./IngredientPicker";
import type { ImportPreview, PreviewIngredient, SaveLine } from "./imports";
import { parseQuantity } from "./quantity";

// What the cook has settled on for one preview line, and whether it can be
// saved. A line is ready once it has an ingredient, a unit or "No unit",
// and a quantity that is empty or a number above 0.

// "" is no unit chosen yet; "none" is the cook's "No unit".
export type UnitChoice = "" | "none" | number;

export interface LineChoice {
  quantity: string;
  unit: UnitChoice;
  ingredient: ChosenIngredient | null;
  // Why the last save refused this line (a 422's positions), until the
  // line is changed.
  rejected: "unresolved" | "invalid" | null;
}

// The parse flags that mean the amount needs the cook: the unit select
// starts on "Choose a unit…" for these.
export const AMOUNT_FLAGS = [
  "mixed_amount",
  "range",
  "unit_unmatched",
  "unit_ambiguous",
  "no_quantity",
] as const;

export function amountFlags(line: PreviewIngredient): string[] {
  return line.flags.filter((flag) =>
    (AMOUNT_FLAGS as readonly string[]).includes(flag),
  );
}

export function initialChoice(line: PreviewIngredient): LineChoice {
  const flagged = amountFlags(line).length > 0;
  const ingredient =
    line.ingredientId === null
      ? null
      : (line.candidates.find((c) => c.ingredientId === line.ingredientId) ??
        null);
  return {
    // A mixed amount's quantity is only its first part ("1" of "1 lb 4 oz"),
    // so the cook enters the whole amount instead.
    quantity: line.flags.includes("mixed_amount") ? "" : (line.quantity ?? ""),
    unit: flagged ? "" : line.unit ? line.unit.measurementId : "none",
    ingredient: ingredient && {
      id: ingredient.ingredientId,
      name: ingredient.name,
    },
    rejected: null,
  };
}

export interface LineStatus {
  ready: boolean;
  needsIngredient: boolean;
  // No unit chosen, or a unit the picker does not offer.
  needsUnit: boolean;
  badQuantity: boolean;
  label: string;
  tone: "ready" | "warn" | "bad";
}

export function lineStatus(
  choice: LineChoice,
  units: ReadonlySet<number>,
): LineStatus {
  const needsIngredient = choice.ingredient === null;
  const needsUnit =
    choice.unit === "" ||
    (typeof choice.unit === "number" && !units.has(choice.unit));
  const badQuantity = parseQuantity(choice.quantity) === false;
  const checkAmount = needsUnit || badQuantity;
  const ready = !needsIngredient && !checkAmount && choice.rejected === null;
  const label = ready
    ? "Ready"
    : choice.rejected !== null
      ? "Couldn't save this line"
      : needsIngredient && checkAmount
        ? "Needs ingredient · check amount"
        : needsIngredient
          ? "Needs an ingredient"
          : "Check the amount";
  return {
    ready,
    needsIngredient,
    needsUnit,
    badQuantity,
    label,
    tone: ready
      ? "ready"
      : needsIngredient || choice.rejected !== null
        ? "bad"
        : "warn",
  };
}

// The amount as the page wrote it, before the ingredient: "1 lb 4 oz" of
// "1 lb 4 oz boneless chicken thighs".
function writtenAmount(line: PreviewIngredient): string {
  const at = line.rawText
    .toLowerCase()
    .lastIndexOf(line.ingredientText.toLowerCase());
  const amount = at > 0 ? line.rawText.slice(0, at).trim() : "";
  return amount.replace(/[\s,]+$/, "") || line.rawText;
}

// What the page's text keeps as notes once the cook chooses "No unit": the
// whole line, so the unit the page wrote is not lost with it ("1 pint
// (500ml) milk", whose parser notes are only "500ml", NATG-373). A line
// with no amount at all keeps the parser's notes ("to taste"), which is
// all the page said about the amount.
function pageNotes(line: PreviewIngredient): string {
  const onlyNoQuantity = amountFlags(line).every(
    (flag) => flag === "no_quantity",
  );
  return onlyNoQuantity ? (line.notes ?? line.rawText) : line.rawText;
}

// The hint under a flagged line, for each amount flag it has.
export function flagHint(line: PreviewIngredient, flag: string): string {
  const unit = line.unitText ?? "the unit";
  switch (flag) {
    case "mixed_amount":
      return `“${writtenAmount(line)}” is two amounts. Enter it as one amount (for example 1.25 lb), or choose No unit to keep the page’s text in the notes.`;
    case "range": {
      const range = line.quantityText ?? writtenAmount(line);
      return line.quantity === null
        ? `“${range}” is a range. Enter one amount, or choose No unit to keep “${range}” in the notes.`
        : `“${range}” is a range. We used ${line.quantity} and kept “${range}” in the notes. Choose a unit, or No unit, to confirm.`;
    }
    case "unit_unmatched":
      return `We don’t recognise “${unit}”. Choose a unit, or No unit to keep the page’s text in the notes.`;
    case "no_quantity":
      return `No amount given. Choose No unit to keep “${pageNotes(line)}” in the notes.`;
    case "unit_ambiguous":
      return `“${unit}” could mean more than one unit. Choose which.`;
    default:
      return "";
  }
}

// The notes a line is saved with. "No unit" on a flagged line keeps the
// page's text, so nothing it said is lost; a real unit drops that again.
// A mixed amount's notes are the whole line, which the one amount the cook
// entered replaces. Otherwise the parser's notes ("2–3" for a range).
export function lineNotes(
  line: PreviewIngredient,
  choice: LineChoice,
): string | null {
  if (choice.unit === "none" && amountFlags(line).length > 0) {
    return pageNotes(line);
  }
  if (line.flags.includes("mixed_amount")) return null;
  return line.notes;
}

export function saveLine(
  line: PreviewIngredient,
  choice: LineChoice,
): SaveLine {
  const quantity = parseQuantity(choice.quantity);
  return {
    position: line.position,
    ingredientId: choice.ingredient?.id ?? 0,
    measurementId: typeof choice.unit === "number" ? choice.unit : null,
    quantity: quantity === false ? null : quantity,
    prepNotes: line.prepNotes,
    notes: lineNotes(line, choice),
  };
}

export function saveRequest(
  preview: ImportPreview,
  choices: ReadonlyMap<number, LineChoice>,
) {
  const { recipe } = preview;
  return {
    sourceUrl: preview.sourceUrl,
    recipe: {
      title: recipe.title,
      servings: recipe.servings,
      prepMinutes: recipe.prepMinutes,
      cookMinutes: recipe.cookMinutes,
      ingredients: recipe.ingredients.map((line) =>
        saveLine(line, choices.get(line.position) ?? initialChoice(line)),
      ),
      steps: recipe.steps,
      tags: recipe.tags,
    },
  };
}
