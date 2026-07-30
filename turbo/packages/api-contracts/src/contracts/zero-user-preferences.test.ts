import { describe, expect, it } from "vitest";

import {
  userLocaleSchema,
  userPreferencesResponseSchema,
} from "./zero-user-preferences";

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

  it("accepts the Korean application locale", () => {
    expect(userLocaleSchema.parse("ko-KR")).toBe("ko-KR");
  });
});
