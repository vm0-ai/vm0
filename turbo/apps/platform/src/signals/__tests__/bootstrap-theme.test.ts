import { describe, expect, it, vi } from "vitest";

import { setupBootstrap } from "../../__tests__/page-helper.ts";
import { OKOU_THEME_COOKIE_NAME } from "../../lib/okou-theme-cookie.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import { theme$, themePreference$, updateThemePreference$ } from "../theme.ts";
import { userPreferences$ } from "../okou-page/settings/user-preferences.ts";
import { testContext } from "./test-helpers.ts";

const context = testContext();
const themeStorage = localStorageSignals("theme");

function captureCookieWrites(): string[] {
  const writes: string[] = [];
  vi.spyOn(document, "cookie", "set").mockImplementation((value: string) => {
    writes.push(value);
  });
  return writes;
}

describe("okou theme preference bootstrap", () => {
  it("prefers the authenticated workspace selection over the shared cookie", async () => {
    context.mocks.browser.url("https://app.okou.ai/");
    context.mocks.browser.cookie(`${OKOU_THEME_COOKIE_NAME}=v1.dark`);
    context.mocks.data.userPreferences({ theme: "light" });
    context.store.set(themeStorage.set$, "dark");
    const cookieWrites = captureCookieWrites();

    await setupBootstrap({ context, path: "/error" });

    expect(context.store.get(themePreference$)).toBe("light");
    expect(context.store.get(theme$)).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(context.store.get(themeStorage.get$)).toBe("light");
    await expect(context.store.get(userPreferences$)).resolves.toMatchObject({
      theme: "light",
    });
    expect(cookieWrites).toContainEqual(
      expect.stringContaining(`${OKOU_THEME_COOKIE_NAME}=v1.light`),
    );
  });

  it("uses the shared cookie when the workspace has no theme selection", async () => {
    context.mocks.browser.url("https://app.okou.ai/");
    context.mocks.browser.cookie(`${OKOU_THEME_COOKIE_NAME}=v1.dark`);
    context.mocks.data.userPreferences({ theme: null });
    context.store.set(themeStorage.set$, "light");

    await setupBootstrap({ context, path: "/error" });

    expect(context.store.get(themePreference$)).toBe("dark");
    expect(context.store.get(theme$)).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(context.store.get(themeStorage.get$)).toBe("dark");
    await expect(context.store.get(userPreferences$)).resolves.toMatchObject({
      theme: "dark",
    });
  });

  it("uses the existing workspace preference when the shared value is invalid", async () => {
    context.mocks.browser.url("https://app.okou.ai/");
    context.mocks.browser.cookie(`${OKOU_THEME_COOKIE_NAME}=v0.light`);
    context.mocks.data.userPreferences({ theme: "dark" });
    context.store.set(themeStorage.set$, "light");

    await setupBootstrap({ context, path: "/error" });

    expect(context.store.get(themePreference$)).toBe("dark");
    expect(context.store.get(theme$)).toBe("dark");
    await expect(context.store.get(userPreferences$)).resolves.toMatchObject({
      theme: "dark",
    });
  });

  it("publishes the logged-out app fallback for navigation back to marketing", async () => {
    context.mocks.browser.url("https://app.okou.ai/sign-in");
    context.mocks.browser.cookie("");
    context.store.set(themeStorage.set$, "dark");
    const cookieWrites = captureCookieWrites();

    await setupBootstrap({ context, path: "/sign-in", user: null });

    expect(context.store.get(themePreference$)).toBe("dark");
    expect(cookieWrites).toContainEqual(
      expect.stringContaining(`${OKOU_THEME_COOKIE_NAME}=v1.dark`),
    );
  });

  it("updates local state, the shared cookie, and the workspace together", async () => {
    context.mocks.browser.url("https://app.okou.ai/");
    context.mocks.browser.cookie(`${OKOU_THEME_COOKIE_NAME}=v1.light`);
    context.mocks.browser.matchMedia(true);
    context.mocks.data.userPreferences({ theme: "light" });
    const cookieWrites = captureCookieWrites();
    await setupBootstrap({ context, path: "/error" });

    await context.store.set(updateThemePreference$, "system", context.signal);

    expect(context.store.get(themePreference$)).toBe("system");
    expect(context.store.get(theme$)).toBe("dark");
    expect(context.store.get(themeStorage.get$)).toBe("system");
    expect(cookieWrites.at(-1)).toContain(
      `${OKOU_THEME_COOKIE_NAME}=v1.system`,
    );
    await expect(context.store.get(userPreferences$)).resolves.toMatchObject({
      theme: "system",
    });
  });

  it("does not read or write the shared Okou preference on VM0", async () => {
    context.mocks.browser.url("https://app.vm0.ai/sign-in");
    context.mocks.browser.cookie(`${OKOU_THEME_COOKIE_NAME}=v1.dark`);
    context.store.set(themeStorage.set$, "light");
    const cookieWrites = captureCookieWrites();

    await setupBootstrap({ context, path: "/sign-in", user: null });

    expect(context.store.get(themePreference$)).toBe("light");
    expect(context.store.get(theme$)).toBe("light");
    expect(
      cookieWrites.some((cookie) => {
        return cookie.includes(OKOU_THEME_COOKIE_NAME);
      }),
    ).toBeFalsy();
  });
});
