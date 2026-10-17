// One way of getting a page. fetchPage tries its strategies in order and
// decides from each response whether to stop or fall back to the next, so a
// strategy only fetches: it does not judge the response. Network failures
// (refused, DNS, timeout) reject. A strategy never follows a redirect: it
// returns the 3xx, and fetchPage checks the next hop before requesting it.
//
// `addresses` are what the destination policy checked url's host resolves
// to. A strategy that can should connect only to those.
export interface FetchStrategy {
  name: StrategyName;
  fetch(url: string, addresses: readonly string[]): Promise<FetchResponse>;
  // If present, fetchPage asks for one session per call and makes every hop
  // through it, so the hops can share state such as cookies. The session is
  // dropped when the call ends; nothing in it reaches another call.
  session?(): FetchSession;
}

export type FetchSession = Pick<FetchStrategy, "fetch">;

// Headless Chromium is parked (NATG-239); it would add a name here.
export type StrategyName = "http" | "impit";

export interface FetchResponse {
  status: number;
  headers: Headers;
  // Empty when tooLarge is set.
  body: string;
  // The body passed MAX_BODY_BYTES; the rest was not read.
  tooLarge?: boolean;
}

// Per request, so a slow site cannot hold an import open indefinitely.
export const FETCH_TIMEOUT_MS = 15_000;

// No recipe page comes near this; a body that does is a download, not a page.
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

// The body's bytes, or null once it passes `limit`: reading stops there, so
// an endless or huge response costs at most `limit` bytes of memory.
export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  limit = MAX_BODY_BYTES,
): Promise<Buffer | null> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    size += value.byteLength;
    if (size > limit) {
      // The rest is discarded either way; a failure to cancel changes nothing.
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
}
