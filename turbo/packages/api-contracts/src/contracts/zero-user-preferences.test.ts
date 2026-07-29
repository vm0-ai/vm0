import { describe, expect, it } from "vitest";

import { userPreferencesResponseSchema } from "./zero-user-preferences";

describe("user preferences contract", () => {
  it("normalizes the previous locale in an API response", () => {
    const preferences = userPreferencesResponseSchema.parse({
      timezone: null,
      locale: "zh-CN",
      pinnedAgentIds: [],
      sendMode: "enter",
      morningBriefEnabled: false,
      morningBriefNextRunAt: null,
      captureNetworkBodiesRemaining: 0,
    });

    expect(preferences.locale).toBe("en-US");
  });
});
