import { describe, expect, it, beforeEach, vi } from "vitest";

describe("abortSignal.any polyfill", () => {
  it("should have AbortSignal.any available", async () => {
    // Import polyfill to ensure it's loaded
    await import("../polyfill.ts");
    expect(typeof AbortSignal.any).toBe("function");
  });

  describe("combining signals", () => {
    beforeEach(async () => {
      await import("../polyfill.ts");
    });

    it("should return non-aborted signal when none are aborted", () => {
      const controller1 = new AbortController();
      const controller2 = new AbortController();

      const combined = AbortSignal.any([
        controller1.signal,
        controller2.signal,
      ]);

      expect(combined.aborted).toBeFalsy();
    });

    it("should return aborted signal when one is already aborted", () => {
      const controller1 = new AbortController();
      const controller2 = new AbortController();

      controller1.abort("test reason");

      const combined = AbortSignal.any([
        controller1.signal,
        controller2.signal,
      ]);

      expect(combined.aborted).toBeTruthy();
      expect(combined.reason).toBe("test reason");
    });

    it("should abort when any signal is aborted later", () => {
      const controller1 = new AbortController();
      const controller2 = new AbortController();

      const combined = AbortSignal.any([
        controller1.signal,
        controller2.signal,
      ]);
      const abortHandler = vi.fn();
      combined.addEventListener("abort", abortHandler);

      expect(combined.aborted).toBeFalsy();

      controller2.abort("second signal aborted");

      expect(combined.aborted).toBeTruthy();
      expect(combined.reason).toBe("second signal aborted");
      expect(abortHandler).toHaveBeenCalledTimes(1);
    });

    it("should propagate abort reason correctly", () => {
      const controller = new AbortController();
      const customError = new Error("Custom abort error");

      controller.abort(customError);

      const combined = AbortSignal.any([controller.signal]);

      expect(combined.aborted).toBeTruthy();
      expect(combined.reason).toBe(customError);
    });

    it("should handle empty signal array", () => {
      const combined = AbortSignal.any([]);

      expect(combined.aborted).toBeFalsy();
    });

    it("should only abort once even if multiple signals abort", () => {
      const controller1 = new AbortController();
      const controller2 = new AbortController();

      const combined = AbortSignal.any([
        controller1.signal,
        controller2.signal,
      ]);
      const abortHandler = vi.fn();
      combined.addEventListener("abort", abortHandler);

      controller1.abort("first");
      controller2.abort("second");

      // Should only be called once (first abort wins)
      expect(abortHandler).toHaveBeenCalledTimes(1);
      expect(combined.reason).toBe("first");
    });
  });
});
