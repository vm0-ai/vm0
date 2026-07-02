import { describe, expect, it, vi } from "vitest";
import {
  latestWinsGuard,
  latestWinsSingleFlight,
  singleFlight,
} from "./desktop-async-control";

function deferred<TResult>() {
  let resolve: (value: TResult) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<TResult>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("singleFlight", () => {
  it("shares one in-flight task and clears after it settles", async () => {
    const firstRefresh = deferred<string>();
    const task = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(firstRefresh.promise)
      .mockResolvedValueOnce("second");
    const refresh = singleFlight(task);

    const first = refresh();
    const second = refresh();

    expect(first).toBe(second);
    expect(refresh.inFlight).toBe(true);
    expect(task).toHaveBeenCalledOnce();

    firstRefresh.resolve("first");
    await expect(first).resolves.toBe("first");
    expect(refresh.inFlight).toBe(false);

    await expect(refresh()).resolves.toBe("second");
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("does not let a cleared old task unset a newer in-flight task", async () => {
    const firstRefresh = deferred<string>();
    const secondRefresh = deferred<string>();
    const task = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(firstRefresh.promise)
      .mockReturnValueOnce(secondRefresh.promise);
    const refresh = singleFlight(task);

    const first = refresh();
    refresh.clear();
    const second = refresh();

    expect(task).toHaveBeenCalledTimes(2);

    firstRefresh.resolve("first");
    await expect(first).resolves.toBe("first");
    expect(refresh.inFlight).toBe(true);

    secondRefresh.resolve("second");
    await expect(second).resolves.toBe("second");
    expect(refresh.inFlight).toBe(false);
  });
});

describe("latestWinsSingleFlight", () => {
  it("coalesces repeated requests into one rerun after the current task", async () => {
    const firstRun = deferred<void>();
    const task = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(firstRun.promise)
      .mockResolvedValueOnce(undefined);
    const run = latestWinsSingleFlight(task);

    run();
    run();
    run();

    expect(task).toHaveBeenCalledOnce();

    firstRun.resolve();
    await flushPromises();

    expect(task).toHaveBeenCalledTimes(2);
  });

  it("reports task errors and still runs the latest requested task", async () => {
    const error = new Error("refresh failed");
    const onError = vi.fn<(error: unknown) => void>();
    const task = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(undefined);
    const run = latestWinsSingleFlight(task, { onError });

    run();
    run();
    await flushPromises();

    expect(onError).toHaveBeenCalledWith(error);
    expect(task).toHaveBeenCalledTimes(2);
  });
});

describe("latestWinsGuard", () => {
  it("marks older tokens stale when a newer token is created", () => {
    const next = latestWinsGuard();

    const first = next();
    expect(first.isCurrent()).toBe(true);

    const second = next();

    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);
  });
});
