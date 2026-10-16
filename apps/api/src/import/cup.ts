// Which cup an unqualified "cup" on an imported line means, by the NATG-218
// rules in the epic's "Cup resolution" section, in their written order:
//
// 1. A metric equivalent next to the cup ("1 cup (250ml)") decides it.
// 2. Otherwise the source host: .com.au, .co.nz and .ca mean the metric cup;
//    everything else, .co.uk included, means the US cup.
// 3. Known AU/NZ/CA sites on .com (METRIC_CUP_HOSTS) mean the metric cup.
//    This is the exception to rule 2's "everything else".
// 4. The recipe keeps a per-recipe override (story 7), so this is a default.
// 5. Never by measurement_name locale (the seed names the metric cup "cup"
//    in en-GB) or by the page's lang / og:locale tags.

export type CupSize = "cup_us" | "cup_metric";

// Millilitres per cup, as seeded in measurement.factor_to_base.
export const CUP_ML: Readonly<Record<CupSize, number>> = {
  cup_us: 236.5882365,
  cup_metric: 250,
};

// Rule 3. Revisit once import logs show what people actually import.
export const METRIC_CUP_HOSTS: readonly string[] = [
  "recipetineats.com",
  "ricardocuisine.com",
];

// Rule 2.
const METRIC_CUP_SUFFIXES: readonly string[] = [".com.au", ".co.nz", ".ca"];

// A volume written next to the cup, e.g. the "375ml" in "1 1/2 cups (375ml)",
// with the number exactly as written so its precision is known.
export interface MetricEquivalent {
  amount: string;
  mlPerUnit: number;
}

export function resolveCup(input: {
  cups: number | null;
  metricEquivalent: MetricEquivalent | null;
  sourceHost: string;
}): CupSize {
  if (input.cups !== null && input.metricEquivalent !== null) {
    const fromEquivalent = cupFromMetricEquivalent(
      input.cups,
      input.metricEquivalent,
    );
    if (fromEquivalent !== null) return fromEquivalent;
  }
  return cupForHost(input.sourceHost);
}

// Rule 1. The written millilitres are rounded ("1/3 cup (80ml)"), so a cup
// size counts as a match when its exact volume rounds to what was written.
// When both sizes fit, or neither does, the equivalent decides nothing and
// the host rules apply.
export function cupFromMetricEquivalent(
  cups: number,
  equivalent: MetricEquivalent,
): CupSize | null {
  const writtenMl = Number(equivalent.amount) * equivalent.mlPerUnit;
  const toleranceMl =
    roundingTolerance(equivalent.amount) * equivalent.mlPerUnit;
  const fits = (Object.keys(CUP_ML) as CupSize[]).filter(
    (size) => Math.abs(cups * CUP_ML[size] - writtenMl) <= toleranceMl,
  );
  return fits.length === 1 ? (fits[0] ?? null) : null;
}

// Rules 2 and 3.
export function cupForHost(sourceHost: string): CupSize {
  const host = sourceHost.trim().toLowerCase().replace(/\.$/, "");
  if (METRIC_CUP_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return "cup_metric";
  }
  if (
    METRIC_CUP_HOSTS.some((site) => host === site || host.endsWith(`.${site}`))
  ) {
    return "cup_metric";
  }
  return "cup_us";
}

// Half the step the number was rounded to: "375" is ±2.5, "250" ±5, "237"
// ±0.5, "62.5" ±0.05.
function roundingTolerance(amount: string): number {
  const decimals = amount.split(".")[1]?.length ?? 0;
  if (decimals > 0) return 0.5 * 10 ** -decimals;
  const whole = Number(amount);
  if (whole % 10 === 0) return 5;
  if (whole % 5 === 0) return 2.5;
  return 0.5;
}
