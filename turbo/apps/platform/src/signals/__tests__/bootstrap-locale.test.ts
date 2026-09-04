import { HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import indexHtml from "../../../index.html?raw";
import { setupPage } from "../../__tests__/page-helper.ts";
import { formatAppNumber } from "../../i18n/format.ts";
import frFRClerk from "../../i18n/clerk-localizations/fr-FR.json";
import frFRClerkUrl from "../../i18n/clerk-localizations/fr-FR.json?url";
import itITClerkUrl from "../../i18n/clerk-localizations/it-IT.json?url";
import ptBRClerkUrl from "../../i18n/clerk-localizations/pt-BR.json?url";
import {
  clerkLocalizationForLocale,
  clerkLocalizations$,
} from "../../i18n/clerk-localization.ts";
import { OKOU_LOCALE_COOKIE_NAME } from "../../i18n/locale-fallback.ts";
import frFRCommonUrl from "../../i18n/locales/fr-FR/common.json?url";
import {
  CHAT_ATTACHMENT_HEADINGS,
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from "../../i18n/resources.ts";
import { changeI18nLanguage, i18n, initializeI18n } from "../../i18n/index.ts";
import { locale$, setLocale$ } from "../locale.ts";
import { resetSignal } from "../utils.ts";
import { testContext } from "./test-helpers.ts";

const context = testContext();

function loadedClerkLocalization(locale: SupportedLocale) {
  return clerkLocalizationForLocale(
    context.store.get(clerkLocalizations$),
    locale,
  );
}

describe("bootstrap locale", () => {
  it("loads English resources for the default locale", async () => {
    context.mocks.browser.language(DEFAULT_LOCALE);

    await setupPage({ context, path: "/error", withoutRender: true });

    expect(context.store.get(locale$)).toBe(DEFAULT_LOCALE);
    expect(i18n.language).toBe(DEFAULT_LOCALE);
    expect(i18n.hasResourceBundle(DEFAULT_LOCALE, "common")).toBeTruthy();
    expect(i18n.hasResourceBundle(DEFAULT_LOCALE, "agents")).toBeTruthy();
  });

  it("loads a selected Clerk localization only after runtime preference sync", async () => {
    const requests: string[] = [];
    context.mocks.http.get(
      /\/clerk-localizations\/[^/]+\.json$/,
      ({ request }) => {
        requests.push(new URL(request.url).pathname);
        return HttpResponse.json(frFRClerk);
      },
    );
    context.mocks.browser.language("fr-FR");

    await setupPage({ context, path: "/error", withoutRender: true });

    expect(requests).toHaveLength(0);
    expect(context.store.get(locale$)).toBe(DEFAULT_LOCALE);

    await context.store.set(setLocale$, "fr-FR", context.signal);

    expect(requests).toStrictEqual([
      new URL(frFRClerkUrl, location.href).pathname,
    ]);
    expect(loadedClerkLocalization("fr-FR").signIn?.start?.actionLink).toBe(
      "S'inscrire",
    );

    await context.store.set(setLocale$, DEFAULT_LOCALE, context.signal);
    await context.store.set(setLocale$, "fr-FR", context.signal);

    expect(requests).toHaveLength(1);
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

  it("loads and switches resources for every supported locale", async () => {
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

    for (const locale of SUPPORTED_LOCALES) {
      await context.store.set(setLocale$, locale, context.signal);
      expect(context.store.get(locale$)).toBe(locale);
      expect(i18n.language).toBe(locale);
      expect(document.documentElement.lang).toBe(locale);
    }
  });

  it.each([
    ["https://app.vm0.ai/", "Zero", "Okou"],
    ["https://app.okou.ai/", "Okou", "Zero"],
  ] as const)(
    "projects assistant copy for every locale on %s",
    async (url, assistantName, otherAssistantName) => {
      context.mocks.browser.url(url);

      for (const locale of SUPPORTED_LOCALES) {
        await initializeI18n(locale);
        const messages = [
          i18n.t(($) => {
            return $.chat.banking.popupBlocked;
          }),
          i18n.t(($) => {
            return $.chat.introVideo.review.help;
          }),
        ];
        for (const message of messages) {
          expect(message).toContain(assistantName);
          expect(message).not.toContain(otherAssistantName);
        }
      }
    },
  );

  it("keeps runtime locale state unchanged when resources fail", async () => {
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

  it("loads French formatting, plurals, and English fallback at runtime", async () => {
    await setupPage({ context, path: "/error", withoutRender: true });
    await context.store.set(setLocale$, "fr-FR", context.signal);

    expect(context.store.get(locale$)).toBe("fr-FR");
    expect(i18n.language).toBe("fr-FR");
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

    const fallbackI18n = i18n.cloneInstance({ forkResourceStore: true });
    fallbackI18n.removeResourceBundle("fr-FR", "common");
    await fallbackI18n.changeLanguage("fr-FR");
    expect(
      fallbackI18n.t(($) => {
        return $.settings.preferences.language.title;
      }),
    ).toBe("Language");
  });

  it("uses the shared Okou locale cookie ahead of browser languages", async () => {
    context.mocks.browser.url("https://app.okou.ai/error");
    context.mocks.browser.cookie(`${OKOU_LOCALE_COOKIE_NAME}=v1.fr-FR`);
    context.mocks.browser.languages(["ja-JP"]);

    await setupPage({ context, path: "/error", withoutRender: true });

    expect(context.store.get(locale$)).toBe("fr-FR");
  });

  it("uses the first supported browser language family on Okou", async () => {
    context.mocks.browser.url("https://app.okou.ai/error");
    context.mocks.browser.cookie(`${OKOU_LOCALE_COOKIE_NAME}=v1.unsupported`);
    context.mocks.browser.languages(["zh-CN", "de-AT", "ja-JP"]);

    await setupPage({ context, path: "/error", withoutRender: true });

    expect(context.store.get(locale$)).toBe("de-DE");
  });

  it("falls back to English when initial locale resources fail", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    context.mocks.browser.url("https://app.okou.ai/error");
    context.mocks.browser.languages(["fr-FR"]);
    context.mocks.http.get(frFRCommonUrl, () => {
      return new HttpResponse(null, { status: 503 });
    });

    await setupPage({ context, path: "/error", withoutRender: true });

    expect(context.store.get(locale$)).toBe(DEFAULT_LOCALE);
    expect(i18n.language).toBe(DEFAULT_LOCALE);
    expect(document.documentElement.lang).toBe(DEFAULT_LOCALE);
    expect(consoleError).toHaveBeenCalledWith(
      "[E][Locale]",
      `Failed to initialize fr-FR; falling back to ${DEFAULT_LOCALE}`,
      expect.any(Error),
    );
  });

  it("uses English when no Okou locale hint is supported", async () => {
    context.mocks.browser.url("https://app.okou.ai/error");
    context.mocks.browser.cookie(`${OKOU_LOCALE_COOKIE_NAME}=v0.fr-FR`);
    context.mocks.browser.languages(["zh-CN", "ar-SA"]);

    await setupPage({ context, path: "/error", withoutRender: true });

    expect(context.store.get(locale$)).toBe(DEFAULT_LOCALE);
  });

  it("keeps cookie and browser locale hints isolated from VM0", async () => {
    context.mocks.browser.url("https://app.vm0.ai/error");
    context.mocks.browser.cookie(`${OKOU_LOCALE_COOKIE_NAME}=v1.fr-FR`);
    context.mocks.browser.languages(["ja-JP"]);

    await setupPage({ context, path: "/error", withoutRender: true });

    expect(context.store.get(locale$)).toBe(DEFAULT_LOCALE);
  });

  it("keeps metadata English and the inline skeleton free of copy", () => {
    const parsedDocument = new DOMParser().parseFromString(
      indexHtml,
      "text/html",
    );
    const description = parsedDocument.querySelector(
      'meta[name="description"]',
    );
    const skeleton = parsedDocument.getElementById("app-bootstrap-skeleton");

    expect(description).toHaveAttribute(
      "content",
      expect.stringContaining("your trustworthy AI teammate"),
    );
    expect(skeleton).toHaveTextContent("");
  });
});
