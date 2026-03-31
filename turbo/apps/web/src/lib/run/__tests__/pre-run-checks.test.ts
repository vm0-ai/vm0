import { describe, it, expect } from "vitest";
import { insufficientCredits, noModelProvider, isApiError } from "../../errors";

describe("pre-run checks — error type guards", () => {
  describe("isApiError generic type guard", () => {
    it("should identify NoModelProviderError as API error", () => {
      const error = noModelProvider();
      expect(isApiError(error)).toBe(true);
      expect(error.statusCode).toBe(422);
      expect(error.code).toBe("NO_MODEL_PROVIDER");
    });

    it("should identify InsufficientCreditsError as API error", () => {
      const error = insufficientCredits();
      expect(isApiError(error)).toBe(true);
      expect(error.statusCode).toBe(402);
      expect(error.code).toBe("INSUFFICIENT_CREDITS");
    });

    it("should not identify plain Error as API error", () => {
      const error = new Error("plain error");
      expect(isApiError(error)).toBe(false);
    });
  });
});
