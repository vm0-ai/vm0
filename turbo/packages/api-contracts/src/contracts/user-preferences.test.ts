import { describe, expect, it } from "vitest";

import {
  CHAT_TRANSLATION_LANGUAGE_BY_USER_LOCALE,
  SUPPORTED_USER_LOCALES,
  chatTranslationLanguageSchema,
  updateUserPreferencesRequestSchema,
  userLocaleSchema,
  userPreferencesResponseSchema,
} from "./user-preferences";

describe("user preferences contract", () => {
  it("accepts Indonesian as a user locale", () => {
    const preferences = userPreferencesResponseSchema.parse({
      timezone: null,
      locale: "id-ID",
      translationLanguage: null,
      supportedLocales: ["en-US", "pt-BR", "id-ID"],
      pinnedAgentIds: [],
      sendMode: "enter",
      cloudBrowserEnabledByDefault: true,
      theme: null,
      colorTheme: null,
      captureNetworkBodiesRemaining: 0,
    });

    expect(preferences.locale).toBe("id-ID");
  });

  it("rejects the retired Chinese locale in an API response", () => {
    const preferences = userPreferencesResponseSchema.safeParse({
      timezone: null,
      locale: "zh-CN",
      translationLanguage: null,
      supportedLocales: [...SUPPORTED_USER_LOCALES],
      pinnedAgentIds: [],
      sendMode: "enter",
      cloudBrowserEnabledByDefault: true,
      theme: null,
      colorTheme: null,
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
        translationLanguage: null,
        supportedLocales: ["en-US", "pt-BR", "ja-JP"],
        pinnedAgentIds: [],
        sendMode: "enter",
        cloudBrowserEnabledByDefault: true,
        theme: null,
        colorTheme: null,
        captureNetworkBodiesRemaining: 0,
      }),
    ).toMatchObject({
      locale: "ja-JP",
      translationLanguage: null,
      supportedLocales: ["en-US", "pt-BR", "ja-JP"],
    });
  });

  it("accepts the canonical Korean locale", () => {
    expect(userLocaleSchema.parse("ko-KR")).toBe("ko-KR");
    expect(
      userPreferencesResponseSchema.parse({
        timezone: null,
        locale: "ko-KR",
        translationLanguage: null,
        supportedLocales: ["en-US", "pt-BR", "ja-JP", "ko-KR"],
        pinnedAgentIds: [],
        sendMode: "enter",
        cloudBrowserEnabledByDefault: true,
        theme: null,
        colorTheme: null,
        captureNetworkBodiesRemaining: 0,
      }),
    ).toMatchObject({
      locale: "ko-KR",
      translationLanguage: null,
      supportedLocales: ["en-US", "pt-BR", "ja-JP", "ko-KR"],
    });
  });

  it("accepts the canonical Spanish locale", () => {
    expect(userLocaleSchema.parse("es-ES")).toBe("es-ES");
    expect(
      userPreferencesResponseSchema.parse({
        timezone: null,
        locale: "es-ES",
        translationLanguage: null,
        supportedLocales: ["en-US", "pt-BR", "ja-JP", "es-ES"],
        pinnedAgentIds: [],
        sendMode: "enter",
        cloudBrowserEnabledByDefault: true,
        theme: null,
        colorTheme: null,
        captureNetworkBodiesRemaining: 0,
      }),
    ).toMatchObject({
      locale: "es-ES",
      translationLanguage: null,
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
      translationLanguage: null,
      supportedLocales: ["en-US", "it-IT"],
      pinnedAgentIds: [],
      sendMode: "enter",
      cloudBrowserEnabledByDefault: true,
      theme: null,
      colorTheme: null,
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
      translationLanguage: null,
      supportedLocales: [...SUPPORTED_USER_LOCALES],
      pinnedAgentIds: [],
      sendMode: "enter",
      cloudBrowserEnabledByDefault: true,
      theme: null,
      colorTheme: null,
      captureNetworkBodiesRemaining: 0,
    });

    expect(preferences.locale).toBe("hi-IN");
    expect(preferences.supportedLocales).toStrictEqual([
      ...SUPPORTED_USER_LOCALES,
    ]);
  });

  it("supports chat translation for every current user locale", () => {
    expect(Object.keys(CHAT_TRANSLATION_LANGUAGE_BY_USER_LOCALE)).toStrictEqual(
      [...SUPPORTED_USER_LOCALES],
    );
    expect(
      Object.values(CHAT_TRANSLATION_LANGUAGE_BY_USER_LOCALE).every(
        (language) => {
          return chatTranslationLanguageSchema.safeParse(language).success;
        },
      ),
    ).toBe(true);
  });
});
