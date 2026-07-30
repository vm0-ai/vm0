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

  it("accepts the canonical Japanese locale", () => {
    expect(userLocaleSchema.parse("ja-JP")).toBe("ja-JP");
    expect(
      userPreferencesResponseSchema.parse({
        timezone: null,
        locale: "ja-JP",
        supportedLocales: ["en-US", "pt-BR", "ja-JP"],
        pinnedAgentIds: [],
        sendMode: "enter",
        morningBriefEnabled: false,
        morningBriefNextRunAt: null,
        captureNetworkBodiesRemaining: 0,
      }),
    ).toMatchObject({
      locale: "ja-JP",
      supportedLocales: ["en-US", "pt-BR", "ja-JP"],
    });
  });
});
