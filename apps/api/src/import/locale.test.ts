import { describe, expect, test } from "vitest";
import { cupForHost } from "./cup.js";
import { localeForHost } from "./locale.js";

describe("localeForHost", () => {
  test.each([
    ["www.bbcgoodfood.co.uk", "en-GB"],
    ["example.uk", "en-GB"],
    ["www.example.ie", "en-GB"],
    ["www.taste.com.au", "en-GB"],
    ["www.example.co.nz", "en-GB"],
    ["WWW.EXAMPLE.CO.UK.", "en-GB"],
    ["www.allrecipes.com", "en-US"],
    ["www.example.ca", "en-US"],
    ["recipetineats.com", "en-US"],
    ["www.example.com.au.example.com", "en-US"],
    ["ukrecipes.com", "en-US"],
  ])("%s is %s", (host, locale) => {
    expect(localeForHost(host)).toBe(locale);
  });

  test("does not change the cup rules: .co.uk is still the US cup", () => {
    expect(localeForHost("www.example.co.uk")).toBe("en-GB");
    expect(cupForHost("www.example.co.uk")).toBe("cup_us");
  });
});
