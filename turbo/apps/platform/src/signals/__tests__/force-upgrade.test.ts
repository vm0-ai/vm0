import { afterEach, describe, expect, it, vi } from "vitest";

import { pollForceUpgradeRequirement } from "../force-upgrade.ts";

describe("force upgrade polling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("checks immediately and then polls every 60 seconds until an upgrade is required", async () => {
    vi.useFakeTimers();

    const check = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const onRequired = vi.fn();

    const poll = pollForceUpgradeRequirement({
      check,
      onRequired,
      pollIntervalMs: 60_000,
      signal: AbortSignal.any([]),
    });

    await vi.waitFor(() => {
      expect(check).toHaveBeenCalledTimes(1);
    });
    expect(onRequired).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(check).toHaveBeenCalledTimes(2);
    expect(onRequired).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    await poll;

    expect(check).toHaveBeenCalledTimes(3);
    expect(onRequired).toHaveBeenCalledOnce();
  });
});
