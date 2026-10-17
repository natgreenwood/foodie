import { describe, expect, it } from "vitest";
import { slidingWindow } from "./sliding-window.js";

describe("slidingWindow", () => {
  it("admits the limit in a window, then again once the oldest has aged out", () => {
    let now = 0;
    const window = slidingWindow({
      limit: 3,
      windowMs: 1000,
      maxKeys: 10,
      clock: () => now,
    });

    for (const at of [0, 500, 900]) {
      now = at;
      expect(window.admit("a")).toBe(true);
    }
    now = 950;
    expect(window.admit("a")).toBe(false);
    // Other keys have their own count.
    expect(window.admit("b")).toBe(true);
    // The event at 0 has aged out, and the refused one at 950 was never
    // counted: one more is admitted.
    now = 1000;
    expect(window.admit("a")).toBe(true);
    expect(window.admit("a")).toBe(false);
  });

  it("keeps at most maxKeys keys, dropping the one used least recently", () => {
    let now = 0;
    const window = slidingWindow({
      limit: 1,
      windowMs: 60_000,
      maxKeys: 3,
      clock: () => now,
    });
    for (const key of ["a", "b", "c"]) window.admit(key);
    // "a" is used again, so "b" is now the least recent.
    expect(window.admit("a")).toBe(false);

    now = 1;
    expect(window.admit("d")).toBe(true);

    expect(window.size()).toBe(3);
    // "b" was dropped, so it starts afresh; "a" and "c" are still counted.
    expect(window.admit("b")).toBe(true);
    expect(window.admit("a")).toBe(false);
  });
});
