import { describe, expect, it } from "vitest";

import {
  SUPPORTED_USER_LOCALES,
  updateUserPreferencesRequestSchema,
  userLocaleSchema,
  userPreferencesResponseSchema,
} from "./user-preferences";

describe("user preferences contract", () => {
  it("keeps the deprecated Morning Brief shape parseable for old App bundles", () => {
    expect(
      updateUserPreferencesRequestSchema.parse({ morningBriefEnabled: true }),
    ).toStrictEqual({ morningBriefEnabled: true });

    expect(
      userPreferencesResponseSchema.parse({
        timezone: null,
        locale: null,
        supportedLocales: [...SUPPORTED_USER_LOCALES],
        pinnedAgentIds: [],
        sendMode: "enter",
        theme: null,
        colorTheme: null,
        morningBriefEnabled: false,
        morningBriefNextRunAt: null,
        captureNetworkBodiesRemaining: 0,
      }),
    ).toMatchObject({
      morningBriefEnabled: false,
      morningBriefNextRunAt: null,
    });

    expect(
      userPreferencesResponseSchema.safeParse({
        timezone: null,
        locale: null,
        supportedLocales: [...SUPPORTED_USER_LOCALES],
        pinnedAgentIds: [],
        sendMode: "enter",
        theme: null,
        colorTheme: null,
        morningBriefEnabled: true,
        morningBriefNextRunAt: "2026-08-31T00:00:00.000Z",
        captureNetworkBodiesRemaining: 0,
      }).success,
    ).toBe(false);
  });

  it("accepts Indonesian as a user locale", () => {
    const preferences = userPreferencesResponseSchema.parse({
      timezone: null,
      locale: "id-ID",
      supportedLocales: ["en-US", "pt-BR", "id-ID"],
      pinnedAgentIds: [],
      sendMode: "enter",
      theme: null,
      colorTheme: null,
      morningBriefEnabled: false,
      morningBriefNextRunAt: null,
      captureNetworkBodiesRemaining: 0,
    });

    expect(preferences.locale).toBe("id-ID");
  });

  it("rejects the retired Chinese locale in an API response", () => {
    const preferences = userPreferencesResponseSchema.safeParse({
      timezone: null,
      locale: "zh-CN",
      supportedLocales: [...SUPPORTED_USER_LOCALES],
      pinnedAgentIds: [],
      sendMode: "enter",
      theme: null,
      colorTheme: null,
      morningBriefEnabled: false,
      morningBriefNextRunAt: null,
      captureNetworkBodiesRemaining: 0,
    });

    expect(preferences.success).toBe(false);
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
        theme: null,
        colorTheme: null,
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
        theme: null,
        colorTheme: null,
        morningBriefEnabled: false,
        morningBriefNextRunAt: null,
        captureNetworkBodiesRemaining: 0,
      }),
    ).toMatchObject({
      locale: "ko-KR",
      supportedLocales: ["en-US", "pt-BR", "ja-JP", "ko-KR"],
    });
  });

  it("accepts the canonical Spanish locale", () => {
    expect(userLocaleSchema.parse("es-ES")).toBe("es-ES");
    expect(
      userPreferencesResponseSchema.parse({
        timezone: null,
        locale: "es-ES",
        supportedLocales: ["en-US", "pt-BR", "ja-JP", "es-ES"],
        pinnedAgentIds: [],
        sendMode: "enter",
        theme: null,
        colorTheme: null,
        morningBriefEnabled: false,
        morningBriefNextRunAt: null,
        captureNetworkBodiesRemaining: 0,
      }),
    ).toMatchObject({
      locale: "es-ES",
      supportedLocales: ["en-US", "pt-BR", "ja-JP", "es-ES"],
    });
  });

  it("accepts Italian in preference requests and supported locale responses", () => {
    expect(
      updateUserPreferencesRequestSchema.parse({ locale: "it-IT" }),
    ).toStrictEqual({ locale: "it-IT" });

    const preferences = userPreferencesResponseSchema.parse({
      timezone: null,
      locale: "it-IT",
      supportedLocales: ["en-US", "it-IT"],
      pinnedAgentIds: [],
      sendMode: "enter",
      theme: null,
      colorTheme: null,
      morningBriefEnabled: false,
      morningBriefNextRunAt: null,
      captureNetworkBodiesRemaining: 0,
    });

    expect(preferences.locale).toBe("it-IT");
    expect(preferences.supportedLocales).toStrictEqual(["en-US", "it-IT"]);
  });

  it("accepts every current user locale in an API response", () => {
    expect(SUPPORTED_USER_LOCALES).toStrictEqual([
      "en-US",
      "pt-BR",
      "ja-JP",
      "ko-KR",
      "id-ID",
      "de-DE",
      "es-ES",
      "it-IT",
      "fr-FR",
      "hi-IN",
    ]);

    const preferences = userPreferencesResponseSchema.parse({
      timezone: null,
      locale: "hi-IN",
      supportedLocales: [...SUPPORTED_USER_LOCALES],
      pinnedAgentIds: [],
      sendMode: "enter",
      theme: null,
      colorTheme: null,
      morningBriefEnabled: false,
      morningBriefNextRunAt: null,
      captureNetworkBodiesRemaining: 0,
    });

    expect(preferences.locale).toBe("hi-IN");
    expect(preferences.supportedLocales).toStrictEqual([
      ...SUPPORTED_USER_LOCALES,
    ]);
  });
});
