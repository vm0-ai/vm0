import { describe, expect, it, vi } from "vitest";
import { retryTransientLoad } from "../utils.ts";

describe("retryTransientLoad", () => {
  it("passes the owner signal to the load", async () => {
    const controller = new AbortController();
    const load = vi.fn<(signal: AbortSignal) => Promise<string>>((signal) => {
      expect(signal).toBe(controller.signal);
      return Promise.resolve("loaded");
    });

    await expect(retryTransientLoad(load, controller.signal)).resolves.toBe(
      "loaded",
    );
    expect(load).toHaveBeenCalledOnce();
  });

  it("does not start a load after the owner aborts", async () => {
    const controller = new AbortController();
    const load = vi.fn<(signal: AbortSignal) => Promise<string>>(() => {
      return Promise.resolve("loaded");
    });
    controller.abort();

    await expect(
      retryTransientLoad(load, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(load).not.toHaveBeenCalled();
  });
});
