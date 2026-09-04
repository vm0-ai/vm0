import { screen, waitFor, within } from "@testing-library/react";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { modelProviderCooldownDiagnosticsContract } from "@okouai/api-contracts/contracts/model-provider-routes";
import {
  type UserLocale,
  type UserPreferencesResponse,
  userPreferencesContract,
} from "@okouai/api-contracts/contracts/user-preferences";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { OKOU_LOCALE_COOKIE_NAME } from "../../../i18n/locale-fallback.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { openSettingsDialogAt$ } from "../../../signals/okou-page/settings/settings-dialog.ts";
import { billingStatus } from "./chat-composer-test-helpers.ts";

const context = testContext();

async function openDialog(
  role: "admin" | "member" = "admin",
  section: "debug" | "general" | "model" | "preference" = "general",
  featureSwitches: Partial<Record<FeatureSwitchKey, boolean>> = {},
): Promise<void> {
  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role,
  });
  context.mocks.data.orgMembers({
    name: "Test Org",
    role,
    members: [],
    pendingInvitations: [],
    membershipRequests: [],
    createdAt: "2026-01-01T00:00:00Z",
  });
  detachedSetupPage({
    context,
    path: `/?settings=${section}`,
    featureSwitches: {
      ...(section === "debug" ? { [FeatureSwitchKey.OkouDebug]: true } : {}),
      ...featureSwitches,
    },
  });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
}

function createPreferences(
  locale: UserLocale | null,
  supportedLocales: UserLocale[] = [
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
  ],
): UserPreferencesResponse {
  return {
    timezone: null,
    locale,
    translationLanguage: null,
    supportedLocales,
    pinnedAgentIds: [],
    sendMode: "enter",
    cloudBrowserEnabledByDefault: true,
    theme: "system",
    colorTheme: "blue-horizon",
    captureNetworkBodiesRemaining: 0,
  };
}

function connectorCatalogDisclosure(region: HTMLElement): {
  readonly details: HTMLDetailsElement;
  readonly summary: HTMLElement;
} {
  const title = within(region).getByText("Connector catalog");
  const summary = title.closest("summary");
  const details = summary?.closest("details");
  if (!(summary instanceof HTMLElement)) {
    throw new Error("Connector catalog summary not found");
  }
  if (!(details instanceof HTMLDetailsElement)) {
    throw new Error("Connector catalog disclosure not found");
  }
  return { details, summary };
}

function builtInModelCooldownDisclosure(region: HTMLElement): {
  readonly details: HTMLDetailsElement;
  readonly summary: HTMLElement;
} {
  const title = within(region).getByText("Built-in model fallback");
  const summary = title.closest("summary");
  const details = summary?.closest("details");
  if (!(summary instanceof HTMLElement)) {
    throw new Error("Built-in model cooldown summary not found");
  }
  if (!(details instanceof HTMLDetailsElement)) {
    throw new Error("Built-in model cooldown disclosure not found");
  }
  return { details, summary };
}

function buttonWithText(
  container: HTMLElement,
  text: string,
): HTMLButtonElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.trim() === text;
  });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${text}`);
  }
  return button;
}

describe("settings dialog", () => {
  it("updates the Cloud browser default when the preference switch is enabled", async () => {
    context.mocks.data.userPreferences({
      cloudBrowserEnabledByDefault: false,
    });

    await openDialog("admin", "preference", {
      [FeatureSwitchKey.CloudBrowserPreference]: true,
    });

    const cloudBrowserSwitch = await screen.findByRole("switch", {
      name: "Cloud browser",
    });
    expect(cloudBrowserSwitch).toHaveAttribute("aria-checked", "false");

    click(cloudBrowserSwitch);

    await waitFor(() => {
      expect(cloudBrowserSwitch).toHaveAttribute("aria-checked", "true");
    });
  });

  it("hides the Cloud browser default while its feature switch is disabled", async () => {
    await openDialog("admin", "preference");

    expect(
      screen.queryByRole("switch", { name: "Cloud browser" }),
    ).not.toBeInTheDocument();
  });

  it("keeps every available locale in the language menu", async () => {
    context.mocks.data.userPreferences(
      createPreferences("en-US", [
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
      ]),
    );

    await openDialog("admin", "preference");

    click(await screen.findByRole("combobox", { name: "Language" }));

    expect(
      within(screen.getByRole("listbox")).getAllByRole("option"),
    ).toHaveLength(10);
  });

  it("persists the browser fallback when the workspace has no preference", async () => {
    const submittedLocales: UserLocale[] = [];
    let serverLocale: UserLocale | null = null;
    context.mocks.browser.url("https://app.okou.ai/?settings=preference");
    context.mocks.browser.languages(["id-ID"]);
    context.mocks.api(userPreferencesContract.get, ({ respond }) => {
      return respond(200, createPreferences(serverLocale));
    });
    context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
      if (body.locale !== undefined) {
        serverLocale = body.locale;
        submittedLocales.push(body.locale);
      }
      return respond(200, createPreferences(serverLocale));
    });

    await openDialog("admin", "preference");

    const languageSelect = await screen.findByRole("combobox", {
      name: "Bahasa",
    });
    await waitFor(() => {
      expect(submittedLocales).toContain("id-ID");
      expect(languageSelect).toHaveTextContent("Bahasa Indonesia");
      expect(languageSelect).toBeEnabled();
      expect(document.documentElement.lang).toBe("id-ID");
    });

    click(languageSelect);
    click(screen.getByRole("option", { name: "English" }));
    await waitFor(() => {
      expect(document.documentElement.lang).toBe("en-US");
    });
  });

  it("keeps the VM0 workspace fallback in English", async () => {
    const submittedLocales: UserLocale[] = [];
    context.mocks.browser.url("https://app.vm0.ai/?settings=preference");
    context.mocks.browser.languages(["id-ID"]);
    context.mocks.api(userPreferencesContract.get, ({ respond }) => {
      return respond(200, createPreferences(null));
    });
    context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
      if (body.locale !== undefined) {
        submittedLocales.push(body.locale);
      }
      return respond(200, createPreferences(body.locale ?? null));
    });

    await openDialog("admin", "preference");

    const languageSelect = await screen.findByRole("combobox", {
      name: "Language",
    });
    await waitFor(() => {
      expect(submittedLocales).toContain("en-US");
      expect(submittedLocales).not.toContain("id-ID");
      expect(languageSelect).toHaveTextContent("English");
      expect(document.documentElement.lang).toBe("en-US");
    });
  });

  it("selects and persists German through the advertised locale handshake", async () => {
    const submittedLocales: UserLocale[] = [];
    let serverLocale: UserLocale | null = null;
    const supportedLocales: UserLocale[] = ["en-US", "pt-BR", "de-DE"];
    context.mocks.api(userPreferencesContract.get, ({ respond }) => {
      return respond(200, createPreferences(serverLocale, supportedLocales));
    });
    context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
      if (body.locale !== undefined) {
        serverLocale = body.locale;
        submittedLocales.push(body.locale);
      }
      return respond(200, createPreferences(serverLocale, supportedLocales));
    });

    await openDialog("admin", "preference");

    click(
      await screen.findByRole("combobox", {
        name: "Language",
      }),
    );
    click(screen.getByRole("option", { name: "Deutsch" }));

    await waitFor(() => {
      expect(submittedLocales).toContain("de-DE");
      expect(
        screen.getByRole("combobox", { name: "Sprache" }),
      ).toHaveTextContent("Deutsch");
      expect(document.documentElement.lang).toBe("de-DE");
    });
  });

  it("keeps the language control mounted while preferences reload", async () => {
    const preferenceReloadStarted = context.mocks.deferred<void>();
    const preferenceReloadCompleted = context.mocks.deferred<void>();
    const releasePreferenceReload = context.mocks.deferred<void>();
    let holdPreferenceReload = false;
    let serverLocale: UserLocale | null = "en-US";
    const supportedLocales: UserLocale[] = ["en-US", "de-DE"];
    context.mocks.api(
      userPreferencesContract.get,
      async ({ respond, withSignal }) => {
        if (holdPreferenceReload) {
          preferenceReloadStarted.resolve();
          await withSignal(releasePreferenceReload.promise);
          preferenceReloadCompleted.resolve();
        }
        return respond(200, createPreferences(serverLocale, supportedLocales));
      },
    );
    context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
      if (body.locale !== undefined) {
        serverLocale = body.locale;
      }
      return respond(200, createPreferences(serverLocale, supportedLocales));
    });

    await openDialog("admin", "preference");

    holdPreferenceReload = true;
    click(await screen.findByRole("combobox", { name: "Language" }));
    click(screen.getByRole("option", { name: "Deutsch" }));
    await preferenceReloadStarted.promise;

    expect(screen.getByRole("combobox", { name: "Sprache" })).toHaveTextContent(
      "Deutsch",
    );

    releasePreferenceReload.resolve();
    await preferenceReloadCompleted.promise;
    holdPreferenceReload = false;
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Sprache" })).toBeEnabled();
    });

    click(screen.getByRole("combobox", { name: "Sprache" }));
    click(screen.getByRole("option", { name: "English" }));
    await waitFor(() => {
      expect(document.documentElement.lang).toBe("en-US");
      expect(serverLocale).toBe("en-US");
    });
  });

  it("selects and persists Italian when the API advertises it", async () => {
    const submittedLocales: UserLocale[] = [];
    let serverLocale: UserLocale | null = "en-US";
    const createItalianPreferences = (
      locale: UserLocale | null,
    ): UserPreferencesResponse => {
      return {
        ...createPreferences(locale),
        supportedLocales: ["en-US", "it-IT"],
      };
    };
    context.mocks.api(userPreferencesContract.get, ({ respond }) => {
      return respond(200, createItalianPreferences(serverLocale));
    });
    context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
      if (body.locale !== undefined) {
        serverLocale = body.locale;
        submittedLocales.push(body.locale);
      }
      return respond(200, createItalianPreferences(serverLocale));
    });

    await openDialog("admin", "preference");

    const languageSelect = await screen.findByRole("combobox", {
      name: "Language",
    });
    click(languageSelect);
    expect(
      screen.queryByRole("option", { name: "Português (Brasil)" }),
    ).not.toBeInTheDocument();
    click(screen.getByRole("option", { name: "Italiano" }));

    await waitFor(() => {
      expect(submittedLocales).toContain("it-IT");
      expect(
        screen.getByRole("combobox", { name: "Lingua" }),
      ).toHaveTextContent("Italiano");
      expect(document.documentElement.lang).toBe("it-IT");
      expect(screen.getByText("Aspetto")).toBeInTheDocument();
    });
  });

  it("selects and persists French when the API advertises it", async () => {
    const submittedLocales: UserLocale[] = [];
    let serverLocale: UserLocale | null = "en-US";
    const supportedLocales: UserLocale[] = ["en-US", "pt-BR", "fr-FR"];
    context.mocks.api(userPreferencesContract.get, ({ respond }) => {
      return respond(200, createPreferences(serverLocale, supportedLocales));
    });
    context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
      if (body.locale !== undefined) {
        serverLocale = body.locale;
        submittedLocales.push(body.locale);
      }
      return respond(200, createPreferences(serverLocale, supportedLocales));
    });

    await openDialog("admin", "preference");

    click(await screen.findByRole("combobox", { name: "Language" }));
    click(screen.getByRole("option", { name: "Français" }));

    await waitFor(() => {
      expect(submittedLocales).toContain("fr-FR");
      expect(
        screen.getByRole("combobox", { name: "Langue" }),
      ).toHaveTextContent("Français");
      expect(document.documentElement.lang).toBe("fr-FR");
    });
  });

  it("selects and persists Hindi when the API advertises it", async () => {
    const submittedLocales: UserLocale[] = [];
    let serverLocale: UserLocale | null = "en-US";
    const supportedLocales: UserLocale[] = ["en-US", "pt-BR", "hi-IN"];
    context.mocks.api(userPreferencesContract.get, ({ respond }) => {
      return respond(200, createPreferences(serverLocale, supportedLocales));
    });
    context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
      if (body.locale !== undefined) {
        serverLocale = body.locale;
        submittedLocales.push(body.locale);
      }
      return respond(200, createPreferences(serverLocale, supportedLocales));
    });

    await openDialog("admin", "preference");

    click(await screen.findByRole("combobox", { name: "Language" }));
    click(screen.getByRole("option", { name: "हिन्दी" }));

    await waitFor(() => {
      expect(submittedLocales).toContain("hi-IN");
      expect(screen.getByRole("combobox", { name: "भाषा" })).toHaveTextContent(
        "हिन्दी",
      );
      expect(document.documentElement.lang).toBe("hi-IN");
    });
  });

  it("uses the workspace preference ahead of locale fallback hints", async () => {
    context.mocks.browser.url("https://app.okou.ai/?settings=preference");
    context.mocks.browser.cookie(`${OKOU_LOCALE_COOKIE_NAME}=v1.fr-FR`);
    context.mocks.browser.languages(["de-DE"]);
    context.mocks.data.userPreferences(createPreferences("id-ID"));

    await openDialog("admin", "preference");

    const languageSelect = await screen.findByRole("combobox", {
      name: "Bahasa",
    });
    await waitFor(() => {
      expect(languageSelect).toHaveTextContent("Bahasa Indonesia");
      expect(languageSelect).toHaveAccessibleName("Bahasa");
      expect(document.documentElement.lang).toBe("id-ID");
    });

    click(languageSelect);
    click(screen.getByRole("option", { name: "English" }));
    await waitFor(() => {
      expect(document.documentElement.lang).toBe("en-US");
    });
  });

  it("selects and persists Japanese when the API advertises it", async () => {
    const submittedLocales: UserLocale[] = [];
    const reloadStarted = context.mocks.deferred<void>();
    const releaseReload = context.mocks.deferred<void>();
    let preferenceRequestCount = 0;
    let serverLocale: UserLocale | null = "en-US";
    const supportedLocales: UserLocale[] = ["en-US", "pt-BR", "ja-JP"];
    context.mocks.api(userPreferencesContract.get, async ({ respond }) => {
      preferenceRequestCount += 1;
      if (preferenceRequestCount > 1) {
        reloadStarted.resolve();
        await releaseReload.promise;
      }
      return respond(200, createPreferences(serverLocale, supportedLocales));
    });
    context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
      if (body.locale !== undefined) {
        serverLocale = body.locale;
        submittedLocales.push(body.locale);
      }
      return respond(200, createPreferences(serverLocale, supportedLocales));
    });

    await openDialog("admin", "preference");

    click(
      await screen.findByRole("combobox", {
        name: "Language",
      }),
    );
    click(screen.getByRole("option", { name: "日本語" }));

    await reloadStarted.promise;
    expect(screen.getByRole("combobox", { name: "言語" })).toHaveTextContent(
      "日本語",
    );
    releaseReload.resolve();

    await waitFor(() => {
      expect(submittedLocales).toContain("ja-JP");
      expect(screen.getByRole("combobox", { name: "言語" })).toHaveTextContent(
        "日本語",
      );
      expect(document.documentElement.lang).toBe("ja-JP");
    });

    click(screen.getByRole("combobox", { name: "言語" }));
    click(screen.getByRole("option", { name: "English" }));
    await waitFor(() => {
      expect(document.documentElement.lang).toBe("en-US");
    });
  });

  it("selects and persists Korean when the API advertises it", async () => {
    const submittedLocales: UserLocale[] = [];
    let serverLocale: UserLocale | null = "en-US";
    const supportedLocales: UserLocale[] = ["en-US", "pt-BR", "ja-JP", "ko-KR"];
    context.mocks.api(userPreferencesContract.get, ({ respond }) => {
      return respond(200, createPreferences(serverLocale, supportedLocales));
    });
    context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
      if (body.locale !== undefined) {
        serverLocale = body.locale;
        submittedLocales.push(body.locale);
      }
      return respond(200, createPreferences(serverLocale, supportedLocales));
    });

    await openDialog("admin", "preference");

    click(
      await screen.findByRole("combobox", {
        name: "Language",
      }),
    );
    click(screen.getByRole("option", { name: "한국어" }));

    await waitFor(() => {
      expect(submittedLocales).toContain("ko-KR");
      expect(screen.getByRole("combobox", { name: "언어" })).toHaveTextContent(
        "한국어",
      );
      expect(document.documentElement.lang).toBe("ko-KR");
    });

    click(screen.getByRole("combobox", { name: "언어" }));
    click(screen.getByRole("option", { name: "English" }));
    await waitFor(() => {
      expect(document.documentElement.lang).toBe("en-US");
    });
  });

  it("selects and persists Spanish when the API advertises it", async () => {
    const submittedLocales: UserLocale[] = [];
    let serverLocale: UserLocale | null = "en-US";
    const supportedLocales: UserLocale[] = ["en-US", "pt-BR", "ja-JP", "es-ES"];
    context.mocks.api(userPreferencesContract.get, ({ respond }) => {
      return respond(200, createPreferences(serverLocale, supportedLocales));
    });
    context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
      if (body.locale !== undefined) {
        serverLocale = body.locale;
        submittedLocales.push(body.locale);
      }
      return respond(200, createPreferences(serverLocale, supportedLocales));
    });

    await openDialog("admin", "preference");

    click(
      await screen.findByRole("combobox", {
        name: "Language",
      }),
    );
    click(screen.getByRole("option", { name: "Español" }));

    await waitFor(() => {
      expect(submittedLocales).toContain("es-ES");
      expect(
        screen.getByRole("combobox", { name: "Idioma" }),
      ).toHaveTextContent("Español");
      expect(document.documentElement.lang).toBe("es-ES");
    });

    click(screen.getByRole("combobox", { name: "Idioma" }));
    click(screen.getByRole("option", { name: "English" }));
    await waitFor(() => {
      expect(document.documentElement.lang).toBe("en-US");
    });
  });

  it("restores Japanese from the workspace preference on reload", async () => {
    document.documentElement.lang = "en-US";
    context.mocks.data.userPreferences(
      createPreferences("ja-JP", ["en-US", "ja-JP"]),
    );

    await openDialog("admin", "preference");

    const languageSelect = await screen.findByRole("combobox", {
      name: "言語",
    });
    await waitFor(() => {
      expect(languageSelect).toHaveTextContent("日本語");
      expect(document.documentElement.lang).toBe("ja-JP");
    });

    click(languageSelect);
    expect(
      screen.queryByRole("option", { name: "Português (Brasil)" }),
    ).not.toBeInTheDocument();
    click(screen.getByRole("option", { name: "English" }));
    await waitFor(() => {
      expect(document.documentElement.lang).toBe("en-US");
    });
  });

  it("restores Korean from the workspace preference on reload", async () => {
    document.documentElement.lang = "en-US";
    context.mocks.data.userPreferences(
      createPreferences("ko-KR", ["en-US", "ko-KR"]),
    );

    await openDialog("admin", "preference");

    const languageSelect = await screen.findByRole("combobox", {
      name: "언어",
    });
    await waitFor(() => {
      expect(languageSelect).toHaveTextContent("한국어");
      expect(document.documentElement.lang).toBe("ko-KR");
    });

    click(languageSelect);
    expect(
      screen.queryByRole("option", { name: "日本語" }),
    ).not.toBeInTheDocument();
    click(screen.getByRole("option", { name: "English" }));
    await waitFor(() => {
      expect(document.documentElement.lang).toBe("en-US");
    });
  });

  it("restores Spanish from the workspace preference on reload", async () => {
    document.documentElement.lang = "en-US";
    context.mocks.data.userPreferences(
      createPreferences("es-ES", ["en-US", "es-ES"]),
    );

    await openDialog("admin", "preference");

    const languageSelect = await screen.findByRole("combobox", {
      name: "Idioma",
    });
    await waitFor(() => {
      expect(languageSelect).toHaveTextContent("Español");
      expect(document.documentElement.lang).toBe("es-ES");
    });

    click(languageSelect);
    expect(
      screen.queryByRole("option", { name: "Português (Brasil)" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "日本語" }),
    ).not.toBeInTheDocument();
    click(screen.getByRole("option", { name: "English" }));
    await waitFor(() => {
      expect(document.documentElement.lang).toBe("en-US");
    });
  });

  it("does not submit Japanese to an API that advertises only Portuguese", async () => {
    const submittedLocales: UserLocale[] = [];
    document.documentElement.lang = "ja-JP";
    context.mocks.api(userPreferencesContract.get, ({ respond }) => {
      return respond(200, createPreferences(null, ["en-US", "pt-BR"]));
    });
    context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
      if (body.locale !== undefined) {
        submittedLocales.push(body.locale);
      }
      return respond(
        200,
        createPreferences(body.locale ?? null, ["en-US", "pt-BR"]),
      );
    });

    await openDialog("admin", "preference");

    await waitFor(() => {
      expect(submittedLocales).toContain("en-US");
      expect(submittedLocales).not.toContain("ja-JP");
      expect(document.documentElement.lang).toBe("en-US");
    });
  });

  it("does not submit Korean to an API that does not advertise it", async () => {
    const submittedLocales: UserLocale[] = [];
    document.documentElement.lang = "ko-KR";
    const supportedLocales: UserLocale[] = ["en-US", "pt-BR", "ja-JP"];
    context.mocks.api(userPreferencesContract.get, ({ respond }) => {
      return respond(200, createPreferences(null, supportedLocales));
    });
    context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
      if (body.locale !== undefined) {
        submittedLocales.push(body.locale);
      }
      return respond(
        200,
        createPreferences(body.locale ?? null, supportedLocales),
      );
    });

    await openDialog("admin", "preference");

    await waitFor(() => {
      expect(submittedLocales).toContain("en-US");
      expect(submittedLocales).not.toContain("ko-KR");
      expect(document.documentElement.lang).toBe("en-US");
    });

    click(screen.getByRole("combobox", { name: "Language" }));
    expect(
      screen.queryByRole("option", { name: "한국어" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "日本語" })).toBeInTheDocument();
  });

  it("does not submit Spanish to an API that advertises only Portuguese", async () => {
    const submittedLocales: UserLocale[] = [];
    document.documentElement.lang = "es-ES";
    const supportedLocales: UserLocale[] = ["en-US", "pt-BR"];
    context.mocks.api(userPreferencesContract.get, ({ respond }) => {
      return respond(200, createPreferences(null, supportedLocales));
    });
    context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
      if (body.locale !== undefined) {
        submittedLocales.push(body.locale);
      }
      return respond(
        200,
        createPreferences(body.locale ?? null, supportedLocales),
      );
    });

    await openDialog("admin", "preference");

    await waitFor(() => {
      expect(submittedLocales).toContain("en-US");
      expect(submittedLocales).not.toContain("es-ES");
      expect(document.documentElement.lang).toBe("en-US");
    });
  });

  it("hides the language entry when the API advertises only English", async () => {
    document.documentElement.lang = "de-DE";
    const guardedPreferences = createPreferences("de-DE");
    guardedPreferences.supportedLocales = ["en-US"];
    context.mocks.data.userPreferences(guardedPreferences);

    await openDialog("admin", "preference");

    await waitFor(() => {
      expect(screen.getByText("Theme")).toBeInTheDocument();
      expect(screen.queryByText("Language")).not.toBeInTheDocument();
      expect(document.documentElement.lang).toBe("en-US");
    });
  });

  it("omits locales that the API does not advertise", async () => {
    const guardedPreferences = createPreferences("en-US");
    guardedPreferences.supportedLocales = ["en-US", "pt-BR"];
    context.mocks.data.userPreferences(guardedPreferences);

    await openDialog("admin", "preference");

    const languageSelect = await screen.findByRole("combobox", {
      name: "Language",
    });
    click(languageSelect);
    expect(
      screen.getByRole("option", { name: "Português (Brasil)" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Bahasa Indonesia" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "हिन्दी" }),
    ).not.toBeInTheDocument();
  });

  it("does not expose French when the API does not advertise it", async () => {
    context.mocks.data.userPreferences(
      createPreferences("en-US", ["en-US", "pt-BR"]),
    );

    await openDialog("admin", "preference");

    const languageSelect = await screen.findByRole("combobox", {
      name: "Language",
    });
    click(languageSelect);
    expect(
      screen.getByRole("option", { name: "Português (Brasil)" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Français" }),
    ).not.toBeInTheDocument();
  });

  it("does not submit a stale document locale that the API does not advertise", async () => {
    const submittedLocales: UserLocale[] = [];
    document.documentElement.lang = "fr-FR";
    context.signal.addEventListener(
      "abort",
      () => {
        document.documentElement.lang = "en-US";
      },
      { once: true },
    );
    context.mocks.api(userPreferencesContract.get, ({ respond }) => {
      return respond(200, createPreferences(null, ["en-US", "pt-BR"]));
    });
    context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
      if (body.locale !== undefined) {
        submittedLocales.push(body.locale);
      }
      return respond(
        200,
        createPreferences(body.locale ?? null, ["en-US", "pt-BR"]),
      );
    });

    await openDialog("admin", "preference");

    await waitFor(() => {
      expect(submittedLocales).toContain("en-US");
      expect(submittedLocales).not.toContain("fr-FR");
      expect(document.documentElement.lang).toBe("en-US");
      expect(
        screen.getByRole("combobox", { name: "Language" }),
      ).toHaveTextContent("English");
    });
  });

  it("lets admins navigate workspace settings without closing the dialog", async () => {
    await openDialog("admin");

    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(within(dialog).getByText("Personal")).toBeInTheDocument();
    expect(within(dialog).getByText("Workspace")).toBeInTheDocument();
    expect(within(dialog).getAllByText("Models").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("Billing & pricing")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "General" }),
    ).toBeInTheDocument();

    const peopleTab = queryAllByRoleFast("button", dialog).find((element) => {
      return /People/u.test(element.textContent ?? "");
    });
    if (!peopleTab) {
      throw new Error("People tab not found");
    }
    click(peopleTab);

    await waitFor(() => {
      expect(
        screen.getByRole("dialog", { name: "Settings" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "People" }),
      ).toBeInTheDocument();
    });
  });

  it.each([
    {
      name: "model capabilities",
      response: billingStatus("limited-free-1", {
        supportByok: false,
        restrictedVm0Models: true,
      }),
    },
    {
      name: "legacy tier-only response",
      response: billingStatus("limited-free-1"),
    },
  ])("shows model settings with $name", async ({ response }) => {
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, response);
    });

    await openDialog("admin", "model");

    const dialog = screen.getByRole("dialog", { name: "Settings" });
    await waitFor(() => {
      expect(within(dialog).getAllByText("Models").length).toBeGreaterThan(0);
      expect(
        screen.getByRole("heading", { name: "Models" }),
      ).toBeInTheDocument();
    });
  });

  it("routes members away from admin-only workspace settings", async () => {
    await openDialog("member");

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByText("Workspace")).not.toBeInTheDocument();
    expect(screen.getByText("Theme")).toBeInTheDocument();
  });

  it("shows complete built-in model cooldown diagnostics in a collapsed disclosure", async () => {
    const releaseRefresh = context.mocks.deferred<void>();
    let requestCount = 0;
    context.mocks.api(
      modelProviderCooldownDiagnosticsContract.get,
      async ({ respond }) => {
        requestCount += 1;
        if (requestCount > 1) {
          await releaseRefresh.promise;
          return respond(200, {
            activeCooldowns: [],
          });
        }
        return respond(200, {
          activeCooldowns: [
            {
              selectedModel: "gpt-5.6-luna",
              providerType: "openai-api-key",
              upstreamModel: "gpt-5.6-luna-2026-08-01",
              unavailableUntil: "2026-08-23T04:05:00.000Z",
            },
          ],
        });
      },
    );

    await openDialog("admin", "debug");

    const diagnostics = await screen.findByRole("region", {
      name: "Built-in model fallback",
    });
    const { details, summary } = builtInModelCooldownDisclosure(diagnostics);
    expect(details.open).toBeFalsy();
    expect(summary).toHaveTextContent("global active cooldowns: 1");
    expect(
      within(diagnostics).queryByText("gpt-5.6-luna-2026-08-01"),
    ).not.toBeVisible();

    click(summary);
    expect(details.open).toBeTruthy();
    expect(within(diagnostics).getByText("gpt-5.6-luna")).toBeInTheDocument();
    expect(within(diagnostics).getByText("openai-api-key")).toBeInTheDocument();
    expect(
      within(diagnostics).getByText("gpt-5.6-luna-2026-08-01"),
    ).toBeInTheDocument();
    expect(
      within(diagnostics).getByText("2026-08-23T04:05:00.000Z"),
    ).toHaveAttribute("datetime", "2026-08-23T04:05:00.000Z");
    expect(
      queryAllByRoleFast("button", diagnostics).some((button) => {
        return button.textContent?.trim() === "Cancel cooldown";
      }),
    ).toBeFalsy();

    const refreshButton = queryAllByRoleFast("button", diagnostics).find(
      (button) => {
        return button.textContent?.trim() === "Refresh";
      },
    );
    if (!refreshButton) {
      throw new Error("Built-in model cooldown refresh button not found");
    }
    click(refreshButton);
    await waitFor(() => {
      expect(requestCount).toBe(2);
      expect(refreshButton).toBeDisabled();
    });
    expect(details.open).toBeTruthy();
    expect(
      within(diagnostics).getByText("gpt-5.6-luna-2026-08-01"),
    ).toBeInTheDocument();

    releaseRefresh.resolve();
    await waitFor(() => {
      expect(summary).toHaveTextContent("global active cooldowns: 0");
      expect(refreshButton).toBeEnabled();
    });
    expect(details.open).toBeTruthy();
    expect(
      within(diagnostics).getByText(
        "No built-in model routes are currently in global cooldown.",
      ),
    ).toBeInTheDocument();
  });

  it("lets staff confirm and cancel a built-in model cooldown", async () => {
    const releaseCancellation = context.mocks.deferred<void>();
    let diagnosticsRequestCount = 0;
    let cancellationRequestCount = 0;
    let cancellationBody: {
      readonly selectedModel: string;
      readonly providerType: string;
      readonly upstreamModel: string;
    } | null = null;
    context.mocks.api(
      modelProviderCooldownDiagnosticsContract.get,
      ({ respond }) => {
        diagnosticsRequestCount += 1;
        return respond(200, {
          canCancelCooldowns: true,
          activeCooldowns:
            diagnosticsRequestCount === 1
              ? [
                  {
                    selectedModel: "gpt-5.6-luna",
                    providerType: "openai-api-key",
                    upstreamModel: "gpt-5.6-luna-2026-08-01",
                    unavailableUntil: "2026-08-23T04:05:00.000Z",
                  },
                ]
              : [],
        });
      },
    );
    context.mocks.api(
      modelProviderCooldownDiagnosticsContract.cancel,
      async ({ body, respond }) => {
        cancellationRequestCount += 1;
        cancellationBody = body;
        await releaseCancellation.promise;
        return respond(204);
      },
    );

    await openDialog("admin", "debug");

    const diagnostics = await screen.findByRole("region", {
      name: "Built-in model fallback",
    });
    const { details, summary } = builtInModelCooldownDisclosure(diagnostics);
    click(summary);
    expect(details.open).toBeTruthy();

    click(buttonWithText(diagnostics, "Cancel cooldown"));
    const confirmation = await screen.findByRole("dialog", {
      name: "Cancel global cooldown?",
    });
    expect(cancellationRequestCount).toBe(0);
    expect(within(confirmation).getByText("gpt-5.6-luna")).toBeVisible();
    expect(within(confirmation).getByText("openai-api-key")).toBeVisible();
    expect(
      within(confirmation).getByText("gpt-5.6-luna-2026-08-01"),
    ).toBeVisible();
    expect(
      within(confirmation).getByText(
        "Cancelling this global cooldown makes the route immediately eligible for every workspace.",
      ),
    ).toBeVisible();
    expect(
      within(confirmation).getByText(
        "A later qualifying failure can place this route back in cooldown.",
      ),
    ).toBeVisible();

    click(buttonWithText(confirmation, "Cancel cooldown"));
    await waitFor(() => {
      expect(cancellationRequestCount).toBe(1);
      expect(buttonWithText(confirmation, "Cancelling...")).toBeDisabled();
      expect(buttonWithText(confirmation, "Keep cooldown")).toBeDisabled();
    });
    expect(cancellationBody).toStrictEqual({
      selectedModel: "gpt-5.6-luna",
      providerType: "openai-api-key",
      upstreamModel: "gpt-5.6-luna-2026-08-01",
    });

    releaseCancellation.resolve();
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Cancel global cooldown?" }),
      ).not.toBeInTheDocument();
      expect(diagnosticsRequestCount).toBe(2);
      expect(summary).toHaveTextContent("global active cooldowns: 0");
    });
    expect(details.open).toBeTruthy();
    expect(
      within(diagnostics).getByText(
        "No built-in model routes are currently in global cooldown.",
      ),
    ).toBeInTheDocument();
  });

  it("refreshes built-in model cooldown diagnostics on every Debug entry", async () => {
    let requestCount = 0;
    context.mocks.api(
      modelProviderCooldownDiagnosticsContract.get,
      ({ respond }) => {
        requestCount += 1;
        return respond(200, {
          activeCooldowns: [],
        });
      },
    );

    await openDialog("admin", "debug");

    let diagnostics = await screen.findByRole("region", {
      name: "Built-in model fallback",
    });
    let disclosure = builtInModelCooldownDisclosure(diagnostics);
    expect(disclosure.summary).toHaveTextContent("global active cooldowns: 0");
    click(disclosure.summary);
    expect(
      within(diagnostics).getByText(
        "No built-in model routes are currently in global cooldown.",
      ),
    ).toBeInTheDocument();
    expect(requestCount).toBe(1);

    const dialog = screen.getByRole("dialog");
    const dialogButton = (label: string): HTMLElement => {
      const button = queryAllByRoleFast("button", dialog).find((candidate) => {
        return (
          candidate.textContent?.trim() === label ||
          candidate.getAttribute("aria-label") === label
        );
      });
      if (!button) {
        throw new Error(`${label} button not found`);
      }
      return button;
    };

    click(dialogButton("Preference"));
    await expect(
      screen.findByRole("heading", { name: "Preference" }),
    ).resolves.toBeInTheDocument();
    click(dialogButton("Debug"));
    await waitFor(() => {
      diagnostics = screen.getByRole("region", {
        name: "Built-in model fallback",
      });
      disclosure = builtInModelCooldownDisclosure(diagnostics);
      expect(disclosure.details.open).toBeFalsy();
      expect(requestCount).toBe(2);
    });

    click(dialogButton("Close"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    await context.store.set(openSettingsDialogAt$, "debug", context.signal);

    await waitFor(() => {
      diagnostics = screen.getByRole("region", {
        name: "Built-in model fallback",
      });
      disclosure = builtInModelCooldownDisclosure(diagnostics);
      expect(disclosure.details.open).toBeFalsy();
      expect(requestCount).toBe(3);
    });
  });

  it("keeps Debug settings usable while built-in model diagnostics are unavailable", async () => {
    const releaseDiagnostics = context.mocks.deferred<void>();
    let requestCount = 0;
    context.mocks.api(
      modelProviderCooldownDiagnosticsContract.get,
      async ({ respond }) => {
        requestCount += 1;
        await releaseDiagnostics.promise;
        return respond(404, {
          error: {
            message: "Built-in model cooldown diagnostics are unavailable",
            code: "NOT_FOUND",
          },
        });
      },
    );

    await openDialog("admin", "debug");

    const diagnostics = await screen.findByRole("region", {
      name: "Built-in model fallback",
    });
    expect(
      within(diagnostics).getByText(
        "Loading built-in model cooldown diagnostics...",
      ),
    ).toBeInTheDocument();
    expect(diagnostics.querySelector("summary")).toBeNull();
    expect(screen.getByText("Build information")).toBeInTheDocument();
    expect(screen.getByText("Capture network bodies")).toBeInTheDocument();

    releaseDiagnostics.resolve();
    await expect(
      within(diagnostics).findByText(
        "Built-in model cooldown diagnostics are unavailable.",
      ),
    ).resolves.toBeInTheDocument();
    expect(diagnostics.querySelector("summary")).toBeNull();

    const refreshButton = queryAllByRoleFast("button", diagnostics).find(
      (button) => {
        return button.textContent?.trim() === "Refresh";
      },
    );
    if (!refreshButton) {
      throw new Error("Built-in model cooldown refresh button not found");
    }
    click(refreshButton);
    await waitFor(() => {
      expect(requestCount).toBe(2);
    });
  });

  it("shows connector catalog diagnostics in Debug settings", async () => {
    await openDialog("admin", "debug");

    const diagnostics = await screen.findByRole("region", {
      name: "Connector catalog",
    });
    const { details, summary } = connectorCatalogDisclosure(diagnostics);
    expect(details.open).toBeFalsy();
    expect(summary).toHaveTextContent("Sync state: Stale");
    expect(summary).toHaveTextContent("Active version: 2026-07-25.1");
    expect(summary).toHaveTextContent("Last attempt: Rejected");
    expect(summary).toHaveTextContent("Evaluation: Current");

    click(summary);
    expect(details.open).toBeTruthy();
    expect(within(diagnostics).getByText("2026-07-25.2")).toBeInTheDocument();
    expect(within(diagnostics).getByText("1.319.0")).toBeInTheDocument();
    expect(within(diagnostics).getByText("Reused")).toBeInTheDocument();
    expect(within(diagnostics).getAllByText("Invalid artifact")).toHaveLength(
      2,
    );
    expect(within(diagnostics).getByText("github / oauth")).toBeInTheDocument();
    expect(
      within(diagnostics).getByText("Missing revoke provider"),
    ).toBeInTheDocument();
    expect(
      within(diagnostics).getByText("Missing versions"),
    ).toBeInTheDocument();
    expect(
      within(diagnostics).getByText("Unowned secrets"),
    ).toBeInTheDocument();
    expect(
      within(diagnostics).getByText("Unowned variables"),
    ).toBeInTheDocument();
    expect(
      within(diagnostics).getByText("Unresolved bridge credentials"),
    ).toBeInTheDocument();

    click(summary);
    expect(details.open).toBeFalsy();
  });

  it("summarizes a never-synced connector catalog", async () => {
    context.mocks.api(connectorCatalogContract.diagnostics, ({ respond }) => {
      return respond(200, {
        state: "never-synced",
        active: null,
        lastAttempt: null,
        lastSuccessAt: null,
        rejectedCandidate: null,
        filtering: {
          capabilityDigest: `sha256:${"a".repeat(64)}`,
          evaluatedAt: null,
          stale: true,
          filteredAuthMethods: [],
        },
        credentialStorage: {
          missingConnectorVersions: 0,
          unownedConnectorSecrets: 0,
          unownedConnectorVariables: 0,
          unresolvedBridgeCredentials: 0,
        },
      });
    });

    await openDialog("admin", "debug");

    const diagnostics = await screen.findByRole("region", {
      name: "Connector catalog",
    });
    const { details, summary } = connectorCatalogDisclosure(diagnostics);
    expect(details.open).toBeFalsy();
    expect(summary).toHaveTextContent("Sync state: Never synced");
    expect(summary).toHaveTextContent("Active version: None");
    expect(summary).toHaveTextContent("Last attempt: None");
    expect(summary).toHaveTextContent("Evaluation: Stale");
  });

  it("refreshes connector catalog diagnostics on every Debug entry", async () => {
    let requestCount = 0;
    context.mocks.api(connectorCatalogContract.diagnostics, ({ respond }) => {
      requestCount += 1;
      const requestedAt = "2026-08-19T04:00:00.000Z";
      return respond(200, {
        state: "current",
        active: {
          catalogVersion: `2026-08-19.${requestCount}`,
          catalogDigest: `sha256:${"a".repeat(64)}`,
          activatedAt: requestedAt,
        },
        lastAttempt: {
          at: requestedAt,
          outcome: "accepted",
          failureCode: null,
          reusedCachedRejection: false,
        },
        lastSuccessAt: requestedAt,
        rejectedCandidate: null,
        filtering: {
          capabilityDigest: `sha256:${"b".repeat(64)}`,
          evaluatedAt: requestedAt,
          stale: false,
          filteredAuthMethods: [],
        },
        credentialStorage: {
          missingConnectorVersions: 0,
          unownedConnectorSecrets: 0,
          unownedConnectorVariables: 0,
          unresolvedBridgeCredentials: 0,
        },
      });
    });

    await openDialog("admin", "debug");

    let diagnostics = await screen.findByRole("region", {
      name: "Connector catalog",
    });
    let { details, summary } = connectorCatalogDisclosure(diagnostics);
    expect(summary).toHaveTextContent("Active version: 2026-08-19.1");
    expect(requestCount).toBe(1);

    click(summary);
    expect(details.open).toBeTruthy();

    click(screen.getByRole("switch"));
    await expect(
      screen.findByText("Enabled for the next 3 runs"),
    ).resolves.toBeInTheDocument();
    expect(requestCount).toBe(1);

    const dialog = screen.getByRole("dialog");
    const dialogButton = (label: string): HTMLElement => {
      const button = queryAllByRoleFast("button", dialog).find((candidate) => {
        return (
          candidate.textContent?.trim() === label ||
          candidate.getAttribute("aria-label") === label
        );
      });
      if (!button) {
        throw new Error(`${label} button not found`);
      }
      return button;
    };

    click(dialogButton("Preference"));
    await expect(
      screen.findByRole("heading", { name: "Preference" }),
    ).resolves.toBeInTheDocument();

    click(dialogButton("Debug"));
    await waitFor(() => {
      diagnostics = screen.getByRole("region", {
        name: "Connector catalog",
      });
      ({ details, summary } = connectorCatalogDisclosure(diagnostics));
      expect(summary).toHaveTextContent("Active version: 2026-08-19.2");
      expect(details.open).toBeFalsy();
    });
    expect(requestCount).toBe(2);

    click(dialogButton("Close"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    await context.store.set(openSettingsDialogAt$, "debug", context.signal);

    await waitFor(() => {
      diagnostics = screen.getByRole("region", {
        name: "Connector catalog",
      });
      ({ details, summary } = connectorCatalogDisclosure(diagnostics));
      expect(summary).toHaveTextContent("Active version: 2026-08-19.3");
      expect(details.open).toBeFalsy();
    });
    expect(requestCount).toBe(3);
  });

  it("does not describe an uncached rejection as a fresh evaluation", async () => {
    context.mocks.api(connectorCatalogContract.diagnostics, ({ respond }) => {
      return respond(200, {
        state: "stale",
        active: {
          catalogVersion: "2026-07-25.1",
          catalogDigest: `sha256:${"a".repeat(64)}`,
          activatedAt: "2026-07-25T01:00:00.000Z",
        },
        lastAttempt: {
          at: "2026-07-25T02:00:00.000Z",
          outcome: "rejected",
          failureCode: "source-unavailable",
          reusedCachedRejection: false,
        },
        lastSuccessAt: "2026-07-25T01:00:00.000Z",
        rejectedCandidate: null,
        filtering: {
          capabilityDigest: `sha256:${"b".repeat(64)}`,
          evaluatedAt: "2026-07-25T01:00:00.000Z",
          stale: false,
          filteredAuthMethods: [],
        },
        credentialStorage: {
          missingConnectorVersions: 0,
          unownedConnectorSecrets: 0,
          unownedConnectorVariables: 0,
          unresolvedBridgeCredentials: 0,
        },
      });
    });

    await openDialog("admin", "debug");

    const diagnostics = await screen.findByRole("region", {
      name: "Connector catalog",
    });
    const { summary } = connectorCatalogDisclosure(diagnostics);
    click(summary);
    expect(within(diagnostics).getByText("Not reused")).toBeInTheDocument();
    expect(
      within(diagnostics).queryByText("Fresh evaluation"),
    ).not.toBeInTheDocument();
  });

  it("keeps Debug settings usable while diagnostics load or are unavailable", async () => {
    const releaseDiagnostics = context.mocks.deferred<void>();
    context.mocks.api(
      connectorCatalogContract.diagnostics,
      async ({ respond }) => {
        await releaseDiagnostics.promise;
        return respond(404, {
          error: {
            message: "Connector catalog diagnostics are unavailable",
            code: "NOT_FOUND",
          },
        });
      },
    );

    await openDialog("admin", "debug");

    const diagnostics = await screen.findByRole("region", {
      name: "Connector catalog",
    });
    expect(within(diagnostics).getByText("Loading")).toBeInTheDocument();
    expect(diagnostics.querySelector("summary")).toBeNull();
    expect(screen.getByText("Build information")).toBeInTheDocument();
    expect(screen.getByText("Capture network bodies")).toBeInTheDocument();

    releaseDiagnostics.resolve();
    await expect(
      within(diagnostics).findByText("Unavailable"),
    ).resolves.toBeInTheDocument();
    expect(diagnostics.querySelector("summary")).toBeNull();
  });
});
