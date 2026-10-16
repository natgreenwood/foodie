import type { FetchResponse } from "./strategy.js";

// Why Cloudflare stopped a response, or null if it did not. Either is worth
// retrying with a strategy that looks more like a browser.
//
// - "challenged": Cloudflare served a challenge page, which it marks with
//   `cf-mitigated: challenge` whatever the status. developers.cloudflare.com/
//   cloudflare-challenges/challenge-types/challenge-pages/detect-response/
// - "blocked": a 403 or 503 from a Cloudflare edge (`server: cloudflare`),
//   such as a WAF rule. The same statuses from the site's own server are its
//   answer, not a bot block, and are not retried.
export function cloudflareBlock(
  res: Pick<FetchResponse, "status" | "headers">,
): "challenged" | "blocked" | null {
  if (res.headers.get("cf-mitigated")?.trim().toLowerCase() === "challenge") {
    return "challenged";
  }
  const fromEdge =
    res.headers.get("server")?.trim().toLowerCase() === "cloudflare";
  if (fromEdge && (res.status === 403 || res.status === 503)) {
    return "blocked";
  }
  return null;
}
