import { describe, expect, it } from "vitest";

import type { SupportedLocale } from "../resources.ts";
import {
  localePathPrefix,
  localePrefixedPathname,
  preserveLocalePathPrefix,
  replaceLocalePathPrefix,
  resolveLocaleRoute,
} from "../locale-routing.ts";

const LOCALE_CASES = [
  ["en", "en-US"],
  ["pt-BR", "pt-BR"],
  ["ja", "ja-JP"],
  ["ko", "ko-KR"],
  ["id", "id-ID"],
  ["de", "de-DE"],
  ["es", "es-ES"],
  ["it", "it-IT"],
  ["fr", "fr-FR"],
  ["hi", "hi-IN"],
] as const satisfies readonly (readonly [string, SupportedLocale])[];

describe("locale routing", () => {
  it.each(LOCALE_CASES)(
    "maps /%s to %s and the logical app root",
    (prefix, locale) => {
      expect(localePathPrefix(locale)).toBe(prefix);
      expect(resolveLocaleRoute(`/${prefix}`, "app.okou.ai")).toStrictEqual({
        locale,
        pathname: "/",
      });
      expect(resolveLocaleRoute(`/${prefix}/`, "app.okou.ai")).toStrictEqual({
        locale,
        pathname: "/",
      });
      expect(
        resolveLocaleRoute(`/${prefix}/agents/example`, "app.okou.ai"),
      ).toStrictEqual({ locale, pathname: "/agents/example" });
    },
  );

  it("recognizes Okou preview hosts", () => {
    expect(resolveLocaleRoute("/fr/sign-in", "preview.omby.ai")).toStrictEqual({
      locale: "fr-FR",
      pathname: "/sign-in",
    });
    expect(
      resolveLocaleRoute(
        "/ja/sign-up",
        "pr-123-app-okou-app-preview.vm0.workers.dev",
      ),
    ).toStrictEqual({ locale: "ja-JP", pathname: "/sign-up" });
  });

  it.each(["/zh", "/zh/agents", "/EN", "/pt-br"])(
    "leaves unsupported prefix %s for the existing 404 policy",
    (pathname) => {
      expect(resolveLocaleRoute(pathname, "app.okou.ai")).toStrictEqual({
        locale: null,
        pathname,
      });
    },
  );

  it("does not interpret locale prefixes on VM0", () => {
    expect(resolveLocaleRoute("/en/agents", "app.vm0.ai")).toStrictEqual({
      locale: null,
      pathname: "/en/agents",
    });
    expect(preserveLocalePathPrefix("/agents", "app.vm0.ai", "fr-FR")).toBe(
      "/agents",
    );
  });

  it("adds, preserves, and replaces canonical Okou prefixes", () => {
    expect(localePrefixedPathname("/", "en-US")).toBe("/en");
    expect(localePrefixedPathname("/agents/example", "pt-BR")).toBe(
      "/pt-BR/agents/example",
    );
    expect(preserveLocalePathPrefix("/sign-in", "app.okou.ai", "ja-JP")).toBe(
      "/ja/sign-in",
    );
    expect(
      replaceLocalePathPrefix("/fr/agents/example", "app.okou.ai", "ko-KR"),
    ).toBe("/ko/agents/example");
    expect(
      replaceLocalePathPrefix("/agents/example", "app.okou.ai", "de-DE"),
    ).toBe("/de/agents/example");
  });
});
