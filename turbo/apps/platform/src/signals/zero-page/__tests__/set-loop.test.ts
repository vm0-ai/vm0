import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLoop } from "../polling.ts";

const SHORT_DELAYS = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10] as const;

describe("setLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should resolve immediately when loopBody returns true", async () => {
    const signal = AbortSignal.timeout(5000);
    const loopBody = vi.fn().mockResolvedValue(true);

    await setLoop(loopBody, 10, signal, SHORT_DELAYS);

    expect(loopBody).toHaveBeenCalledOnce();
  });

  it("should call loopBody multiple times and resolve when done", async () => {
    const signal = AbortSignal.timeout(5000);
    const loopBody = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const promise = setLoop(loopBody, 10, signal, SHORT_DELAYS);
    await vi.runAllTimersAsync();
    await promise;

    expect(loopBody).toHaveBeenCalledTimes(3);
  });

  it("should apply fibonacci backoff on error and retry until success", async () => {
    const signal = AbortSignal.timeout(5000);
    const error = new Error("network error");
    const loopBody = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue(true);

    const promise = setLoop(loopBody, 10, signal, SHORT_DELAYS);
    await vi.runAllTimersAsync();
    await promise;

    expect(loopBody).toHaveBeenCalledTimes(2);
  });

  it("should propagate AbortError immediately", async () => {
    const signal = AbortSignal.timeout(5000);
    const abortError = new Error("Aborted");
    abortError.name = "AbortError";
    const loopBody = vi.fn().mockRejectedValue(abortError);

    await expect(
      setLoop(loopBody, 10, signal, SHORT_DELAYS),
    ).rejects.toMatchObject({
      name: "AbortError",
    });

    expect(loopBody).toHaveBeenCalledOnce();
  });

  it("should cap backoff at the last fibonacci entry after many errors", async () => {
    const signal = AbortSignal.timeout(5000);
    let callCount = 0;
    const loopBody = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 12) {
        throw new Error("fail");
      }
      return Promise.resolve(true);
    });

    const promise = setLoop(loopBody, 10, signal, SHORT_DELAYS);
    await vi.runAllTimersAsync();
    await promise;

    expect(callCount).toBe(13);
  });

  it("should reset fibonacci index after a successful iteration", async () => {
    const signal = AbortSignal.timeout(5000);
    const error = new Error("fail");
    const loopBody = vi
      .fn()
      .mockRejectedValueOnce(error) // error → fibonacci backoff
      .mockResolvedValueOnce(false) // success (not done) → fibIndex resets to 0
      .mockRejectedValueOnce(error) // error again → back to fib[0], not fib[1]
      .mockResolvedValue(true); // done

    const promise = setLoop(loopBody, 10, signal, SHORT_DELAYS);
    await vi.runAllTimersAsync();
    await promise;

    expect(loopBody).toHaveBeenCalledTimes(4);
  });
});
