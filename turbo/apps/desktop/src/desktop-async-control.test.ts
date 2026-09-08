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
  it("publishes ownership before synchronous task reentry", async () => {
    const result = deferred<string>();
    const joined: Promise<string>[] = [];
    const ownership: boolean[] = [];
    const refresh = singleFlight(() => {
      ownership.push(refresh.inFlight);
      // Bound the regression on the old implementation instead of overflowing.
      if (ownership.length < 8) joined.push(refresh());
      return result.promise;
    });

    const first = refresh();
    result.resolve("restored");
    expect(await Promise.all([first, ...joined])).toEqual([
      "restored",
      "restored",
    ]);
    expect(ownership).toEqual([true]);
    expect(joined).toEqual([first]);
    expect(refresh.inFlight).toBe(false);
  });

  it("shares a synchronous throw with reentrant callers and permits retry", async () => {
    const error = new Error("task entry failed");
    let entered = false;
    let joined: Promise<string> | undefined;
    const refresh = singleFlight<string>(() => {
      if (entered) return Promise.resolve("retry");
      entered = true;
      joined = refresh();
      throw error;
    });

    const first = refresh();
    const results = await Promise.allSettled([first, joined]);
    expect(results).toEqual([
      { status: "rejected", reason: error },
      { status: "rejected", reason: error },
    ]);
    expect(joined).toBe(first);
    expect(refresh.inFlight).toBe(false);
    await expect(refresh()).resolves.toBe("retry");
  });

  it("retains a replacement started synchronously after clear inside task entry", async () => {
    const oldResult = deferred<string>();
    const newResult = deferred<string>();
    let entered = false;
    let replacement: Promise<string> | undefined;
    const refresh = singleFlight(() => {
      if (entered) return newResult.promise;
      entered = true;
      refresh.clear();
      replacement = refresh();
      return oldResult.promise;
    });

    const old = refresh();
    const joined = refresh();
    oldResult.reject(new Error("retired"));
    await expect(old).rejects.toThrow("retired");
    expect(refresh.inFlight).toBe(true);
    expect(joined).toBe(replacement);
    newResult.resolve("current");
    await expect(replacement).resolves.toBe("current");
    expect(refresh.inFlight).toBe(false);
  });

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
