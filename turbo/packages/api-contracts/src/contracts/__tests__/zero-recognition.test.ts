import { describe, expect, it } from "vitest";

import {
  ZERO_RECOGNITION_MAX_PROMPT_CHARS,
  ZERO_RECOGNITION_MAX_TEXT_CHARS,
  zeroRecognitionImageMimeTypeSchema,
  zeroRecognitionRequestSchema,
  zeroRecognitionResponseSchema,
} from "../zero-recognition";

describe("zero recognition contract", () => {
  it("accepts one owned file id and a trimmed prompt", () => {
    expect(
      zeroRecognitionRequestSchema.parse({
        fileId: "00000000-0000-4000-8000-000000000001",
        prompt: "  describe this image  ",
      }),
    ).toStrictEqual({
      fileId: "00000000-0000-4000-8000-000000000001",
      prompt: "describe this image",
    });
  });

  it("rejects empty and oversized prompts", () => {
    expect(
      zeroRecognitionRequestSchema.safeParse({
        fileId: "00000000-0000-4000-8000-000000000001",
        prompt: "   ",
      }).success,
    ).toBe(false);
    expect(
      zeroRecognitionRequestSchema.safeParse({
        fileId: "00000000-0000-4000-8000-000000000001",
        prompt: "x".repeat(ZERO_RECOGNITION_MAX_PROMPT_CHARS + 1),
      }).success,
    ).toBe(false);
  });

  it("shares the supported image MIME policy", () => {
    for (const contentType of ["image/png", "image/jpeg", "image/webp"]) {
      expect(zeroRecognitionImageMimeTypeSchema.parse(contentType)).toBe(
        contentType,
      );
    }
    expect(
      zeroRecognitionImageMimeTypeSchema.safeParse("image/gif").success,
    ).toBe(false);
  });

  it("bounds successful recognition output", () => {
    expect(
      zeroRecognitionResponseSchema.safeParse({
        text: "x".repeat(ZERO_RECOGNITION_MAX_TEXT_CHARS + 1),
        metadata: { creditsCharged: 1 },
      }).success,
    ).toBe(false);
  });
});
