import { screen, waitFor, within } from "@testing-library/react";
import { zeroConnectorCatalogContract } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import {
  type UserLocale,
  type UserPreferencesResponse,
  zeroUserPreferencesContract,
} from "@vm0/api-contracts/contracts/zero-user-preferences";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { localeStorageKey } from "../../../i18n/locale-storage.ts";
import { localStorageSignals } from "../../../signals/external/local-storage.ts";

const context = testContext();
const { set$: setCachedLocale$ } = localStorageSignals(
  localeStorageKey("org_default"),
);

function cachedLocale(): string | null {
  const { get$ } = localStorageSignals(localeStorageKey("org_default"));
  return context.store.get(get$);
}

async function openDialog(
  role: "admin" | "member" = "admin",
  section: "debug" | "general" | "preference" = "general",
): Promise<void> {
  context.mocks.data.org({
    id: "org_1",
    slug: "test-org",
    name: "Test Org",
    role,
  });
  context.mocks.data.orgMembers({
    slug: "test-org",
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
      ...(section === "debug" ? { [FeatureSwitchKey.ZeroDebug]: true } : {}),
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
    supportedLocales,
    pinnedAgentIds: [],
    sendMode: "enter",
    morningBriefEnabled: false,
    morningBriefNextRunAt: null,
    captureNetworkBodiesRemaining: 0,
  };
}

describe("settings dialog", () => {
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

  it("defaults to English instead of the browser language before user selection", async () => {
    const submittedLocales: UserLocale[] = [];
    let serverLocale: UserLocale | null = null;
    context.mocks.browser.language("id-ID");
    context.mocks.api(zeroUserPreferencesContract.get, ({ respond }) => {
      return respond(200, createPreferences(serverLocale));
    });
    context.mocks.api(
      zeroUserPreferencesContract.update,
      ({ body, respond }) => {
        if (body.locale !== undefined) {
          serverLocale = body.locale;
          submittedLocales.push(body.locale);
        }
        return respond(200, createPreferences(serverLocale));
      },
    );

    await openDialog("admin", "preference");

    const languageSelect = await screen.findByRole("combobox", {
      name: "Language",
    });
    await waitFor(() => {
      expect(submittedLocales).toContain("en-US");
      expect(languageSelect).toHaveTextContent("English");
      expect(languageSelect).toBeEnabled();
      expect(document.documentElement.lang).toBe("en-US");
      expect(cachedLocale()).toBe("en-US");
    });

    click(languageSelect);
    click(screen.getByRole("option", { name: "Bahasa Indonesia" }));

    await waitFor(() => {
      expect(submittedLocales).toContain("id-ID");
      expect(
        screen.getByRole("combobox", { name: "Bahasa" }),
      ).toHaveTextContent("Bahasa Indonesia");
      expect(document.documentElement.lang).toBe("id-ID");
      expect(cachedLocale()).toBe("id-ID");
    });

    click(screen.getByRole("combobox", { name: "Bahasa" }));
    click(screen.getByRole("option", { name: "English" }));
    await waitFor(() => {
      expect(document.documentElement.lang).toBe("en-US");
    });
  });

  it("persists a cached locale when the workspace has no server preference", async () => {
    const submittedLocales: UserLocale[] = [];
    document.documentElement.lang = "id-ID";
    context.store.set(setCachedLocale$, "id-ID");
    context.mocks.api(zeroUserPreferencesContract.get, ({ respond }) => {
      return respond(200, createPreferences(null));
    });
    context.mocks.api(
      zeroUserPreferencesContract.update,
      ({ body, respond }) => {
        if (body.locale !== undefined) {
          submittedLocales.push(body.locale);
        }
        return respond(200, createPreferences(body.locale ?? null));
      },
    );

    await openDialog("admin", "preference");

    const languageSelect = await screen.findByRole("combobox", {
      name: "Bahasa",
    });
    await waitFor(() => {
      expect(submittedLocales).toContain("id-ID");
      expect(languageSelect).toHaveTextContent("Bahasa Indonesia");
      expect(languageSelect).toHaveAccessibleName("Bahasa");
      expect(document.documentElement.lang).toBe("id-ID");
      expect(cachedLocale()).toBe("id-ID");
    });

    click(languageSelect);
    click(screen.getByRole("option", { name: "English" }));
    await waitFor(() => {
      expect(document.documentElement.lang).toBe("en-US");
    });
  });

  it("selects and persists German through the advertised locale handshake", async () => {
    const submittedLocales: UserLocale[] = [];
    let serverLocale: UserLocale | null = null;
    const supportedLocales: UserLocale[] = ["en-US", "pt-BR", "de-DE"];
    context.mocks.api(zeroUserPreferencesContract.get, ({ respond }) => {
      return respond(200, createPreferences(serverLocale, supportedLocales));
    });
    context.mocks.api(
      zeroUserPreferencesContract.update,
      ({ body, respond }) => {
        if (body.locale !== undefined) {
          serverLocale = body.locale;
          submittedLocales.push(body.locale);
        }
        return respond(200, createPreferences(serverLocale, supportedLocales));
      },
    );

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
      expect(cachedLocale()).toBe("de-DE");
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
      zeroUserPreferencesContract.get,
      async ({ respond, withSignal }) => {
        if (holdPreferenceReload) {
          preferenceReloadStarted.resolve();
          await withSignal(releasePreferenceReload.promise);
          preferenceReloadCompleted.resolve();
        }
        return respond(200, createPreferences(serverLocale, supportedLocales));
      },
    );
    context.mocks.api(
      zeroUserPreferencesContract.update,
      ({ body, respond }) => {
        if (body.locale !== undefined) {
          serverLocale = body.locale;
        }
        return respond(200, createPreferences(serverLocale, supportedLocales));
      },
    );

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
    context.mocks.api(zeroUserPreferencesContract.get, ({ respond }) => {
      return respond(200, createItalianPreferences(serverLocale));
    });
    context.mocks.api(
      zeroUserPreferencesContract.update,
      ({ body, respond }) => {
        if (body.locale !== undefined) {
          serverLocale = body.locale;
          submittedLocales.push(body.locale);
        }
        return respond(200, createItalianPreferences(serverLocale));
      },
    );

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
      expect(cachedLocale()).toBe("it-IT");
      expect(screen.getByText("Aspetto")).toBeInTheDocument();
    });
  });

  it("selects and persists French when the API advertises it", async () => {
    const submittedLocales: UserLocale[] = [];
    let serverLocale: UserLocale | null = "en-US";
    const supportedLocales: UserLocale[] = ["en-US", "pt-BR", "fr-FR"];
    context.mocks.api(zeroUserPreferencesContract.get, ({ respond }) => {
      return respond(200, createPreferences(serverLocale, supportedLocales));
    });
    context.mocks.api(
      zeroUserPreferencesContract.update,
      ({ body, respond }) => {
        if (body.locale !== undefined) {
          serverLocale = body.locale;
          submittedLocales.push(body.locale);
        }
        return respond(200, createPreferences(serverLocale, supportedLocales));
      },
    );

    await openDialog("admin", "preference");

    click(await screen.findByRole("combobox", { name: "Language" }));
    click(screen.getByRole("option", { name: "Français" }));

    await waitFor(() => {
      expect(submittedLocales).toContain("fr-FR");
      expect(
        screen.getByRole("combobox", { name: "Langue" }),
      ).toHaveTextContent("Français");
      expect(document.documentElement.lang).toBe("fr-FR");
      expect(cachedLocale()).toBe("fr-FR");
    });
  });

  it("selects and persists Hindi when the API advertises it", async () => {
    const submittedLocales: UserLocale[] = [];
    let serverLocale: UserLocale | null = "en-US";
    const supportedLocales: UserLocale[] = ["en-US", "pt-BR", "hi-IN"];
    context.mocks.api(zeroUserPreferencesContract.get, ({ respond }) => {
      return respond(200, createPreferences(serverLocale, supportedLocales));
    });
    context.mocks.api(
      zeroUserPreferencesContract.update,
      ({ body, respond }) => {
        if (body.locale !== undefined) {
          serverLocale = body.locale;
          submittedLocales.push(body.locale);
        }
        return respond(200, createPreferences(serverLocale, supportedLocales));
      },
    );

    await openDialog("admin", "preference");

    click(await screen.findByRole("combobox", { name: "Language" }));
    click(screen.getByRole("option", { name: "हिन्दी" }));

    await waitFor(() => {
      expect(submittedLocales).toContain("hi-IN");
      expect(screen.getByRole("combobox", { name: "भाषा" })).toHaveTextContent(
        "हिन्दी",
      );
      expect(document.documentElement.lang).toBe("hi-IN");
      expect(cachedLocale()).toBe("hi-IN");
    });
  });

  it("overrides a cached language with the workspace server preference", async () => {
    document.documentElement.lang = "en-US";
    context.store.set(setCachedLocale$, "en-US");
    context.signal.addEventListener(
      "abort",
      () => {
        document.documentElement.lang = "en-US";
      },
      { once: true },
    );
    context.mocks.data.userPreferences(createPreferences("id-ID"));

    await openDialog("admin", "preference");

    const languageSelect = await screen.findByRole("combobox", {
      name: "Bahasa",
    });
    await waitFor(() => {
      expect(languageSelect).toHaveTextContent("Bahasa Indonesia");
      expect(languageSelect).toHaveAccessibleName("Bahasa");
      expect(document.documentElement.lang).toBe("id-ID");
      expect(cachedLocale()).toBe("id-ID");
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
    context.mocks.api(zeroUserPreferencesContract.get, async ({ respond }) => {
      preferenceRequestCount += 1;
      if (preferenceRequestCount > 1) {
        reloadStarted.resolve();
        await releaseReload.promise;
      }
      return respond(200, createPreferences(serverLocale, supportedLocales));
    });
    context.mocks.api(
      zeroUserPreferencesContract.update,
      ({ body, respond }) => {
        if (body.locale !== undefined) {
          serverLocale = body.locale;
          submittedLocales.push(body.locale);
        }
        return respond(200, createPreferences(serverLocale, supportedLocales));
      },
    );

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
      expect(cachedLocale()).toBe("ja-JP");
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
    context.mocks.api(zeroUserPreferencesContract.get, ({ respond }) => {
      return respond(200, createPreferences(serverLocale, supportedLocales));
    });
    context.mocks.api(
      zeroUserPreferencesContract.update,
      ({ body, respond }) => {
        if (body.locale !== undefined) {
          serverLocale = body.locale;
          submittedLocales.push(body.locale);
        }
        return respond(200, createPreferences(serverLocale, supportedLocales));
      },
    );

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
      expect(cachedLocale()).toBe("ko-KR");
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
    context.mocks.api(zeroUserPreferencesContract.get, ({ respond }) => {
      return respond(200, createPreferences(serverLocale, supportedLocales));
    });
    context.mocks.api(
      zeroUserPreferencesContract.update,
      ({ body, respond }) => {
        if (body.locale !== undefined) {
          serverLocale = body.locale;
          submittedLocales.push(body.locale);
        }
        return respond(200, createPreferences(serverLocale, supportedLocales));
      },
    );

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
      expect(cachedLocale()).toBe("es-ES");
    });

    click(screen.getByRole("combobox", { name: "Idioma" }));
    click(screen.getByRole("option", { name: "English" }));
    await waitFor(() => {
      expect(document.documentElement.lang).toBe("en-US");
    });
  });

  it("restores Japanese from the workspace preference on reload", async () => {
    document.documentElement.lang = "en-US";
    context.store.set(setCachedLocale$, "en-US");
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
      expect(cachedLocale()).toBe("ja-JP");
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
    context.store.set(setCachedLocale$, "en-US");
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
      expect(cachedLocale()).toBe("ko-KR");
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
    context.store.set(setCachedLocale$, "en-US");
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
      expect(cachedLocale()).toBe("es-ES");
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
    context.store.set(setCachedLocale$, "ja-JP");
    context.mocks.api(zeroUserPreferencesContract.get, ({ respond }) => {
      return respond(200, createPreferences(null, ["en-US", "pt-BR"]));
    });
    context.mocks.api(
      zeroUserPreferencesContract.update,
      ({ body, respond }) => {
        if (body.locale !== undefined) {
          submittedLocales.push(body.locale);
        }
        return respond(
          200,
          createPreferences(body.locale ?? null, ["en-US", "pt-BR"]),
        );
      },
    );

    await openDialog("admin", "preference");

    await waitFor(() => {
      expect(submittedLocales).toContain("en-US");
      expect(submittedLocales).not.toContain("ja-JP");
      expect(document.documentElement.lang).toBe("en-US");
      expect(cachedLocale()).toBe("en-US");
    });
  });

  it("does not submit Korean to an API that does not advertise it", async () => {
    const submittedLocales: UserLocale[] = [];
    document.documentElement.lang = "ko-KR";
    context.store.set(setCachedLocale$, "ko-KR");
    const supportedLocales: UserLocale[] = ["en-US", "pt-BR", "ja-JP"];
    context.mocks.api(zeroUserPreferencesContract.get, ({ respond }) => {
      return respond(200, createPreferences(null, supportedLocales));
    });
    context.mocks.api(
      zeroUserPreferencesContract.update,
      ({ body, respond }) => {
        if (body.locale !== undefined) {
          submittedLocales.push(body.locale);
        }
        return respond(
          200,
          createPreferences(body.locale ?? null, supportedLocales),
        );
      },
    );

    await openDialog("admin", "preference");

    await waitFor(() => {
      expect(submittedLocales).toContain("en-US");
      expect(submittedLocales).not.toContain("ko-KR");
      expect(document.documentElement.lang).toBe("en-US");
      expect(cachedLocale()).toBe("en-US");
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
    context.store.set(setCachedLocale$, "es-ES");
    const supportedLocales: UserLocale[] = ["en-US", "pt-BR"];
    context.mocks.api(zeroUserPreferencesContract.get, ({ respond }) => {
      return respond(200, createPreferences(null, supportedLocales));
    });
    context.mocks.api(
      zeroUserPreferencesContract.update,
      ({ body, respond }) => {
        if (body.locale !== undefined) {
          submittedLocales.push(body.locale);
        }
        return respond(
          200,
          createPreferences(body.locale ?? null, supportedLocales),
        );
      },
    );

    await openDialog("admin", "preference");

    await waitFor(() => {
      expect(submittedLocales).toContain("en-US");
      expect(submittedLocales).not.toContain("es-ES");
      expect(document.documentElement.lang).toBe("en-US");
      expect(cachedLocale()).toBe("en-US");
    });
  });

  it("hides the language entry when the deployed API predates locale support", async () => {
    const oldApiPreferences = createPreferences(null);
    delete oldApiPreferences.locale;
    context.mocks.api(zeroUserPreferencesContract.get, ({ respond }) => {
      return respond(200, oldApiPreferences);
    });

    await openDialog("admin", "preference");

    await waitFor(() => {
      expect(screen.getByText("Theme")).toBeInTheDocument();
      expect(screen.queryByText("Language")).not.toBeInTheDocument();
    });
  });

  it("hides the language entry when the API omits the locale capability handshake", async () => {
    const oldApiPreferences = createPreferences("en-US");
    delete oldApiPreferences.supportedLocales;
    context.mocks.api(zeroUserPreferencesContract.get, ({ respond }) => {
      return respond(200, oldApiPreferences);
    });

    await openDialog("admin", "preference");

    await waitFor(() => {
      expect(screen.getByText("Theme")).toBeInTheDocument();
      expect(screen.queryByText("Language")).not.toBeInTheDocument();
    });
  });

  it("hides the language entry when the API advertises only English", async () => {
    document.documentElement.lang = "de-DE";
    context.store.set(setCachedLocale$, "de-DE");
    const guardedPreferences = createPreferences("de-DE");
    guardedPreferences.supportedLocales = ["en-US"];
    context.mocks.data.userPreferences(guardedPreferences);

    await openDialog("admin", "preference");

    await waitFor(() => {
      expect(screen.getByText("Theme")).toBeInTheDocument();
      expect(screen.queryByText("Language")).not.toBeInTheDocument();
      expect(document.documentElement.lang).toBe("en-US");
      expect(cachedLocale()).toBe("en-US");
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

  it("does not submit cached French to an API that does not advertise it", async () => {
    const submittedLocales: UserLocale[] = [];
    document.documentElement.lang = "fr-FR";
    context.store.set(setCachedLocale$, "fr-FR");
    context.signal.addEventListener(
      "abort",
      () => {
        document.documentElement.lang = "en-US";
      },
      { once: true },
    );
    context.mocks.api(zeroUserPreferencesContract.get, ({ respond }) => {
      return respond(200, createPreferences(null, ["en-US", "pt-BR"]));
    });
    context.mocks.api(
      zeroUserPreferencesContract.update,
      ({ body, respond }) => {
        if (body.locale !== undefined) {
          submittedLocales.push(body.locale);
        }
        return respond(
          200,
          createPreferences(body.locale ?? null, ["en-US", "pt-BR"]),
        );
      },
    );

    await openDialog("admin", "preference");

    await waitFor(() => {
      expect(submittedLocales).toContain("en-US");
      expect(submittedLocales).not.toContain("fr-FR");
      expect(document.documentElement.lang).toBe("en-US");
      expect(cachedLocale()).toBe("en-US");
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

  it("routes members away from admin-only workspace settings", async () => {
    await openDialog("member");

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByText("Workspace")).not.toBeInTheDocument();
    expect(screen.getByText("Theme")).toBeInTheDocument();
  });

  it("shows connector catalog diagnostics in Debug settings", async () => {
    await openDialog("admin", "debug");

    const diagnostics = await screen.findByRole("region", {
      name: "Connector catalog",
    });
    expect(within(diagnostics).getByText("Stale")).toBeInTheDocument();
    expect(within(diagnostics).getByText("Current")).toBeInTheDocument();
    expect(within(diagnostics).getByText("2026-07-25.1")).toBeInTheDocument();
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
  });

  it("renders connector catalog diagnostics from a ref-only API", async () => {
    context.mocks.api(
      zeroConnectorCatalogContract.diagnostics,
      ({ respond }) => {
        return respond(200, {
          state: "current",
          active: {
            catalogVersion: "2026-07-25.1",
            catalogDigest: `sha256:${"a".repeat(64)}`,
            activatedAt: "2026-07-25T01:00:00.000Z",
          },
          lastAttempt: null,
          lastSuccessAt: "2026-07-25T01:00:00.000Z",
          rejectedCandidate: null,
          filtering: {
            capabilityDigest: `sha256:${"b".repeat(64)}`,
            evaluatedAt: "2026-07-25T01:00:00.000Z",
            stale: false,
            filteredAuthMethods: [
              {
                connectorRef: "legacy-github",
                authMethodId: "oauth",
                reasons: ["missing-revoke-provider"],
              },
            ],
          },
          credentialStorage: {
            missingConnectorVersions: 0,
            unownedConnectorSecrets: 0,
            unownedConnectorVariables: 0,
            unresolvedBridgeCredentials: 0,
          },
        });
      },
    );

    await openDialog("admin", "debug");

    const diagnostics = await screen.findByRole("region", {
      name: "Connector catalog",
    });
    expect(
      within(diagnostics).getByText("legacy-github / oauth"),
    ).toBeInTheDocument();
  });

  it("does not describe an uncached rejection as a fresh evaluation", async () => {
    context.mocks.api(
      zeroConnectorCatalogContract.diagnostics,
      ({ respond }) => {
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
      },
    );

    await openDialog("admin", "debug");

    const diagnostics = await screen.findByRole("region", {
      name: "Connector catalog",
    });
    expect(within(diagnostics).getByText("Not reused")).toBeInTheDocument();
    expect(
      within(diagnostics).queryByText("Fresh evaluation"),
    ).not.toBeInTheDocument();
  });

  it("keeps Debug settings usable when diagnostics are unavailable", async () => {
    context.mocks.api(
      zeroConnectorCatalogContract.diagnostics,
      ({ respond }) => {
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
    expect(within(diagnostics).getByText("Unavailable")).toBeInTheDocument();
    expect(screen.getByText("Build information")).toBeInTheDocument();
    expect(screen.getByText("Capture network bodies")).toBeInTheDocument();
  });
});
