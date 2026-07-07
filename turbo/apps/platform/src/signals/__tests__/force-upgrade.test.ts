import { describe, expect, it, vi } from "vitest";

import { pollForceUpgradeRequirement } from "../force-upgrade.ts";

describe("force upgrade polling", () => {
  it("checks through the shared loop until an upgrade is required", async () => {
    const check = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const onRequired = vi.fn();

    const poll = pollForceUpgradeRequirement({
      check,
      onRequired,
      pollIntervalMs: 0,
      signal: AbortSignal.any([]),
    });

    await poll;

    expect(check).toHaveBeenCalledTimes(3);
    expect(onRequired).toHaveBeenCalledOnce();
  });
});
