import { describe, it, expect } from "vitest";
import {
  insufficientCredits,
  noModelProvider,
  isApiError,
} from "@vm0/api-services/errors";

// NOTE: Model provider pre-run check tests have been moved to
// zero/__tests__/build-zero-context.test.ts because model provider
// checks are now a zero layer concern in createZeroRun().

describe("pre-run checks", () => {
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
