import { describe, expect, it, vi } from "vitest";

import { createRetryableLazyModule } from "../retryable-lazy-module.ts";
import { createDeferredPromise } from "../utils.ts";
import { testContext } from "./test-helpers.ts";

const context = testContext();

describe("retryable lazy module", () => {
  it("shares one promise and resolved module identity", async () => {
    const attempt = createDeferredPromise<{ readonly id: string }>(
      context.signal,
    );
    const importer = vi.fn<() => Promise<{ readonly id: string }>>(() => {
      return attempt.promise;
    });
    const module = createRetryableLazyModule(importer);

    const first = module.load();
    const concurrent = module.load();
    expect(module.getLoaded()).toBeUndefined();
    expect(concurrent).toBe(first);
    expect(importer).toHaveBeenCalledTimes(1);

    const loaded = { id: "rich-content" } as const;
    attempt.resolve(loaded);
    await expect(first).resolves.toBe(loaded);
    expect(module.getLoaded()).toBe(loaded);
    expect(module.load()).toBe(first);
    await expect(module.load()).resolves.toBe(loaded);
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it("clears a failed attempt so the next request retries", async () => {
    const failed = createDeferredPromise<{ readonly id: string }>(
      context.signal,
    );
    const retried = createDeferredPromise<{ readonly id: string }>(
      context.signal,
    );
    const importer = vi
      .fn<() => Promise<{ readonly id: string }>>()
      .mockImplementationOnce(() => {
        return failed.promise;
      })
      .mockImplementationOnce(() => {
        return retried.promise;
      });
    const module = createRetryableLazyModule(importer);

    const first = module.load();
    const error = new Error("chunk unavailable");
    failed.reject(error);
    await expect(first).rejects.toBe(error);
    expect(module.getLoaded()).toBeUndefined();

    const retry = module.load();
    expect(retry).not.toBe(first);
    expect(importer).toHaveBeenCalledTimes(2);
    const loaded = { id: "retry" } as const;
    retried.resolve(loaded);
    await expect(retry).resolves.toBe(loaded);
    expect(module.getLoaded()).toBe(loaded);
  });
});
