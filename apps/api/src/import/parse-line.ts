import {
  parseIngredient,
  unitsOfMeasure,
  type ParseIngredientOptions,
} from "parse-ingredient";
import { resolveCup, type MetricEquivalent } from "./cup.js";
import { normaliseUnit, type MeasurementLookup } from "./measurement-lookup.js";

// Quantity and unit of one imported ingredient line (NATG-244). The
// parse-ingredient package does the parsing; nothing of its output shape is
// exported from here.

export type ParseFlag =
  // A unit was recognised but no measurement_name has it; unitText keeps it.
  | "unit_unmatched"
  // The unit names more than one measurement and no rule picks one: "pint"
  // and "fl oz" are US in en-US and imperial in en-GB.
  | "unit_ambiguous"
  // "1 lb 4 oz": quantity and unit are the first amount, notes the line.
  | "mixed_amount";

export interface ParsedLine {
  rawText: string;
  // Above zero, as a string to match Drizzle's numeric, or null.
  quantity: string | null;
  // The quantity as written: "1 1/2", "2-3", "½".
  quantityText: string | null;
  measurementId: number | null;
  // The unit as written: "cups", "tbsp".
  unitText: string | null;
  ingredientText: string;
  // parse-ingredient does not separate prep notes; story 5 does.
  prepNotes: string | null;
  notes: string | null;
  flags: ParseFlag[];
}

export function parseIngredientLine(
  line: string,
  ctx: { sourceHost: string; measurements: MeasurementLookup },
): ParsedLine {
  const rawText = line.trim();
  const [parsed] = parseIngredient(rawText, {
    ...parseOptions(ctx.measurements),
    descriptionMeasurements: true,
  });
  const flags: ParseFlag[] = [];
  const notes: string[] = [];

  const quantity =
    parsed?.quantity != null && parsed.quantity > 0 ? parsed.quantity : null;
  let unitText = parsed?.unitOfMeasure ?? null;
  let description = parsed?.description ?? rawText;
  const quantityText =
    quantity === null ? null : writtenQuantity(rawText, unitText, description);

  // "2-3" and "2 to 3" store the lower bound and keep the range in notes.
  if (parsed?.quantity2 != null && quantityText !== null) {
    notes.push(quantityText);
  }

  // "(375ml)" straight after the unit: a metric equivalent, not part of the
  // ingredient. Kept in notes; decides the cup under rule 1.
  let metricEquivalent: MetricEquivalent | null = null;
  // parse-ingredient's descriptionMeasurements index the description before
  // the bracket is removed.
  let consumed = 0;
  const bracket = BRACKETED_EQUIVALENT.exec(description);
  if (unitText !== null && bracket !== null) {
    const [whole, inner = "", amount = "", unit = ""] = bracket;
    notes.push(inner.trim());
    description = description.slice(whole.length);
    consumed = whole.length;
    const mlPerUnit = ML_PER_UNIT[normaliseUnit(unit)];
    if (mlPerUnit !== undefined) metricEquivalent = { amount, mlPerUnit };
  }

  // A second amount straight after the first ("1 lb 4 oz", "1 cup plus 2
  // tbsp") is left for the user to resolve on the review screen, also when a
  // metric equivalent sits between them: "1 cup (250ml) plus 2 tbsp".
  const second = parsed?.descriptionMeasurements?.find(
    (m) => m.startIndex >= consumed,
  );
  if (
    unitText !== null &&
    second !== undefined &&
    MIXED_CONNECTORS.has(
      description
        .slice(0, second.startIndex - consumed)
        .trim()
        .toLowerCase(),
    )
  ) {
    flags.push("mixed_amount");
    notes.push(rawText);
    description = description.slice(second.endIndex - consumed);
  }

  // "Salt, to taste": no quantity and no unit, the phrase in notes. A line
  // with a quantity ("1 tsp salt, or to taste") keeps it.
  if (quantity === null && TO_TASTE.test(description)) {
    description = description.replace(TO_TASTE, " ");
    notes.push("to taste");
    unitText = null;
  }

  let measurementId: number | null = null;
  if (unitText !== null) {
    const ids = matchUnit(
      ctx.measurements,
      unitText,
      parsed?.unitOfMeasureID ?? null,
    );
    const { cup_us, cup_metric } = ctx.measurements.cup;
    if (ids.length === 0) {
      flags.push("unit_unmatched");
    } else if (ids.length === 1) {
      measurementId = ids[0] ?? null;
    } else if (ids.includes(cup_us) && ids.includes(cup_metric)) {
      const size = resolveCup({
        cups: quantity,
        metricEquivalent,
        sourceHost: ctx.sourceHost,
      });
      measurementId = ctx.measurements.cup[size];
    } else {
      flags.push("unit_ambiguous");
    }
  }

  return {
    rawText,
    quantity: quantity === null ? null : String(quantity),
    quantityText,
    measurementId,
    unitText,
    ingredientText: description
      .replace(/\s+/g, " ")
      .replace(/^[\s,]+|[\s,]+$/g, ""),
    prepNotes: null,
    notes: notes.length === 0 ? null : notes.join("; "),
    flags,
  };
}

// "(375ml)", "(1 1/2 cups)", "( 250 g )" at the start of the description.
// Only a plain number followed by ml, l, g or kg is read as an equivalent;
// anything else in the brackets is still moved to notes.
const BRACKETED_EQUIVALENT =
  /^\s*\(((?:\s*(\d+(?:\.\d+)?)\s*(ml|millilitres?|milliliters?|l|litres?|liters?|g|grams?|kg)\b)?[^)]*)\)/i;

// Only volumes decide a cup; grams need the ingredient's density.
const ML_PER_UNIT: Readonly<Record<string, number>> = {
  ml: 1,
  millilitre: 1,
  millilitres: 1,
  milliliter: 1,
  milliliters: 1,
  l: 1000,
  litre: 1000,
  litres: 1000,
  liter: 1000,
  liters: 1000,
};

const MIXED_CONNECTORS = new Set(["", "plus", "and", "+"]);

const TO_TASTE = /,?\s*\b(?:or\s+)?to taste\b\.?/i;

// The unit as written first ("tbsp"), then parse-ingredient's id for it
// ("tablespoon"), which also covers plurals: measurement_name has none.
function matchUnit(
  lookup: MeasurementLookup,
  written: string,
  id: string | null,
): readonly number[] {
  for (const text of [written, id]) {
    if (text === null) continue;
    const ids = lookup.byName.get(normaliseUnit(text));
    if (ids !== undefined) return ids;
  }
  return [];
}

// Whatever precedes the unit, or the description when there is no unit.
function writtenQuantity(
  line: string,
  unitText: string | null,
  description: string,
): string | null {
  const end = line.indexOf(unitText ?? description);
  return end > 0 ? line.slice(0, end).trim() || null : null;
}

// parse-ingredient only recognises units it ships. The catalogue's names it
// does not know ("tin", "handful", "US cup") are added as extra units whose
// id is the normalised name, so matchUnit finds them. Built once per lookup.
const optionsByLookup = new WeakMap<
  MeasurementLookup,
  ParseIngredientOptions
>();

function parseOptions(lookup: MeasurementLookup): ParseIngredientOptions {
  const cached = optionsByLookup.get(lookup);
  if (cached !== undefined) return cached;

  const known = new Set<string>();
  for (const [id, uom] of Object.entries(unitsOfMeasure)) {
    for (const text of [id, uom.short, uom.plural, ...(uom.alternates ?? [])]) {
      known.add(normaliseUnit(text));
    }
  }
  const additionalUOMs: NonNullable<ParseIngredientOptions["additionalUOMs"]> =
    {};
  for (const name of lookup.byName.keys()) {
    if (!known.has(name)) {
      additionalUOMs[name] = { short: name, plural: pluralise(name) };
    }
  }
  const options: ParseIngredientOptions = {
    additionalUOMs,
    // Sizes are descriptors, not units: "1 large onion".
    ignoreUOMs: ["small", "medium", "large"],
  };
  optionsByLookup.set(lookup, options);
  return options;
}

function pluralise(name: string): string {
  return /(?:s|x|ch|sh)$/.test(name) ? `${name}es` : `${name}s`;
}
