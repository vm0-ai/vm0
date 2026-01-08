import { describe, it, expect } from "vitest";
import { Reason, detach, resetSignal } from "../utils.ts";
import { createStore } from "ccstate";

describe("utils", () => {
  describe("Reason enum", () => {
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
      expect(signal1.aborted).toBe(true);
      expect(signal2.aborted).toBe(false);
    });

    it("should combine with provided signals", () => {
      const store = createStore();
      const reset$ = resetSignal();
      const controller = new AbortController();

      const signal = store.set(reset$, controller.signal);

      expect(signal.aborted).toBe(false);
      controller.abort();
      expect(signal.aborted).toBe(true);
    });
  });
});
