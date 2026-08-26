import { screen } from "@testing-library/react";
import { HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { i18n } from "../../../i18n/index.ts";
import { localeStorageKey } from "../../../i18n/locale-storage.ts";
import frFRAgentsUrl from "../../../i18n/locales/fr-FR/agents.json?url";
import frFRCommonUrl from "../../../i18n/locales/fr-FR/common.json?url";
import { DEFAULT_LOCALE } from "../../../i18n/resources.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { localStorageSignals } from "../../../signals/external/local-storage.ts";
import { locale$ } from "../../../signals/locale.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const TEST_ORG_ID = "org_locale_bootstrap_fallback";
const cachedLocaleStorage = localStorageSignals(localeStorageKey(TEST_ORG_ID));
const context = testContext();

describe("locale bootstrap fallback", () => {
  it("opens the composer without retrying a failed cached locale", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    let agentsRequests = 0;
    let commonRequests = 0;

    context.mocks.data.userPreferences({ locale: "fr-FR" });
    context.store.set(cachedLocaleStorage.set$, "fr-FR");
    document.documentElement.lang = "fr-FR";
    context.mocks.http.get(frFRAgentsUrl, () => {
      agentsRequests += 1;
      return new HttpResponse(null, { status: 503 });
    });
    context.mocks.http.get(frFRCommonUrl, () => {
      commonRequests += 1;
      return new HttpResponse(null, { status: 503 });
    });
    mockChatLifecycle(context);

    detachedSetupPage({
      context,
      path: "/",
      org: {
        activeOrg: { id: TEST_ORG_ID, name: "Locale fallback org" },
        memberships: [{ id: TEST_ORG_ID }],
      },
    });

    await expect(
      screen.findByRole("textbox", { name: "Message" }),
    ).resolves.toBeInTheDocument();
    expect(screen.getByTestId("app-skeleton")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(context.store.get(locale$)).toBe(DEFAULT_LOCALE);
    expect(i18n.language).toBe(DEFAULT_LOCALE);
    expect(document.documentElement.lang).toBe(DEFAULT_LOCALE);
    expect(context.store.get(cachedLocaleStorage.get$)).toBe("fr-FR");
    expect(agentsRequests).toBe(1);
    expect(commonRequests).toBe(1);
    expect(consoleError).toHaveBeenCalledWith(
      "[E][I18n]",
      `Failed to load fr-FR locale resources; falling back to ${DEFAULT_LOCALE}`,
      expect.any(Error),
    );
  });
});
