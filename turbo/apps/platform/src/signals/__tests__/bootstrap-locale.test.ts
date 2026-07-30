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
    context.mocks.browser.language("pt-BR");
    executeLocaleEntrypoint();

    expect(document.documentElement.lang).toBe("pt-BR");
    expect(context.store.get(testLocaleStorage.get$)).toBeNull();
    expect(window.__vm0PreBundleCopy).toMatchObject({
      loading: {
        ariaLabel: "Carregando seu espaço de trabalho",
        messages: expect.arrayContaining(["Aquecendo os neurônios..."]),
      },
      metadata: {
        title: "Zero — Seu colega de IA da vm0",
      },
    });

    await setupPage({
      context,
      path: "/error",
      featureSwitches: { [FeatureSwitchKey.LanguagePreference]: false },
      withoutRender: true,
    });

    expect(context.store.get(locale$)).toBe("pt-BR");
    expect(i18n.language).toBe("pt-BR");
    expect(document.documentElement.lang).toBe("pt-BR");
    expect(i18n.hasResourceBundle("en-US", "common")).toBeTruthy();
    expect(i18n.hasResourceBundle("pt-BR", "common")).toBeTruthy();
    expect(i18n.hasResourceBundle("ja-JP", "common")).toBeTruthy();
    expect(i18n.hasResourceBundle("ko-KR", "common")).toBeTruthy();

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

  it("uses the cached locale across pre-bundle UI and i18next", async () => {
    context.mocks.browser.language("en-US");
    sessionStorage.setItem(ACTIVE_ORG_STORAGE_KEY, TEST_ORG_ID);
    context.store.set(testLocaleStorage.set$, "ja-JP");
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

    expect(context.store.get(locale$)).toBe("ja-JP");
    expect(i18n.language).toBe("ja-JP");
    expect(window.__vm0BrowserSupported).toBeFalsy();
    expect(window.__vm0BrowserUpgrade).toMatchObject({
      actionLabel: "Chromeを更新",
      actionUrl: "https://www.google.com/chrome/",
      title: "続行するにはChromeを更新してください",
    });
    expect(metadata).toHaveAttribute(
      "content",
      expect.stringContaining("Zeroはvm0のAIコワーカーです"),
    );
    expect(window.__vm0PreBundleCopy).toMatchObject({
      browserUpgrade: {
        safari: {
          actionLabel: "Safariを更新",
          title: "続行するにはSafariを更新してください",
        },
      },
      loading: {
        ariaLabel: "ワークスペースを読み込み中",
        messages: expect.arrayContaining([
          "ニューラルネットワークを準備しています...",
        ]),
      },
      metadata: {
        title: "Zero — vm0のAIコワーカー",
      },
    });

    const japaneseAgentResources = resources["ja-JP"].agents;
    i18n.removeResourceBundle("ja-JP", "agents");
    expect(
      i18n.t(
        ($) => {
          return $.actions.save;
        },
        { ns: "agents" },
      ),
    ).toBe("Save");
    i18n.addResourceBundle(
      "ja-JP",
      "agents",
      japaneseAgentResources,
      true,
      true,
    );

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
