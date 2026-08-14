import { describe, expect, it } from "vitest";

import {
  IMAGE_RECOGNITION_MAX_PROMPT_CHARS,
  IMAGE_RECOGNITION_MAX_TEXT_CHARS,
  imageRecognitionMimeTypeSchema,
  imageRecognitionRequestSchema,
  imageRecognitionResponseSchema,
} from "../image-recognition";

describe("image recognition contract", () => {
  it("accepts one owned file id and a trimmed prompt", () => {
    expect(
      imageRecognitionRequestSchema.parse({
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
      imageRecognitionRequestSchema.safeParse({
        fileId: "00000000-0000-4000-8000-000000000001",
        prompt: "   ",
      }).success,
    ).toBe(false);
    expect(
      imageRecognitionRequestSchema.safeParse({
        fileId: "00000000-0000-4000-8000-000000000001",
        prompt: "x".repeat(IMAGE_RECOGNITION_MAX_PROMPT_CHARS + 1),
      }).success,
    ).toBe(false);
  });

  it("shares the supported image MIME policy", () => {
    for (const contentType of ["image/png", "image/jpeg", "image/webp"]) {
      expect(imageRecognitionMimeTypeSchema.parse(contentType)).toBe(
        contentType,
      );
    }
    expect(imageRecognitionMimeTypeSchema.safeParse("image/gif").success).toBe(
      false,
    );
  });

  it("bounds successful recognition output", () => {
    expect(
      imageRecognitionResponseSchema.safeParse({
        text: "x".repeat(IMAGE_RECOGNITION_MAX_TEXT_CHARS + 1),
        metadata: { creditsCharged: 1 },
      }).success,
    ).toBe(false);
  });
});
