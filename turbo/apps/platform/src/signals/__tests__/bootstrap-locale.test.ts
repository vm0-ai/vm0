import { afterEach, describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";

import indexHtml from "../../../index.html?raw";
import { setupPage } from "../../__tests__/page-helper.ts";
import { DEFAULT_LOCALE, resources } from "../../i18n/resources.ts";
import { i18n } from "../../i18n/index.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import { locale$, setLocale$ } from "../locale.ts";
import { testContext } from "./test-helpers.ts";

const ACTIVE_ORG_STORAGE_KEY = "clerk-active-org-id";
const TEST_ORG_ID = "org_inline_locale";
const TEST_LOCALE_STORAGE_KEY = `vm0:locale:${TEST_ORG_ID}`;
const testLocaleStorage = localStorageSignals(TEST_LOCALE_STORAGE_KEY);

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
  const executeEntrypointScript = new Function(
    "window",
    "document",
    `${getInlineScriptSource("var metadata = [", "metadata localizer")}\n//# sourceURL=platform-metadata-entrypoint-test.js`,
  ) as (windowObject: Window, documentObject: Document) => void;

  executeEntrypointScript(window, document);
}

const context = testContext();

afterEach(() => {
  sessionStorage.removeItem(ACTIVE_ORG_STORAGE_KEY);
  Reflect.deleteProperty(window, "__vm0BrowserSupported");
  Reflect.deleteProperty(window, "__vm0BrowserUpgrade");
  Reflect.deleteProperty(window, "__vm0PreBundleCopy");
  delete document.documentElement.dataset.browserUpgradeTarget;
  delete document.documentElement.dataset.browserSupported;
  testLocaleStorage.updateRaw(() => {
    return null;
  });
});

describe("bootstrap locale", () => {
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
        title: "Zero — vm0のAIコワーカー",
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
        title: "Zero — Tu compañero de IA de vm0",
      },
    });
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
        title: "Zero — vm0의 AI 팀원",
      },
    });

    await setupPage({
      context,
      path: "/error",
      featureSwitches: { [FeatureSwitchKey.LanguagePreference]: false },
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
        title: "Zero — Rekan kerja AI Anda dari vm0",
      },
    });

    await setupPage({
      context,
      path: "/error",
      featureSwitches: { [FeatureSwitchKey.LanguagePreference]: false },
      withoutRender: true,
    });

    expect(context.store.get(locale$)).toBe("id-ID");
    expect(i18n.language).toBe("id-ID");
    expect(document.documentElement.lang).toBe("id-ID");
    expect(i18n.hasResourceBundle("en-US", "common")).toBeTruthy();
    expect(i18n.hasResourceBundle("pt-BR", "common")).toBeTruthy();
    expect(i18n.hasResourceBundle("ja-JP", "common")).toBeTruthy();
    expect(i18n.hasResourceBundle("ko-KR", "common")).toBeTruthy();
    expect(i18n.hasResourceBundle("id-ID", "common")).toBeTruthy();
    expect(i18n.hasResourceBundle("es-ES", "common")).toBeTruthy();
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

    const indonesianAgents = resources["id-ID"].agents;
    i18n.removeResourceBundle("id-ID", "agents");
    try {
      expect(
        i18n.t(
          ($) => {
            return $.fallbackName;
          },
          { ns: "agents" },
        ),
      ).toBe("Agent");
    } finally {
      i18n.addResourceBundle("id-ID", "agents", indonesianAgents, true, true);
    }

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
      expect.stringContaining("Zero is your AI coworker from vm0"),
    );
    expect(upgradeTitle).toHaveTextContent("Update Chrome to continue");
    expect(upgradeDescription).toHaveTextContent(
      "Zero does not support your current browser version.",
    );
    expect(upgradeAction).toHaveTextContent("Update Chrome");
  });

  it("detects German from the browser before a workspace is active", () => {
    context.mocks.browser.language("de");

    try {
      executeLocaleEntrypoint();

      expect(document.documentElement.lang).toBe("de-DE");
      expect(window.__vm0PreBundleCopy).toMatchObject({
        loading: {
          ariaLabel: "Ihr Arbeitsbereich wird geladen",
        },
        metadata: {
          title: "Zero — Ihr KI-Kollege von vm0",
        },
      });
    } finally {
      document.documentElement.lang = DEFAULT_LOCALE;
    }
  });

  it("uses the cached locale across pre-bundle UI and i18next", async () => {
    context.mocks.browser.language("en-US");
    sessionStorage.setItem(ACTIVE_ORG_STORAGE_KEY, TEST_ORG_ID);
    context.store.set(testLocaleStorage.set$, "id-ID");
    executeLocaleEntrypoint();
    executeBrowserCompatibilityEntrypoint(
      "Mozilla/5.0 Chrome/100.0.0.0 Safari/537.36",
    );

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
      featureSwitches: { [FeatureSwitchKey.LanguagePreference]: false },
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
      expect.stringContaining("Zero adalah rekan kerja AI Anda dari vm0"),
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
        title: "Zero — Rekan kerja AI Anda dari vm0",
      },
    });

    const indonesianAgentResources = resources["id-ID"].agents;
    i18n.removeResourceBundle("id-ID", "agents");
    expect(
      i18n.t(
        ($) => {
          return $.actions.save;
        },
        { ns: "agents" },
      ),
    ).toBe("Save");
    i18n.addResourceBundle(
      "id-ID",
      "agents",
      indonesianAgentResources,
      true,
      true,
    );

    await context.store.set(setLocale$, DEFAULT_LOCALE, context.signal);
  });

  it("loads German before bundle render and restores it from workspace cache", async () => {
    context.mocks.browser.language("en-US");
    sessionStorage.setItem(ACTIVE_ORG_STORAGE_KEY, TEST_ORG_ID);
    context.store.set(testLocaleStorage.set$, "de-DE");

    executeLocaleEntrypoint();

    expect(document.documentElement.lang).toBe("de-DE");
    expect(window.__vm0PreBundleCopy).toMatchObject({
      loading: {
        ariaLabel: "Ihr Arbeitsbereich wird geladen",
        messages: expect.arrayContaining(["Neuronen werden aufgewärmt..."]),
      },
      metadata: {
        title: "Zero — Ihr KI-Kollege von vm0",
      },
    });

    await setupPage({
      context,
      path: "/error",
      featureSwitches: { [FeatureSwitchKey.LanguagePreference]: false },
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
          return $.insights.units.run;
        },
        { count: 2, value: "2" },
      ),
    ).toBe("2 Ausführungen");
    expect(
      i18n.t(
        ($) => {
          return $.insights.cards.agentsRan;
        },
        {
          agents: "2 Agenten",
          count: 2,
          runs: "12 Ausführungen",
        },
      ),
    ).toBe("2 Agenten haben 12 Ausführungen abgeschlossen");
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
      i18n.t(
        ($) => {
          return $.insights.summary.highTraffic;
        },
        {
          callCount: "101",
          count: 1,
          services: "1 Dienst",
        },
      ),
    ).toBe(
      "101 Serviceaufrufe über 1 Dienst. Tag mit hohem Verkehrsaufkommen.",
    );
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
    ).toBe("Zero veröffentlicht jede Erwähnung mit Link und Kontext.");
    expect(
      i18n.t(($) => {
        return $.onboarding.workflows["auto-merge-github-prs"].steps.two.title;
      }),
    ).toBe("Zero prüft und wartet auf CI");

    await context.store.set(setLocale$, DEFAULT_LOCALE, context.signal);
  });

  it("uses cached Spanish across pre-bundle UI and i18next", async () => {
    sessionStorage.setItem(ACTIVE_ORG_STORAGE_KEY, TEST_ORG_ID);
    context.store.set(testLocaleStorage.set$, "es-ES");
    executeLocaleEntrypoint();
    executeBrowserCompatibilityEntrypoint(
      "Mozilla/5.0 Chrome/100.0.0.0 Safari/537.36",
    );

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
      featureSwitches: { [FeatureSwitchKey.LanguagePreference]: false },
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
      expect.stringContaining("Zero es tu compañero de IA de vm0"),
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
        title: "Zero — Tu compañero de IA de vm0",
      },
    });

    await context.store.set(setLocale$, DEFAULT_LOCALE, context.signal);
  });

  it("falls back to English for unsupported browser and legacy cached locales", () => {
    context.mocks.browser.language("fr-FR");
    sessionStorage.setItem(ACTIVE_ORG_STORAGE_KEY, TEST_ORG_ID);
    context.store.set(testLocaleStorage.set$, "zh-CN");

    executeLocaleEntrypoint();

    expect(document.documentElement.lang).toBe(DEFAULT_LOCALE);
    expect(context.store.get(testLocaleStorage.get$)).toBe(DEFAULT_LOCALE);
  });
});
