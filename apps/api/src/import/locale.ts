// The catalogue locale a page's ingredient names are most likely written in,
// from its host (NATG-321). Only orders ingredient candidates: a name in this
// locale goes ahead of one with the same similarity in another. It decides
// nothing about cups, which follow their own rules in cup.ts (.co.uk is the
// US cup there).

export type PageLocale = "en-GB" | "en-US";

const EN_GB_SUFFIXES: readonly string[] = [".uk", ".ie", ".au", ".nz"];

export function localeForHost(sourceHost: string): PageLocale {
  const host = sourceHost.trim().toLowerCase().replace(/\.$/, "");
  return EN_GB_SUFFIXES.some((suffix) => host.endsWith(suffix))
    ? "en-GB"
    : "en-US";
}
