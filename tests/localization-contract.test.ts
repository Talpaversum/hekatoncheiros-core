import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOCALE,
  resolvePlatformLocale,
  validateTranslationResource,
} from "../src/localization/contract.js";

describe("localization contract", () => {
  it("uses English as the final fallback", () => {
    expect(DEFAULT_LOCALE).toBe("en");
    expect(resolvePlatformLocale("cs")).toBe("cs");
    expect(resolvePlatformLocale("pt")).toBe("en");
  });

  it("detects invalid keys and placeholder mismatches", () => {
    expect(
      validateTranslationResource({
        locale: "cs",
        englishMessages: { "greeting.user": "Hello {{name}}" },
        messages: { "greeting.user": "Ahoj {{user}}", Invalid: "value" },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Placeholder mismatch"),
        expect.stringContaining("Invalid translation key"),
      ]),
    );
  });
});
