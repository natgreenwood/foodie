// One way of getting a page. fetchPage tries its strategies in order and
// decides from each response whether to stop or fall back to the next, so a
// strategy only fetches: it does not judge the response. Network failures
// (refused, DNS, timeout) reject.
export interface FetchStrategy {
  name: StrategyName;
  fetch(url: string): Promise<FetchResponse>;
}

// Headless Chromium is parked (NATG-239); it would add a name here.
export type StrategyName = "http" | "impit";

export interface FetchResponse {
  status: number;
  // After redirects.
  finalUrl: string;
  headers: Headers;
  body: string;
}

// Per request, so a slow site cannot hold an import open indefinitely.
export const FETCH_TIMEOUT_MS = 15_000;
