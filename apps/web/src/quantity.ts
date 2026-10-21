// Quantities as a cook types them: a decimal ("1.5", ".5"), a fraction
// ("1/2", "½") or a mixed number ("1 1/2", "1½", "1 ½"). Ranges and
// anything else are not amounts; the page's text for those stays in notes.

const VULGAR: Record<string, number> = {
  "¼": 1 / 4,
  "½": 1 / 2,
  "¾": 3 / 4,
  "⅐": 1 / 7,
  "⅑": 1 / 9,
  "⅒": 1 / 10,
  "⅓": 1 / 3,
  "⅔": 2 / 3,
  "⅕": 1 / 5,
  "⅖": 2 / 5,
  "⅗": 3 / 5,
  "⅘": 4 / 5,
  "⅙": 1 / 6,
  "⅚": 5 / 6,
  "⅛": 1 / 8,
  "⅜": 3 / 8,
  "⅝": 5 / 8,
  "⅞": 7 / 8,
};

const DECIMAL = /^(?:\d+(?:\.\d+)?|\.\d+)$/;
const FRACTION = /^(\d+)\/(\d+)$/;

function fractionValue(text: string): number | null {
  const vulgar = VULGAR[text];
  if (vulgar !== undefined) return vulgar;
  const match = FRACTION.exec(text);
  if (!match) return null;
  const denominator = Number(match[2]);
  return denominator === 0 ? null : Number(match[1]) / denominator;
}

function value(text: string): number | null {
  if (DECIMAL.test(text)) return Number(text);
  const fraction = fractionValue(text);
  if (fraction !== null) return fraction;
  // A whole number then a fraction, with or without a space before a
  // vulgar fraction: "1 1/2", "1 ½", "1½".
  const mixed = /^(\d+)(?:\s+(\S+)|([¼-¾⅐-⅞]))$/u.exec(text);
  if (!mixed) return null;
  const part = fractionValue(mixed[2] ?? mixed[3] ?? "");
  return part === null ? null : Number(mixed[1]) + part;
}

// The decimal POST /imports takes, at most six decimal places and 32
// characters; null for an empty field; false for anything that is not an
// amount above 0.
export function parseQuantity(text: string): string | null | false {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed === "") return null;
  const amount = value(trimmed);
  if (amount === null || !Number.isFinite(amount)) return false;
  const decimal = amount.toFixed(6).replace(/\.?0+$/, "");
  // toFixed writes 1e21 and above in exponent form, which is no decimal.
  return decimal === "0" || decimal.length > 32 || !DECIMAL.test(decimal)
    ? false
    : decimal;
}
