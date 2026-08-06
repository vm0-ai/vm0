import { describe, expect, it } from "vitest";

import {
  ZERO_TRANSLATION_MAX_LANGUAGE_CHARS,
  ZERO_TRANSLATION_MAX_RESULT_TEXT_CHARS,
  ZERO_TRANSLATION_MAX_SOURCE_TEXT_CHARS,
  zeroTranslationRequestSchema,
  zeroTranslationResponseSchema,
} from "../zero-translation";

describe("zero translation contract", () => {
  it("accepts trimmed text and language selectors", () => {
    expect(
      zeroTranslationRequestSchema.parse({
        text: "  Hello, world.  ",
        sourceLanguage: "  English  ",
        targetLanguage: "  Simplified Chinese  ",
      }),
    ).toStrictEqual({
      text: "Hello, world.",
      sourceLanguage: "English",
      targetLanguage: "Simplified Chinese",
    });
  });

  it("allows source-language auto-detection", () => {
    expect(
      zeroTranslationRequestSchema.parse({
        text: "Bonjour",
        targetLanguage: "en",
      }),
    ).toStrictEqual({ text: "Bonjour", targetLanguage: "en" });
  });

  it("rejects empty or oversized inputs", () => {
    for (const request of [
      { text: "   ", targetLanguage: "English" },
      {
        text: "x".repeat(ZERO_TRANSLATION_MAX_SOURCE_TEXT_CHARS + 1),
        targetLanguage: "English",
      },
      { text: "hello", targetLanguage: "   " },
      {
        text: "hello",
        targetLanguage: "x".repeat(ZERO_TRANSLATION_MAX_LANGUAGE_CHARS + 1),
      },
    ]) {
      expect(zeroTranslationRequestSchema.safeParse(request).success).toBe(
        false,
      );
    }
  });

  it("bounds successful translation output", () => {
    expect(
      zeroTranslationResponseSchema.safeParse({
        text: "x".repeat(ZERO_TRANSLATION_MAX_RESULT_TEXT_CHARS + 1),
        metadata: { creditsCharged: 1 },
      }).success,
    ).toBe(false);
  });
});
