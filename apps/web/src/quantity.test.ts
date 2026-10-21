import { describe, expect, it } from "vitest";
import { parseQuantity } from "./quantity";

describe("parseQuantity", () => {
  it.each([
    ["1.5", "1.5"],
    [".5", "0.5"],
    ["2", "2"],
    ["120", "120"],
    ["½", "0.5"],
    ["¾", "0.75"],
    ["⅓", "0.333333"],
    ["1/2", "0.5"],
    ["3/4", "0.75"],
    ["1 1/2", "1.5"],
    ["  2   1/4 ", "2.25"],
    ["1 ½", "1.5"],
    ["1½", "1.5"],
  ])("takes %j as %j", (text, decimal) => {
    expect(parseQuantity(text)).toBe(decimal);
  });

  it.each(["", "   "])("takes %j as no quantity", (text) => {
    expect(parseQuantity(text)).toBeNull();
  });

  it.each([
    "0",
    "0.0",
    "1/0",
    "2-3",
    "2–3",
    "a few",
    "1,5",
    "-1",
    "1 2",
    "1 1.5",
    "½ 1",
    "1e3",
    "1".repeat(40),
  ])("refuses %j", (text) => {
    expect(parseQuantity(text)).toBe(false);
  });
});
