import { describe, expect, it } from "vitest";

import {
  userLocaleSchema,
  userPreferencesResponseSchema,
} from "./zero-user-preferences";

describe("user preferences contract", () => {
  it("accepts Indonesian as a user locale", () => {
    const preferences = userPreferencesResponseSchema.parse({
      timezone: null,
      locale: "id-ID",
      supportedLocales: ["en-US", "pt-BR", "id-ID"],
      pinnedAgentIds: [],
      sendMode: "enter",
      morningBriefEnabled: false,
      morningBriefNextRunAt: null,
      captureNetworkBodiesRemaining: 0,
    });

    expect(preferences.locale).toBe("id-ID");
  });

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

  it("accepts the canonical Korean locale", () => {
    expect(userLocaleSchema.parse("ko-KR")).toBe("ko-KR");
    expect(
      userPreferencesResponseSchema.parse({
        timezone: null,
        locale: "ko-KR",
        supportedLocales: ["en-US", "pt-BR", "ja-JP", "ko-KR"],
        pinnedAgentIds: [],
        sendMode: "enter",
        morningBriefEnabled: false,
        morningBriefNextRunAt: null,
        captureNetworkBodiesRemaining: 0,
      }),
    ).toMatchObject({
      locale: "ko-KR",
      supportedLocales: ["en-US", "pt-BR", "ja-JP", "ko-KR"],
    });
  });
});
