import { HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import indexHtml from "../../../index.html?raw";
import { setupPage } from "../../__tests__/page-helper.ts";
import { formatAppNumber } from "../../i18n/format.ts";
import frFRClerk from "../../i18n/clerk-localizations/fr-FR.json";
import frFRClerkUrl from "../../i18n/clerk-localizations/fr-FR.json?url";
import itITClerk from "../../i18n/clerk-localizations/it-IT.json";
import itITClerkUrl from "../../i18n/clerk-localizations/it-IT.json?url";
import ptBRClerkUrl from "../../i18n/clerk-localizations/pt-BR.json?url";
import {
  clerkLocalizationForLocale,
  clerkLocalizations$,
} from "../../i18n/clerk-localization.ts";
import frFRCommonUrl from "../../i18n/locales/fr-FR/common.json?url";
import hiINAgents from "../../i18n/locales/hi-IN/agents.json";
import hiINCommon from "../../i18n/locales/hi-IN/common.json";
import idIDAgents from "../../i18n/locales/id-ID/agents.json";
import itITCommon from "../../i18n/locales/it-IT/common.json";
import itITCommonUrl from "../../i18n/locales/it-IT/common.json?url";
import {
  CHAT_ATTACHMENT_HEADINGS,
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from "../../i18n/resources.ts";
import { changeI18nLanguage, i18n, initializeI18n } from "../../i18n/index.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import { sessionStorageSignals } from "../external/session-storage.ts";
import { initLocale$, locale$, setLocale$ } from "../locale.ts";
import { resetSignal } from "../utils.ts";
import { testContext } from "./test-helpers.ts";

const ACTIVE_ORG_STORAGE_KEY = "clerk-active-org-id";
const TEST_ORG_ID = "org_inline_locale";
const TEST_LOCALE_STORAGE_KEY = `vm0:locale:${TEST_ORG_ID}`;
const testLocaleStorage = localStorageSignals(TEST_LOCALE_STORAGE_KEY);
const activeOrgIdStorage = sessionStorageSignals(ACTIVE_ORG_STORAGE_KEY);

function loadedClerkLocalization(locale: SupportedLocale) {
  return clerkLocalizationForLocale(
    context.store.get(clerkLocalizations$),
    locale,
  );
}

type LocaleEntrypointScript = (
  windowObject: Window,
  documentObject: Document,
  sessionStorageObject: Storage,
  navigatorObject: Navigator,
) => void;

function getInlineScriptSource(marker: string, surface: string): string {
  const inlineScripts = [
    ...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/gi),
  ]
    .map((match) => {
      return match[1];
    })
    .filter((script): script is string => {
      return script !== undefined;
    });
  const source = inlineScripts.find((script) => {
    return script.includes(marker);
  });

  if (source === undefined) {
    throw new Error(`Unable to locate the ${surface} in index.html`);
  }
  return source;
}

function executeLocaleEntrypoint(): void {
  bindBootstrapStateToSignal();
  const executeEntrypointScript = new Function(
    "window",
    "document",
    "sessionStorage",
    "navigator",
    `${getInlineScriptSource('"vm0:locale:"', "locale resolver")}\n//# sourceURL=platform-locale-entrypoint-test.js`,
  ) as LocaleEntrypointScript;

  executeEntrypointScript(window, document, sessionStorage, navigator);
}

function executeBrowserCompatibilityEntrypoint(userAgent: string): void {
  bindBootstrapStateToSignal();
  const executeEntrypointScript = new Function(
    "window",
    "document",
    "navigator",
    `${getInlineScriptSource("var iosPattern =", "browser compatibility resolver")}\n//# sourceURL=platform-browser-compatibility-entrypoint-test.js`,
  ) as (
    windowObject: Window,
    documentObject: Document,
    navigatorObject: Navigator,
  ) => void;

  executeEntrypointScript(window, document, {
    userAgent,
  } as Navigator);
}

function executeMetadataEntrypoint(): void {
  bindBootstrapStateToSignal();
  const executeEntrypointScript = new Function(
    "window",
    "document",
    `${getInlineScriptSource("var metadata = [", "metadata localizer")}\n//# sourceURL=platform-metadata-entrypoint-test.js`,
  ) as (windowObject: Window, documentObject: Document) => void;

  executeEntrypointScript(window, document);
}

const context = testContext();

function bindBootstrapStateToSignal(): void {
  window.__vm0AfterFirstPaint = (callback) => {
    callback();
  };
  context.signal.addEventListener(
    "abort",
    () => {
      Reflect.deleteProperty(window, "__vm0BrowserSupported");
      Reflect.deleteProperty(window, "__vm0BrowserUpgrade");
      Reflect.deleteProperty(window, "__vm0AfterFirstPaint");
      Reflect.deleteProperty(window, "__vm0PreBundleCopy");
      delete document.documentElement.dataset.appBrandName;
      delete document.documentElement.dataset.appHeadManaged;
      delete document.documentElement.dataset.browserUpgradeTarget;
      delete document.documentElement.dataset.browserSupported;
    },
    { once: true },
  );
}

describe("bootstrap locale", () => {
  it("loads English resources for the default locale", async () => {
    context.mocks.browser.language(DEFAULT_LOCALE);
    executeLocaleEntrypoint();

    await setupPage({
      context,
      path: "/error",
      withoutRender: true,
    });

    expect(context.store.get(locale$)).toBe(DEFAULT_LOCALE);
    expect(i18n.language).toBe(DEFAULT_LOCALE);
    expect(i18n.hasResourceBundle(DEFAULT_LOCALE, "common")).toBeTruthy();
    expect(i18n.hasResourceBundle(DEFAULT_LOCALE, "agents")).toBeTruthy();
  });

  it("loads only the selected Clerk localization and reuses its cache", async () => {
    const clerkLocalizationRequests: string[] = [];
    context.mocks.http.get(
      /\/clerk-localizations\/[^/]+\.json$/,
      ({ request }) => {
        clerkLocalizationRequests.push(new URL(request.url).pathname);
        return HttpResponse.json(frFRClerk);
      },
    );
    context.mocks.browser.language("fr-FR");
    executeLocaleEntrypoint();

    await setupPage({ context, path: "/error", withoutRender: true });

    expect(clerkLocalizationRequests).toStrictEqual([
      new URL(frFRClerkUrl, location.href).pathname,
    ]);
    expect(loadedClerkLocalization("fr-FR").signIn?.start?.actionLink).toBe(
      "S'inscrire",
    );

    await context.store.set(setLocale$, DEFAULT_LOCALE, context.signal);
    await context.store.set(setLocale$, "fr-FR", context.signal);

    expect(clerkLocalizationRequests).toHaveLength(1);
  });

  it("uses English Clerk fallback when a selected localization fails", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    context.mocks.http.get(ptBRClerkUrl, () => {
      return new HttpResponse(null, { status: 503 });
    });
    await initializeI18n(DEFAULT_LOCALE, context.signal);

    await context.store.set(setLocale$, "pt-BR", context.signal);

    expect(context.store.get(locale$)).toBe("pt-BR");
    expect(i18n.language).toBe("pt-BR");
    expect(document.documentElement.lang).toBe("pt-BR");
    expect(context.store.get(clerkLocalizations$).has("pt-BR")).toBeFalsy();
    expect(loadedClerkLocalization("pt-BR").locale).toBe(DEFAULT_LOCALE);
    expect(consoleError).toHaveBeenCalledWith(
      "[E][ClerkLocalization]",
      `Failed to load pt-BR Clerk localization; falling back to ${DEFAULT_LOCALE}`,
      expect.any(Error),
    );
  });

  it("does not cache or apply a runtime Clerk localization after abort", async () => {
    await initializeI18n(DEFAULT_LOCALE, context.signal);
    const requestStarted = context.mocks.deferred<void>();
    context.mocks.http.get(itITClerkUrl, ({ never }) => {
      requestStarted.resolve(undefined);
      return never();
    });
    const resetLocaleSwitchSignal$ = resetSignal();
    const localeSwitchSignal = context.store.set(
      resetLocaleSwitchSignal$,
      context.signal,
    );

    const switching = context.store.set(
      setLocale$,
      "it-IT",
      localeSwitchSignal,
    );
    await requestStarted.promise;
    context.store.set(resetLocaleSwitchSignal$, context.signal);

    await expect(switching).rejects.toMatchObject({ name: "AbortError" });
    expect(context.store.get(locale$)).toBe(DEFAULT_LOCALE);
    expect(i18n.language).toBe(DEFAULT_LOCALE);
    expect(document.documentElement.lang).toBe(DEFAULT_LOCALE);
    expect(context.store.get(clerkLocalizations$).has("it-IT")).toBeFalsy();
    expect(loadedClerkLocalization("it-IT").locale).toBe(DEFAULT_LOCALE);
  });

  it("does not initialize or cache a selected Clerk locale after abort", async () => {
    document.documentElement.lang = "it-IT";
    const appRequestStarted = context.mocks.deferred<void>();
    const clerkLocalizationLoaded = context.mocks.deferred<void>();
    context.mocks.http.get(itITCommonUrl, ({ never }) => {
      appRequestStarted.resolve(undefined);
      return never();
    });
    context.mocks.http.get(itITClerkUrl, () => {
      clerkLocalizationLoaded.resolve(undefined);
      return HttpResponse.json(itITClerk);
    });
    const resetLocaleInitializationSignal$ = resetSignal();
    const localeInitializationSignal = context.store.set(
      resetLocaleInitializationSignal$,
      context.signal,
    );

    const initializing = context.store.set(
      initLocale$,
      localeInitializationSignal,
    );
    await Promise.all([
      appRequestStarted.promise,
      clerkLocalizationLoaded.promise,
    ]);
    context.store.set(resetLocaleInitializationSignal$, context.signal);

    await expect(initializing).rejects.toMatchObject({ name: "AbortError" });
    expect(context.store.get(locale$)).toBe(DEFAULT_LOCALE);
    expect(i18n.language).toBe(DEFAULT_LOCALE);
    expect(document.documentElement.lang).toBe("it-IT");
    expect(context.store.get(clerkLocalizations$).has("it-IT")).toBeFalsy();
  });

  it("loads resources for every supported locale", async () => {
    for (const locale of SUPPORTED_LOCALES) {
      await expect(initializeI18n(locale)).resolves.toBe(locale);
      expect(i18n.hasResourceBundle(locale, "common")).toBeTruthy();
      expect(i18n.hasResourceBundle(locale, "agents")).toBeTruthy();
      expect(
        i18n.t(($) => {
          return $.chat.attachments.title;
        }),
      ).toBe(CHAT_ATTACHMENT_HEADINGS[locale]);
    }
  });

  it("switches at runtime to every supported locale", async () => {
    await initializeI18n(DEFAULT_LOCALE);

    for (const locale of SUPPORTED_LOCALES) {
      await context.store.set(setLocale$, locale, context.signal);
      expect(context.store.get(locale$)).toBe(locale);
      expect(i18n.language).toBe(locale);
      expect(document.documentElement.lang).toBe(locale);
      expect(
        i18n.t(($) => {
          return $.chat.attachments.title;
        }),
      ).toBe(CHAT_ATTACHMENT_HEADINGS[locale]);
    }
  });

  it("falls back to English when the selected locale fails to load", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    context.mocks.http.get(frFRCommonUrl, () => {
      return new HttpResponse(null, { status: 503 });
    });

    await expect(initializeI18n("fr-FR")).resolves.toBe(DEFAULT_LOCALE);
    expect(consoleError).toHaveBeenCalledWith(
      "[E][I18n]",
      `Failed to load fr-FR locale resources; falling back to ${DEFAULT_LOCALE}`,
      expect.any(Error),
    );
    expect(i18n.language).toBe(DEFAULT_LOCALE);
    expect(
      i18n.t(($) => {
        return $.settings.preferences.language.title;
      }),
    ).toBe("Language");
  });

  it("keeps runtime locale state unchanged when resources fail to load", async () => {
    await initializeI18n(DEFAULT_LOCALE);
    context.mocks.http.get(frFRCommonUrl, () => {
      return new HttpResponse(null, { status: 503 });
    });

    await expect(
      context.store.set(setLocale$, "fr-FR", context.signal),
    ).rejects.toThrow(
      "Failed to load fr-FR common locale resources (HTTP 503)",
    );

    expect(context.store.get(locale$)).toBe(DEFAULT_LOCALE);
    expect(i18n.language).toBe(DEFAULT_LOCALE);
    expect(document.documentElement.lang).toBe(DEFAULT_LOCALE);
    expect(i18n.hasResourceBundle("fr-FR", "common")).toBeFalsy();
    expect(i18n.hasResourceBundle("fr-FR", "agents")).toBeFalsy();
  });

  it("does not apply a locale switch after its lifecycle is aborted", async () => {
    await initializeI18n(DEFAULT_LOCALE);
    const requestStarted = context.mocks.deferred<void>();
    context.mocks.http.get(frFRCommonUrl, ({ never }) => {
      requestStarted.resolve(undefined);
      return never();
    });
    const resetLocaleSwitchSignal$ = resetSignal();
    const localeSwitchSignal = context.store.set(
      resetLocaleSwitchSignal$,
      context.signal,
    );

    const switching = changeI18nLanguage("fr-FR", localeSwitchSignal);
    await requestStarted.promise;
    context.store.set(resetLocaleSwitchSignal$, context.signal);

    await expect(switching).rejects.toMatchObject({ name: "AbortError" });
    expect(i18n.language).toBe(DEFAULT_LOCALE);
    expect(i18n.hasResourceBundle("fr-FR", "common")).toBeFalsy();
    expect(i18n.hasResourceBundle("fr-FR", "agents")).toBeFalsy();
  });

  it("normalizes a Japanese browser language before bundle render", () => {
    context.mocks.browser.language("ja");

    executeLocaleEntrypoint();

    expect(document.documentElement.lang).toBe("ja-JP");
    expect(context.store.get(testLocaleStorage.get$)).toBeNull();
    expect(window.__vm0PreBundleCopy).toMatchObject({
      loading: {
        ariaLabel: "ワークスペースを読み込み中",
      },
      metadata: {
        title: "Zero — VM0のAIコワーカー",
      },
    });
  });

  it("normalizes a Hindi browser language before bundle render", () => {
    context.mocks.browser.language("hi");

    executeLocaleEntrypoint();

    expect(document.documentElement.lang).toBe("hi-IN");
    expect(context.store.get(testLocaleStorage.get$)).toBeNull();
    expect(window.__vm0PreBundleCopy).toMatchObject({
      loading: {
        ariaLabel: "आपका वर्कस्पेस लोड हो रहा है",
        messages: expect.arrayContaining(["न्यूरॉन्स को सक्रिय कर रहे हैं..."]),
      },
      metadata: {
        title: "Zero — VM0 से आपका AI सहकर्मी",
      },
    });
  });

  it("normalizes a Spanish browser language before bundle render", () => {
    context.mocks.browser.language("es");

    executeLocaleEntrypoint();

    expect(document.documentElement.lang).toBe("es-ES");
    expect(context.store.get(testLocaleStorage.get$)).toBeNull();
    expect(window.__vm0PreBundleCopy).toMatchObject({
      loading: {
        ariaLabel: "Cargando tu espacio de trabajo",
      },
      metadata: {
        title: "Zero — Tu compañero de IA de VM0",
      },
    });
  });

  it("preserves edge metadata while applying the Okou browser brand", async () => {
    context.mocks.browser.language("en-US");
    document.documentElement.dataset.appBrandName = "Okou";
    document.documentElement.dataset.appHeadManaged = "true";
    document.documentElement.dataset.browserUpgradeTarget = "chrome";

    const metadata = document.createElement("meta");
    metadata.name = "description";
    metadata.content = "Edge-managed description";
    const upgradeDescription = document.createElement("p");
    upgradeDescription.id = "browser-upgrade-description";
    document.head.append(metadata);
    document.body.append(upgradeDescription);
    context.signal.addEventListener(
      "abort",
      () => {
        metadata.remove();
        upgradeDescription.remove();
      },
      { once: true },
    );

    executeLocaleEntrypoint();
    executeMetadataEntrypoint();

    expect(window.__vm0PreBundleCopy).toMatchObject({
      browserUpgrade: {
        chrome: {
          description:
            "Okou does not support your current browser version. Update Chrome to continue.",
        },
      },
      metadata: {
        title: "Okou — Your AI coworker from Okou",
      },
    });

    await setupPage({
      context,
      path: "/error",
      withoutRender: true,
    });

    expect(metadata).toHaveAttribute("content", "Edge-managed description");
    expect(upgradeDescription).toHaveTextContent(
      "Okou does not support your current browser version.",
    );
  });

  it("loads Korean pre-bundle copy and typed resources from the browser locale", async () => {
    context.mocks.browser.language("ko-KR");
    executeLocaleEntrypoint();

    expect(document.documentElement.lang).toBe("ko-KR");
    expect(window.__vm0PreBundleCopy).toMatchObject({
      browserUpgrade: {
        chrome: {
          actionLabel: "Chrome 업데이트",
          title: "계속하려면 Chrome을 업데이트하세요",
        },
      },
      loading: {
        ariaLabel: "워크스페이스를 불러오는 중",
        messages: expect.arrayContaining(["뉴런을 예열하는 중..."]),
      },
      metadata: {
        title: "Zero — VM0의 AI 팀원",
      },
    });

    await setupPage({
      context,
      path: "/error",
      withoutRender: true,
    });

    expect(context.store.get(locale$)).toBe("ko-KR");
    expect(i18n.language).toBe("ko-KR");
    expect(document.documentElement.lang).toBe("ko-KR");
    expect(i18n.hasResourceBundle("ko-KR", "common")).toBeTruthy();
    expect(i18n.hasResourceBundle("ko-KR", "agents")).toBeTruthy();

    await context.store.set(setLocale$, DEFAULT_LOCALE, context.signal);
  });

  it("uses a supported browser language before a workspace is active", async () => {
    context.mocks.browser.language("id-ID");
    executeLocaleEntrypoint();

    expect(document.documentElement.lang).toBe("id-ID");
    expect(context.store.get(testLocaleStorage.get$)).toBeNull();
    expect(window.__vm0PreBundleCopy).toMatchObject({
      loading: {
        ariaLabel: "Memuat ruang kerja Anda",
        messages: expect.arrayContaining(["Sedang memanaskan neuron..."]),
      },
      metadata: {
        title: "Zero — Rekan kerja AI Anda dari VM0",
      },
    });

    await setupPage({
      context,
      path: "/error",
      withoutRender: true,
    });

    expect(context.store.get(locale$)).toBe("id-ID");
    expect(i18n.language).toBe("id-ID");
    expect(document.documentElement.lang).toBe("id-ID");
    expect(i18n.hasResourceBundle("en-US", "common")).toBeTruthy();
    expect(i18n.hasResourceBundle("id-ID", "common")).toBeTruthy();
    for (const unloadedLocale of SUPPORTED_LOCALES.filter((locale) => {
      return locale !== DEFAULT_LOCALE && locale !== "id-ID";
    })) {
      expect(i18n.hasResourceBundle(unloadedLocale, "common")).toBeFalsy();
      expect(i18n.hasResourceBundle(unloadedLocale, "agents")).toBeFalsy();
    }
    expect(new Intl.NumberFormat(i18n.language).format(1234.5)).toBe("1.234,5");
    expect(
      new Intl.DateTimeFormat(i18n.language, {
        month: "long",
        timeZone: "UTC",
      }).format(new Date("2026-07-30T00:00:00Z")),
    ).toBe("Juli");
    expect(
      i18n.t(
        ($) => {
          return $.workflows.automations.duration.hour;
        },
        { count: 2 },
      ),
    ).toBe("2 jam");

    context.signal.addEventListener(
      "abort",
      () => {
        i18n.addResourceBundle("id-ID", "agents", idIDAgents, true, true);
      },
      { once: true },
    );
    i18n.removeResourceBundle("id-ID", "agents");
    expect(
      i18n.t(
        ($) => {
          return $.fallbackName;
        },
        { ns: "agents" },
      ),
    ).toBe("Agent");

    const metadata = document.createElement("meta");
    metadata.name = "description";
    document.head.append(metadata);
    const upgradeTitle = document.createElement("h1");
    upgradeTitle.id = "browser-upgrade-title";
    const upgradeDescription = document.createElement("p");
    upgradeDescription.id = "browser-upgrade-description";
    const upgradeAction = document.createElement("a");
    upgradeAction.id = "browser-upgrade-action";
    document.body.append(upgradeTitle, upgradeDescription, upgradeAction);
    document.documentElement.dataset.browserUpgradeTarget = "chrome";
    context.signal.addEventListener(
      "abort",
      () => {
        metadata.remove();
        upgradeTitle.remove();
        upgradeDescription.remove();
        upgradeAction.remove();
      },
      { once: true },
    );

    await context.store.set(setLocale$, DEFAULT_LOCALE, context.signal);

    expect(context.store.get(locale$)).toBe(DEFAULT_LOCALE);
    expect(i18n.language).toBe(DEFAULT_LOCALE);
    expect(document.documentElement.lang).toBe(DEFAULT_LOCALE);
    expect(metadata).toHaveAttribute(
      "content",
      expect.stringContaining("Zero is your AI coworker from VM0"),
    );
    expect(upgradeTitle).toHaveTextContent("Update Chrome to continue");
    expect(upgradeDescription).toHaveTextContent(
      "Zero does not support your current browser version.",
    );
    expect(upgradeAction).toHaveTextContent("Update Chrome");
  });

  it("detects German from the browser before a workspace is active", () => {
    context.mocks.browser.language("de");

    executeLocaleEntrypoint();

    expect(document.documentElement.lang).toBe("de-DE");
    expect(window.__vm0PreBundleCopy).toMatchObject({
      loading: {
        ariaLabel: "Ihr Arbeitsbereich wird geladen",
      },
      metadata: {
        title: "Zero — Ihr KI-Kollege von VM0",
      },
    });
  });

  it("loads French bundles with localized formatting, plurals, and English fallback", async () => {
    context.mocks.browser.language("fr-CA");
    executeLocaleEntrypoint();

    expect(document.documentElement.lang).toBe("fr-FR");
    expect(window.__vm0PreBundleCopy).toMatchObject({
      loading: {
        ariaLabel: "Chargement de votre espace de travail",
      },
      metadata: {
        title: "Zero — Votre coéquipier IA créé par VM0",
      },
    });

    await setupPage({
      context,
      path: "/error",
      withoutRender: true,
    });

    expect(context.store.get(locale$)).toBe("fr-FR");
    expect(i18n.language).toBe("fr-FR");
    expect(i18n.hasResourceBundle("fr-FR", "common")).toBeTruthy();
    expect(i18n.hasResourceBundle("fr-FR", "agents")).toBeTruthy();
    expect(formatAppNumber(1234.5)).toBe(
      new Intl.NumberFormat("fr-FR").format(1234.5),
    );
    expect(
      i18n.t(
        ($) => {
          return $.activity.events.files;
        },
        { count: 2, formattedCount: formatAppNumber(2) },
      ),
    ).toBe("2 fichiers");
    expect(
      i18n.t(
        ($) => {
          return $.activity.events.files;
        },
        {
          count: 1_000_000,
          formattedCount: formatAppNumber(1_000_000),
        },
      ),
    ).toBe(`${formatAppNumber(1_000_000)} fichiers`);

    const fallbackI18n = i18n.cloneInstance({ forkResourceStore: true });
    fallbackI18n.removeResourceBundle("fr-FR", "common");
    await fallbackI18n.changeLanguage("fr-FR");
    expect(
      fallbackI18n.t(($) => {
        return $.settings.preferences.language.title;
      }),
    ).toBe("Language");

    await context.store.set(setLocale$, DEFAULT_LOCALE, context.signal);
  });

  it("uses the cached locale across pre-bundle UI and i18next", async () => {
    context.mocks.browser.language("en-US");
    context.store.set(activeOrgIdStorage.set$, TEST_ORG_ID);
    context.store.set(testLocaleStorage.set$, "id-ID");
    executeBrowserCompatibilityEntrypoint(
      "Mozilla/5.0 Chrome/100.0.0.0 Safari/537.36",
    );
    executeLocaleEntrypoint();

    const metadata = document.createElement("meta");
    metadata.name = "description";
    document.head.append(metadata);
    context.signal.addEventListener(
      "abort",
      () => {
        metadata.remove();
      },
      { once: true },
    );
    executeMetadataEntrypoint();

    await setupPage({
      context,
      path: "/error",
      withoutRender: true,
    });

    expect(context.store.get(locale$)).toBe("id-ID");
    expect(i18n.language).toBe("id-ID");
    expect(window.__vm0BrowserSupported).toBeFalsy();
    expect(window.__vm0BrowserUpgrade).toMatchObject({
      actionLabel: "Perbarui Chrome",
      actionUrl: "https://www.google.com/chrome/",
      title: "Perbarui Chrome untuk melanjutkan",
    });
    expect(metadata).toHaveAttribute(
      "content",
      expect.stringContaining("Zero adalah rekan kerja AI Anda dari VM0"),
    );
    expect(window.__vm0PreBundleCopy).toMatchObject({
      browserUpgrade: {
        safari: {
          actionLabel: "Perbarui Safari",
          title: "Perbarui Safari untuk melanjutkan",
        },
      },
      loading: {
        ariaLabel: "Memuat ruang kerja Anda",
        messages: expect.arrayContaining(["Sedang memanaskan neuron..."]),
      },
      metadata: {
        title: "Zero — Rekan kerja AI Anda dari VM0",
      },
    });

    context.signal.addEventListener(
      "abort",
      () => {
        i18n.addResourceBundle("id-ID", "agents", idIDAgents, true, true);
      },
      { once: true },
    );
    i18n.removeResourceBundle("id-ID", "agents");
    expect(
      i18n.t(
        ($) => {
          return $.actions.save;
        },
        { ns: "agents" },
      ),
    ).toBe("Save");
    await context.store.set(setLocale$, DEFAULT_LOCALE, context.signal);
  });

  it("loads German before bundle render and restores it from workspace cache", async () => {
    context.mocks.browser.language("en-US");
    context.store.set(activeOrgIdStorage.set$, TEST_ORG_ID);
    context.store.set(testLocaleStorage.set$, "de-DE");

    executeLocaleEntrypoint();

    expect(document.documentElement.lang).toBe("de-DE");
    expect(window.__vm0PreBundleCopy).toMatchObject({
      loading: {
        ariaLabel: "Ihr Arbeitsbereich wird geladen",
        messages: expect.arrayContaining(["Neuronen werden aufgewärmt..."]),
      },
      metadata: {
        title: "Zero — Ihr KI-Kollege von VM0",
      },
    });

    await setupPage({
      context,
      path: "/error",
      withoutRender: true,
    });

    expect(context.store.get(locale$)).toBe("de-DE");
    expect(i18n.language).toBe("de-DE");
    expect(i18n.hasResourceBundle("de-DE", "common")).toBeTruthy();
    expect(i18n.hasResourceBundle("de-DE", "agents")).toBeTruthy();
    expect(document.documentElement.lang).toBe("de-DE");
    expect(
      i18n.t(
        ($) => {
          return $.activity.events.searches;
        },
        { count: 2, formattedCount: "2" },
      ),
    ).toBe("2 Suchen");
    expect(
      i18n.t(
        ($) => {
          return $.settings.models.reset.remaining;
        },
        { count: 2, value: "2" },
      ),
    ).toBe("2 Resets übrig");
    expect(
      i18n.t(($) => {
        return $.billing.usage.allowance.title;
      }),
    ).toBe("Nutzungskontingent");
    expect(
      i18n.t(($) => {
        return $.workflows.automations.github.actors;
      }),
    ).toBe("Akteure");
    expect(
      i18n.t(($) => {
        return $.workflows.automations.github.addWorkflowDescription;
      }),
    ).toContain("GitHub Actions");
    expect(
      i18n.t(($) => {
        return $.settings.models.stale.claudeFailed;
      }),
    ).toContain("Claude Code");
    expect(
      i18n.t(($) => {
        return $.workflows.automations.webhook.signedCurl;
      }),
    ).toBe("Signierter curl-Befehl");
    expect(
      i18n.t(($) => {
        return $.onboarding.workflows["watch-brand-mentions"].steps.three
          .description;
      }),
    ).toBe("Zero speichert den Plan und veröffentlicht nie ohne Genehmigung.");
    expect(
      i18n.t(($) => {
        return $.onboarding.workflows["auto-merge-github-prs"].steps.two.title;
      }),
    ).toBe("Zero überprüft die Änderungen.");

    await context.store.set(setLocale$, "hi-IN", context.signal);
    expect(
      i18n.t(($) => {
        return $.onboarding.workflows["summarize-zendesk-tickets-daily"].title;
      }),
    ).toBe("FAQ को डिजिटल-ह्यूमन सपोर्ट वीडियो में बदलें");
    expect(
      i18n.t(($) => {
        return $.onboarding.workflows["auto-merge-github-prs"].title;
      }),
    ).toBe("GitHub PR अपने-आप merge करें");
    expect(
      i18n.t(($) => {
        return $.onboarding.workflows["post-github-updates-slack"].title;
      }),
    ).toBe("Google Cloud IAM और services का audit करें");
    expect(
      i18n.t(($) => {
        return $.onboarding.workflows["build-weekly-deck-gamma"].title;
      }),
    ).toBe("QuickBooks finance dashboard बनाएँ");

    const hindiWorkflowCopy = JSON.stringify(hiINCommon.onboarding.workflows);
    expect(hindiWorkflowCopy).not.toMatch(
      /suggested_questions|hå|Traffik|गोल्डेन ग्लाउच|अटो-लीन्डर/iu,
    );

    await context.store.set(setLocale$, DEFAULT_LOCALE, context.signal);
  });

  it("uses cached Spanish across pre-bundle UI and i18next", async () => {
    context.store.set(activeOrgIdStorage.set$, TEST_ORG_ID);
    context.store.set(testLocaleStorage.set$, "es-ES");
    executeBrowserCompatibilityEntrypoint(
      "Mozilla/5.0 Chrome/100.0.0.0 Safari/537.36",
    );
    executeLocaleEntrypoint();

    const metadata = document.createElement("meta");
    metadata.name = "description";
    document.head.append(metadata);
    context.signal.addEventListener(
      "abort",
      () => {
        metadata.remove();
      },
      { once: true },
    );
    executeMetadataEntrypoint();

    await setupPage({
      context,
      path: "/error",
      withoutRender: true,
    });

    expect(context.store.get(locale$)).toBe("es-ES");
    expect(i18n.language).toBe("es-ES");
    expect(window.__vm0BrowserSupported).toBeFalsy();
    expect(window.__vm0BrowserUpgrade).toMatchObject({
      actionLabel: "Actualizar Chrome",
      actionUrl: "https://www.google.com/chrome/",
      title: "Actualiza Chrome para continuar",
    });
    expect(metadata).toHaveAttribute(
      "content",
      expect.stringContaining("Zero es tu compañero de IA de VM0"),
    );
    expect(window.__vm0PreBundleCopy).toMatchObject({
      browserUpgrade: {
        safari: {
          actionLabel: "Actualizar Safari",
          title: "Actualiza Safari para continuar",
        },
      },
      loading: {
        ariaLabel: "Cargando tu espacio de trabajo",
        messages: expect.arrayContaining(["Activando las neuronas..."]),
      },
      metadata: {
        title: "Zero — Tu compañero de IA de VM0",
      },
    });

    await context.store.set(setLocale$, DEFAULT_LOCALE, context.signal);
  });

  it("loads Italian before the bundle from the browser language", async () => {
    context.mocks.browser.language("it-IT");
    executeLocaleEntrypoint();

    expect(document.documentElement.lang).toBe("it-IT");
    expect(window.__vm0PreBundleCopy).toMatchObject({
      loading: {
        ariaLabel: "Caricamento dell'area di lavoro",
        messages: expect.arrayContaining(["Riscaldamento dei neuroni..."]),
      },
      metadata: {
        title: "Zero — Il tuo collega AI di VM0",
      },
    });

    await setupPage({
      context,
      path: "/error",
      withoutRender: true,
    });

    expect(context.store.get(locale$)).toBe("it-IT");
    expect(i18n.language).toBe("it-IT");
    expect(document.documentElement.lang).toBe("it-IT");
    expect(i18n.hasResourceBundle("it-IT", "common")).toBeTruthy();
    expect(i18n.hasResourceBundle("it-IT", "agents")).toBeTruthy();

    const italianCommon = structuredClone(itITCommon);
    context.signal.addEventListener(
      "abort",
      () => {
        i18n.addResourceBundle("it-IT", "common", italianCommon, true, true);
      },
      { once: true },
    );
    i18n.removeResourceBundle("it-IT", "common");
    expect(
      i18n.t(($) => {
        return $.settings.shared.save;
      }),
    ).toBe("Save");

    await context.store.set(setLocale$, DEFAULT_LOCALE, context.signal);
  });

  it("restores cached French before the application bundle renders", async () => {
    context.mocks.browser.language("en-US");
    context.store.set(activeOrgIdStorage.set$, TEST_ORG_ID);
    context.store.set(testLocaleStorage.set$, "fr-FR");

    executeLocaleEntrypoint();

    expect(document.documentElement.lang).toBe("fr-FR");
    expect(window.__vm0PreBundleCopy).toMatchObject({
      browserUpgrade: {
        safari: {
          actionLabel: "Mettre à jour Safari",
        },
      },
      loading: {
        ariaLabel: "Chargement de votre espace de travail",
      },
    });

    await setupPage({
      context,
      path: "/error",
      withoutRender: true,
    });

    expect(context.store.get(locale$)).toBe("fr-FR");
    expect(i18n.language).toBe("fr-FR");
    expect(document.documentElement.lang).toBe("fr-FR");

    await context.store.set(setLocale$, DEFAULT_LOCALE, context.signal);
  });

  it("uses cached Hindi across pre-bundle UI and i18next", async () => {
    context.mocks.browser.language("en-US");
    context.store.set(activeOrgIdStorage.set$, TEST_ORG_ID);
    context.store.set(testLocaleStorage.set$, "hi-IN");
    executeBrowserCompatibilityEntrypoint(
      "Mozilla/5.0 Chrome/100.0.0.0 Safari/537.36",
    );
    executeLocaleEntrypoint();

    const metadata = document.createElement("meta");
    metadata.name = "description";
    document.head.append(metadata);
    context.signal.addEventListener(
      "abort",
      () => {
        metadata.remove();
      },
      { once: true },
    );
    executeMetadataEntrypoint();

    await setupPage({
      context,
      path: "/error",
      withoutRender: true,
    });

    expect(context.store.get(locale$)).toBe("hi-IN");
    expect(i18n.language).toBe("hi-IN");
    expect(window.__vm0BrowserSupported).toBeFalsy();
    expect(window.__vm0BrowserUpgrade).toMatchObject({
      actionLabel: "Chrome को अपडेट करें",
      actionUrl: "https://www.google.com/chrome/",
      title: "जारी रखने के लिए Chrome को अपडेट करें",
    });
    expect(metadata).toHaveAttribute(
      "content",
      expect.stringContaining("Zero, VM0 से आपका AI सहकर्मी है"),
    );
    expect(window.__vm0PreBundleCopy).toMatchObject({
      browserUpgrade: {
        safari: {
          actionLabel: "Safari को अपडेट करें",
          title: "जारी रखने के लिए Safari को अपडेट करें",
        },
      },
      loading: {
        ariaLabel: "आपका वर्कस्पेस लोड हो रहा है",
      },
    });

    context.signal.addEventListener(
      "abort",
      () => {
        i18n.addResourceBundle("hi-IN", "agents", hiINAgents, true, true);
      },
      { once: true },
    );
    i18n.removeResourceBundle("hi-IN", "agents");
    expect(
      i18n.t(
        ($) => {
          return $.actions.save;
        },
        { ns: "agents" },
      ),
    ).toBe("Save");
    await context.store.set(setLocale$, DEFAULT_LOCALE, context.signal);
  });

  it("falls back to English for unsupported browser and cached locales", () => {
    context.mocks.browser.language("nl-NL");
    context.store.set(activeOrgIdStorage.set$, TEST_ORG_ID);
    context.store.set(testLocaleStorage.set$, "nl-NL");

    executeLocaleEntrypoint();

    expect(document.documentElement.lang).toBe(DEFAULT_LOCALE);
    expect(context.store.get(testLocaleStorage.get$)).toBe(DEFAULT_LOCALE);
  });
});
