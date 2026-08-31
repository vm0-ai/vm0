import { describe, expect, it } from "vitest";
import { testContext } from "../__tests__/test-helpers.ts";
import { resolveAuthV2PlatformContext } from "./platform-context.ts";

const context = testContext();

function setBrowserUrl(url: string): void {
  context.mocks.browser.url(url);
}

function absoluteNavigationUrl(href: string): URL {
  return new URL(href, location.origin);
}

function hashSearchParams(hash: string): URLSearchParams {
  const queryIndex = hash.indexOf("?");
  return new URLSearchParams(
    queryIndex === -1 ? "" : hash.slice(queryIndex + 1),
  );
}

describe("Auth v2 navigation", () => {
  it("preserves an allowed query redirect through mode and nested-step navigation", () => {
    const redirectUrl = "https://www.vm0.ai/connector/success?vm0_theme=light";
    setBrowserUrl(
      `https://app.vm0.ai/sign-in/factor-one?flow=identifier&redirect_url=${encodeURIComponent(redirectUrl)}&flow=second#/factor-one?attempt=1`,
    );

    const { navigation } = resolveAuthV2PlatformContext("sign-in");

    expect(navigation.completionRedirectUrl).toBe(redirectUrl);

    const nestedUrl = absoluteNavigationUrl(
      navigation.href("sign-in", "/factor-one"),
    );
    expect(nestedUrl.pathname).toBe("/sign-in/factor-one");
    expect(nestedUrl.searchParams.getAll("flow")).toStrictEqual([
      "identifier",
      "second",
    ]);
    expect(nestedUrl.searchParams.get("redirect_url")).toBe(redirectUrl);
    expect(nestedUrl.hash).toBe("#/factor-one?attempt=1");

    const signUpUrl = absoluteNavigationUrl(navigation.href("sign-up"));
    expect(signUpUrl.pathname).toBe("/sign-up");
    expect(signUpUrl.searchParams.get("redirect_url")).toBe(redirectUrl);
  });

  it("carries an allowed hash redirect into query and nested hash state", () => {
    const redirectUrl = "https://app.okou.ai/onboarding?source=auth-switch";
    setBrowserUrl(
      `https://app.vm0.ai/sign-in/factor-one?flow=identifier#/?step=code&redirect_url=${encodeURIComponent(redirectUrl)}`,
    );

    const { navigation } = resolveAuthV2PlatformContext("sign-in");
    const nestedUrl = absoluteNavigationUrl(
      navigation.href("sign-in", "/factor-one"),
    );

    expect(navigation.completionRedirectUrl).toBe(redirectUrl);
    expect(nestedUrl.searchParams.get("flow")).toBe("identifier");
    expect(nestedUrl.searchParams.get("redirect_url")).toBe(redirectUrl);
    expect(hashSearchParams(nestedUrl.hash).get("step")).toBe("code");
    expect(hashSearchParams(nestedUrl.hash).get("redirect_url")).toBe(
      redirectUrl,
    );
  });

  it.each([
    {
      name: "malformed",
      pageOrigin: "https://app.vm0.ai",
      redirectUrl: "https://[",
      source: "query",
      expectedBrandName: "VM0",
    },
    {
      name: "cross-environment",
      pageOrigin: "https://app.vm0.ai",
      redirectUrl: "https://staging-www.omby.ai/connector/success",
      source: "query",
      expectedBrandName: "VM0",
    },
    {
      name: "untrusted",
      pageOrigin: "https://app.vm0.ai",
      redirectUrl: "https://app.okou.ai.evil.example/sign-in",
      source: "hash",
      expectedBrandName: "VM0",
    },
    {
      name: "production-from-preview",
      pageOrigin: "https://pr-28927-app.omby.ai",
      redirectUrl: "https://app.vm0.ai/agents",
      source: "query",
      expectedBrandName: "Okou",
    },
  ])(
    "replaces a $name redirect with the current app origin",
    ({ expectedBrandName, pageOrigin, redirectUrl, source }) => {
      const encodedRedirectUrl = encodeURIComponent(redirectUrl);
      const query =
        source === "query" ? `?redirect_url=${encodedRedirectUrl}` : "";
      const hash =
        source === "hash"
          ? `#/factor-one?redirect_url=${encodedRedirectUrl}`
          : "#/factor-one?step=identifier";
      setBrowserUrl(`${pageOrigin}/sign-in/factor-one${query}${hash}`);

      const { authBrand, navigation } = resolveAuthV2PlatformContext("sign-in");
      const nestedUrl = absoluteNavigationUrl(
        navigation.href("sign-in", "/factor-one"),
      );

      expect(navigation.completionRedirectUrl).toBe(pageOrigin);
      expect(authBrand).toStrictEqual({
        brandName: expectedBrandName,
        homeUrl: "/",
      });
      expect(nestedUrl.searchParams.get("redirect_url")).toBe(pageOrigin);
      expect(hashSearchParams(nestedUrl.hash).get("redirect_url")).toBe(
        source === "hash" ? pageOrigin : null,
      );
    },
  );
});
