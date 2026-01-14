import { describe, it, expect } from "vitest";
import {
  Reason,
  detach,
  resetSignal,
  createDeferredPromise,
  geometryStyle,
} from "../utils.ts";
import { createStore } from "ccstate";

describe("utils", () => {
  describe("reason enum", () => {
    it("should have correct values", () => {
      expect(Reason.DomCallback).toBe("dom_callback");
      expect(Reason.Entrance).toBe("entrance");
      expect(Reason.Deferred).toBe("deferred");
      expect(Reason.Daemon).toBe("daemon");
    });
  });

  describe("detach", () => {
    it("should handle non-promise values", () => {
      expect(() => detach("value", Reason.Entrance)).not.toThrow();
    });

    it("should handle promise values", () => {
      expect(() =>
        detach(Promise.resolve("value"), Reason.Entrance),
      ).not.toThrow();
    });
  });

  describe("resetSignal", () => {
    it("should create a new signal on each call", () => {
      const store = createStore();
      const reset$ = resetSignal();

      const signal1 = store.set(reset$);
      const signal2 = store.set(reset$);

      expect(signal1).not.toBe(signal2);
      expect(signal1.aborted).toBeTruthy();
      expect(signal2.aborted).toBeFalsy();
    });

    it("should combine with provided signals", () => {
      const store = createStore();
      const reset$ = resetSignal();
      const controller = new AbortController();

      const signal = store.set(reset$, controller.signal);

      expect(signal.aborted).toBeFalsy();
      controller.abort();
      expect(signal.aborted).toBeTruthy();
    });
  });

  describe("createDeferredPromise", () => {
    it("should resolve with value", async () => {
      const defer = createDeferredPromise<number>(AbortSignal.any([]));

      expect(defer.settled()).toBeFalsy();

      defer.resolve(42);
      expect(defer.settled()).toBeTruthy();

      await expect(defer.promise).resolves.toBe(42);
    });

    it("should auto-reject when signal is aborted", async () => {
      const controller = new AbortController();
      const defer = createDeferredPromise<number>(controller.signal);

      expect(defer.settled()).toBeFalsy();

      const abortError = new Error("aborted");
      abortError.name = "AbortError";
      controller.abort(abortError);

      expect(defer.settled()).toBeTruthy();
      await expect(defer.promise).rejects.toThrow("aborted");
    });

    it("should not auto-reject if already settled", async () => {
      const controller = new AbortController();
      const defer = createDeferredPromise<number>(controller.signal);

      defer.resolve(100);
      expect(defer.settled()).toBeTruthy();

      // Aborting after settlement should not change the result
      controller.abort(new Error("too late"));

      await expect(defer.promise).resolves.toBe(100);
    });
  });

  describe("geometryStyle", () => {
    it("should return number width to css style", () => {
      expect(geometryStyle({ width: 100 })).toStrictEqual({
        width: "100px",
      });
    });

    it("should return number height to css style", () => {
      expect(geometryStyle({ height: 200 })).toStrictEqual({
        height: "200px",
      });
    });

    it("should return both width and height", () => {
      expect(geometryStyle({ width: 100, height: 200 })).toStrictEqual({
        width: "100px",
        height: "200px",
      });
    });

    it("should return empty object for empty input", () => {
      expect(geometryStyle({})).toStrictEqual({});
    });

    it("should handle all geometry properties", () => {
      expect(
        geometryStyle({
          left: 10,
          top: 20,
          right: 30,
          bottom: 40,
        }),
      ).toStrictEqual({
        left: "10px",
        top: "20px",
        right: "30px",
        bottom: "40px",
      });
    });

    it("should handle scale property", () => {
      expect(geometryStyle({ scale: 1.5 })).toStrictEqual({
        transform: "scale(1.5)",
      });
    });
  });
});
