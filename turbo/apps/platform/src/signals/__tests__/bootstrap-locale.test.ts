import { describe, expect, it } from "vitest";
import { setupPage } from "../../__tests__/page-helper.ts";
import { DEFAULT_LOCALE } from "../../i18n/resources.ts";
import { i18n } from "../../i18n/index.ts";
import { locale$, setLocale$ } from "../locale.ts";
import { testContext } from "./test-helpers.ts";

const context = testContext();

describe("bootstrap locale", () => {
  it("initializes English and supports changing to a bundled locale", async () => {
    await setupPage({
      context,
      path: "/error",
      withoutRender: true,
    });

    expect(context.store.get(locale$)).toBe(DEFAULT_LOCALE);
    expect(i18n.language).toBe(DEFAULT_LOCALE);
    expect(document.documentElement.lang).toBe(DEFAULT_LOCALE);
    expect(i18n.hasResourceBundle("en-US", "common")).toBeTruthy();
    expect(i18n.hasResourceBundle("zh-CN", "common")).toBeTruthy();

    await context.store.set(setLocale$, "zh-CN", context.signal);

    expect(context.store.get(locale$)).toBe("zh-CN");
    expect(i18n.language).toBe("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");

    await context.store.set(setLocale$, DEFAULT_LOCALE, context.signal);
  });
});
