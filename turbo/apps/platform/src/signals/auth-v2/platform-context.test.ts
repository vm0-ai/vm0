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

describe("Auth v2 platform context", () => {
  it("uses an allowed Okou redirect as the brand context on the primary app", () => {
    const redirectUrl = "https://app.okou.ai/onboarding?source=auth-v2";
    setBrowserUrl(
      `https://app.vm0.ai/v2/sign-in?redirect_url=${encodeURIComponent(redirectUrl)}`,
    );

    const platformContext = resolveAuthV2PlatformContext("sign-in");

    expect(platformContext.authBrand).toStrictEqual({
      brandName: "Okou",
      homeUrl: "https://app.okou.ai",
    });
    expect(platformContext.navigation.completionRedirectUrl).toBe(redirectUrl);
    expect(platformContext.satelliteConfig).toBeNull();
  });

  it("preserves the registered Okou satellite context and primary-app redirects", () => {
    const redirectUrl = "https://app.vm0.ai/onboarding?source=okou";
    setBrowserUrl(
      `https://app.okou.ai/v2/sign-up?redirect_url=${encodeURIComponent(redirectUrl)}`,
    );

    const platformContext = resolveAuthV2PlatformContext("sign-up");

    expect(platformContext.authBrand).toStrictEqual({
      brandName: "Okou",
      homeUrl: "/",
    });
    expect(platformContext.navigation.completionRedirectUrl).toBe(redirectUrl);
    expect(platformContext.satelliteConfig).toStrictEqual({
      domain: "app.okou.ai",
      isSatellite: true,
      satelliteAutoSync: true,
    });

    const nestedUrl = absoluteNavigationUrl(
      platformContext.navigation.href("sign-up", "/verify-email-address"),
    );
    expect(nestedUrl.origin).toBe("https://app.okou.ai");
    expect(nestedUrl.pathname).toBe("/v2/sign-up/verify-email-address");
    expect(nestedUrl.searchParams.get("redirect_url")).toBe(redirectUrl);
  });

  it("preserves sign-up campaign attribution and onboarding intent across flows", () => {
    setBrowserUrl(
      "https://app.vm0.ai/v2/sign-up/verify-email-address?gclid=click-123&utm_campaign=summer&utm_content=hero&utm_content=footer#/verify?step=code",
    );

    const signUpContext = resolveAuthV2PlatformContext("sign-up");
    const completionUrl = new URL(
      signUpContext.navigation.completionRedirectUrl,
    );

    expect(completionUrl.origin).toBe("https://app.vm0.ai");
    expect(completionUrl.pathname).toBe("/onboarding");
    expect(completionUrl.searchParams.get("gclid")).toBe("click-123");
    expect(completionUrl.searchParams.get("utm_campaign")).toBe("summer");
    expect(completionUrl.searchParams.getAll("utm_content")).toStrictEqual([
      "hero",
      "footer",
    ]);
    expect(completionUrl.searchParams.get("vm0_source")).toBe("homepage");
    expect(completionUrl.searchParams.get("landing_host")).toBe("app.vm0.ai");
    expect(completionUrl.searchParams.get("landing_path")).toBe(
      "/v2/sign-up/verify-email-address",
    );

    const nestedSignUpUrl = absoluteNavigationUrl(
      signUpContext.navigation.href("sign-up", "/verify-email-address"),
    );
    expect(nestedSignUpUrl.searchParams.get("gclid")).toBe("click-123");
    expect(nestedSignUpUrl.searchParams.getAll("utm_content")).toStrictEqual([
      "hero",
      "footer",
    ]);
    expect(nestedSignUpUrl.searchParams.get("redirect_url")).toBe(
      completionUrl.toString(),
    );
    expect(nestedSignUpUrl.hash).toBe("#/verify?step=code");

    const signInHref = signUpContext.navigation.href("sign-in");
    setBrowserUrl(absoluteNavigationUrl(signInHref).toString());
    expect(
      resolveAuthV2PlatformContext("sign-in").navigation.completionRedirectUrl,
    ).toBe(completionUrl.toString());
  });

  it("preserves campaign onboarding when switching from sign-in to sign-up", () => {
    setBrowserUrl(
      "https://app.vm0.ai/v2/sign-in?gclid=click-123&utm_campaign=summer#/factor-one?step=code",
    );

    const signInContext = resolveAuthV2PlatformContext("sign-in");
    expect(signInContext.navigation.completionRedirectUrl).toBe(
      "https://app.vm0.ai",
    );

    const nestedSignInUrl = absoluteNavigationUrl(
      signInContext.navigation.href("sign-in", "/factor-one"),
    );
    expect(nestedSignInUrl.searchParams.get("redirect_url")).toBeNull();
    expect(nestedSignInUrl.searchParams.get("gclid")).toBe("click-123");

    setBrowserUrl(nestedSignInUrl.toString());
    const signUpUrl = absoluteNavigationUrl(
      resolveAuthV2PlatformContext("sign-in").navigation.href("sign-up"),
    );
    const signUpRedirectUrlValue = signUpUrl.searchParams.get("redirect_url");
    if (!signUpRedirectUrlValue) {
      throw new Error("Sign-up navigation is missing its completion redirect");
    }
    const signUpRedirectUrl = new URL(signUpRedirectUrlValue);

    expect(signUpRedirectUrl.pathname).toBe("/onboarding");
    expect(signUpRedirectUrl.searchParams.get("gclid")).toBe("click-123");
    expect(signUpRedirectUrl.searchParams.get("utm_campaign")).toBe("summer");

    setBrowserUrl(signUpUrl.toString());
    expect(
      resolveAuthV2PlatformContext("sign-up").navigation.completionRedirectUrl,
    ).toBe(signUpRedirectUrl.toString());
  });

  it("keeps an explicit allowed sign-up redirect ahead of campaign fallback", () => {
    const redirectUrl = "https://www.vm0.ai/connector/success";
    setBrowserUrl(
      `https://app.vm0.ai/v2/sign-up?gclid=click-123&redirect_url=${encodeURIComponent(redirectUrl)}`,
    );

    const { navigation } = resolveAuthV2PlatformContext("sign-up");
    const nestedUrl = absoluteNavigationUrl(
      navigation.href("sign-up", "/verify-email-address"),
    );

    expect(navigation.completionRedirectUrl).toBe(redirectUrl);
    expect(nestedUrl.searchParams.get("gclid")).toBe("click-123");
    expect(nestedUrl.searchParams.get("redirect_url")).toBe(redirectUrl);
  });
});

describe("Auth v2 app-owned platform context", () => {
  it("does not inherit the current page URL", () => {
    setBrowserUrl(
      "https://app.vm0.ai/agents?redirect_url=https%3A%2F%2Fwww.vm0.ai%2Fconnector%2Fsuccess#private-page-state",
    );

    const { navigation } = resolveAuthV2PlatformContext("sign-in", {
      authHash: "",
      authSearch: "",
    });
    const signInUrl = absoluteNavigationUrl(navigation.href("sign-in"));

    expect(navigation.completionRedirectUrl).toBe("https://app.vm0.ai");
    expect(signInUrl.searchParams.get("redirect_url")).toBe(
      "https://app.vm0.ai",
    );
    expect(signInUrl.hash).toBe("");
  });
});
