import { afterEach, describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";

import indexHtml from "../../../index.html?raw";
import { setupPage } from "../../__tests__/page-helper.ts";
import { DEFAULT_LOCALE } from "../../i18n/resources.ts";
import { i18n } from "../../i18n/index.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import { locale$, setLocale$ } from "../locale.ts";
import { testContext } from "./test-helpers.ts";

const ACTIVE_ORG_STORAGE_KEY = "clerk-active-org-id";
const TEST_ORG_ID = "org_inline_locale";
const TEST_LOCALE_STORAGE_KEY = `vm0:locale:${TEST_ORG_ID}`;
const testLocaleStorage = localStorageSignals(TEST_LOCALE_STORAGE_KEY);

type LocaleEntrypointScript = (
  documentObject: Document,
  sessionStorageObject: Storage,
  navigatorObject: Navigator,
) => void;

function getLocaleEntrypointSource(): string {
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
    return script.includes('"vm0:locale:"');
  });

  if (source === undefined) {
    throw new Error("Unable to locate the locale resolver in index.html");
  }
  return source;
}

function executeLocaleEntrypoint(): void {
  const executeEntrypointScript = new Function(
    "document",
    "sessionStorage",
    "navigator",
    `${getLocaleEntrypointSource()}\n//# sourceURL=platform-locale-entrypoint-test.js`,
  ) as LocaleEntrypointScript;

  executeEntrypointScript(document, sessionStorage, navigator);
}

const context = testContext();

afterEach(() => {
  sessionStorage.removeItem(ACTIVE_ORG_STORAGE_KEY);
  testLocaleStorage.updateRaw(() => {
    return null;
  });
});

describe("bootstrap locale", () => {
  it("ignores the browser language and supports changing to a bundled locale", async () => {
    context.mocks.browser.language("pt-BR");
    sessionStorage.setItem(ACTIVE_ORG_STORAGE_KEY, TEST_ORG_ID);
    context.store.set(testLocaleStorage.clear$);
    executeLocaleEntrypoint();

    expect(document.documentElement.lang).toBe(DEFAULT_LOCALE);
    expect(context.store.get(testLocaleStorage.get$)).toBe(DEFAULT_LOCALE);

    await setupPage({
      context,
      path: "/error",
      featureSwitches: { [FeatureSwitchKey.LanguagePreference]: false },
      withoutRender: true,
    });

    expect(context.store.get(locale$)).toBe(DEFAULT_LOCALE);
    expect(i18n.language).toBe(DEFAULT_LOCALE);
    expect(document.documentElement.lang).toBe(DEFAULT_LOCALE);
    expect(i18n.hasResourceBundle("en-US", "common")).toBeTruthy();
    expect(i18n.hasResourceBundle("pt-BR", "common")).toBeTruthy();

    await context.store.set(setLocale$, "pt-BR", context.signal);

    expect(context.store.get(locale$)).toBe("pt-BR");
    expect(i18n.language).toBe("pt-BR");
    expect(document.documentElement.lang).toBe("pt-BR");

    await context.store.set(setLocale$, DEFAULT_LOCALE, context.signal);
  });

  it("initializes i18next from the cached locale selected by the inline script", async () => {
    sessionStorage.setItem(ACTIVE_ORG_STORAGE_KEY, TEST_ORG_ID);
    context.store.set(testLocaleStorage.set$, "pt-BR");
    executeLocaleEntrypoint();

    await setupPage({
      context,
      path: "/error",
      featureSwitches: { [FeatureSwitchKey.LanguagePreference]: false },
      withoutRender: true,
    });

    expect(context.store.get(locale$)).toBe("pt-BR");
    expect(i18n.language).toBe("pt-BR");

    await context.store.set(setLocale$, DEFAULT_LOCALE, context.signal);
  });
});
