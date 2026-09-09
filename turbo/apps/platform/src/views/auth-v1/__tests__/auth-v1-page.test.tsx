import { act, screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { PRESENTATION_ONBOARDING_URL } from "../../../__tests__/presentation-onboarding-fixture.ts";
import {
  queryAllByRoleFast,
  setupPage,
  startPage,
} from "../../../__tests__/page-helper.ts";
import { platformOkouWordmarkDarkImg } from "../../../lib/static-assets.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function setupSignedOutPage(path: string): Promise<void> {
  return setupPage({ auth: null, context, host: "app.okou.ai", path });
}

function okouBrandLink(): HTMLElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.getAttribute("aria-label") === "Go to Okou home";
  });
  if (!link) {
    throw new Error("Okou brand link not found");
  }
  return link;
}

function clerkProviderConfig(): HTMLElement {
  return screen.getByTestId("clerk-provider-config");
}

test("The hosted sign-in form renders with Google One Tap on the base route", async () => {
  context.mocks.browser.matchMedia(false);
  const clerk = context.mocks.clerk();
  await setupSignedOutPage("/v1/sign-in");

  const signIn = screen.getByTestId("clerk-sign-in");
  expect(signIn).toHaveAttribute("data-clerk-routing", "path");
  expect(signIn).toHaveTextContent("/v1/sign-in");
  expect(signIn).toHaveAttribute("data-clerk-sign-in-url", "/v1/sign-in");
  expect(signIn).toHaveAttribute("data-clerk-sign-up-url", "/v1/sign-up");
  expect(screen.getByTestId("app-sign-in")).toHaveClass(
    "w-[var(--okou-auth-card-page-width)]",
    "max-w-[var(--okou-auth-card-max-width)]",
    "shrink-0",
  );
  expect(signIn).toHaveAttribute(
    "data-clerk-force-redirect-url",
    "https://app.okou.ai",
  );
  expect(screen.getByTestId("clerk-google-one-tap")).toHaveAttribute(
    "data-sign-in-force-redirect-url",
    "https://app.okou.ai",
  );
  expect(screen.getByTestId("clerk-google-one-tap")).toHaveAttribute(
    "data-sign-up-force-redirect-url",
    "https://app.okou.ai",
  );
  expect(screen.getByAltText("Okou")).toHaveAttribute(
    "src",
    platformOkouWordmarkDarkImg,
  );
  expect(document.title).toBe("Sign in | Okou");
  expect(clerk.uiRequests).toStrictEqual([
    "https://app.example.test/assets/clerk-ui-test.js",
  ]);
  expect(screen.getByTestId("app-skeleton")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  expect(
    document.querySelector("[data-auth-v1-legacy-clerk-css]"),
  ).not.toBeInTheDocument();
});

test("Nested sign-in task paths stay on the hosted sign-in form", async () => {
  await setupSignedOutPage("/v1/sign-in/tasks/choose-organization");

  expect(screen.getByTestId("clerk-sign-in")).toHaveTextContent("/v1/sign-in");
  expect(screen.queryByTestId("clerk-google-one-tap")).not.toBeInTheDocument();
  expect(document.title).toBe("Sign in | Okou");
});

test("The hosted sign-up form renders with an allowed redirect URL", async () => {
  const redirectUrl = PRESENTATION_ONBOARDING_URL;
  await setupSignedOutPage(
    `/v1/sign-up?redirect_url=${encodeURIComponent(redirectUrl)}`,
  );

  const signUp = screen.getByTestId("clerk-sign-up");
  expect(signUp).toHaveAttribute("data-clerk-routing", "path");
  expect(signUp).toHaveTextContent("/v1/sign-up");
  expect(signUp).toHaveAttribute("data-clerk-sign-in-url", "/v1/sign-in");
  expect(signUp).not.toHaveAttribute("data-clerk-sign-up-url");
  expect(screen.getByTestId("app-sign-up")).toHaveClass(
    "w-[var(--okou-auth-card-page-width)]",
    "max-w-[var(--okou-auth-card-max-width)]",
    "shrink-0",
  );
  expect(signUp).toHaveAttribute(
    "data-clerk-fallback-redirect-url",
    redirectUrl,
  );
  expect(signUp).toHaveAttribute("data-clerk-force-redirect-url", redirectUrl);
  expect(screen.queryByTestId("clerk-google-one-tap")).not.toBeInTheDocument();
  expect(document.title).toBe("Sign up | Okou");
  expect(clerkProviderConfig()).toHaveAttribute(
    "data-clerk-sign-in-start-action-link",
    "Sign up",
  );
  expect(clerkProviderConfig()).toHaveAttribute(
    "data-clerk-provider-sign-in-url",
    "https://app.okou.ai/v1/sign-in",
  );
  expect(clerkProviderConfig()).toHaveAttribute(
    "data-clerk-provider-sign-up-url",
    "https://app.okou.ai/v1/sign-up",
  );
  expect(clerkProviderConfig()).toHaveAttribute(
    "data-clerk-user-banned-error",
    expect.stringContaining("support@okou.ai"),
  );
  expect(clerkProviderConfig()).toHaveAttribute(
    "data-clerk-form-code-incorrect-error",
    "This action couldn't be completed. Please try again later or contact support if this persists.",
  );
  expect(clerkProviderConfig()).toHaveAttribute(
    "data-clerk-form-password-not-strong-enough-error",
    "Your password is not strong enough.",
  );
  expect(clerkProviderConfig()).not.toHaveAttribute(
    "data-clerk-form-password-incorrect-error",
  );
  expect(
    document.querySelector("[data-auth-v1-legacy-clerk-css]"),
  ).not.toBeInTheDocument();
});

test("The hosted form waits behind the skeleton until Clerk mounts it", async () => {
  const clerk = context.mocks.clerk();
  const clerkLoad = clerk.runtimePending();
  const authComponent = clerk.deferAuthComponentMount();

  const page = await startPage({
    auth: null,
    context,
    host: "app.okou.ai",
    path: "/v1/sign-up",
  });

  const appSkeleton = await screen.findByTestId("app-skeleton");
  await expect(
    screen.findByTestId("clerk-auth-loading"),
  ).resolves.toBeInTheDocument();
  expect(appSkeleton).not.toHaveAttribute("aria-hidden");
  expect(screen.getByTestId("clerk-sign-up")).toBeEmptyDOMElement();
  expect(clerk.uiRequests).toHaveLength(1);

  await act(async () => {
    clerkLoad.resolve();
    await clerkLoad.promise;
  });

  expect(screen.getByTestId("clerk-auth-loading")).toBeInTheDocument();
  expect(appSkeleton).not.toHaveAttribute("aria-hidden");

  act(() => {
    authComponent.mount();
  });
  await page.ready;

  expect(screen.getByTestId("clerk-sign-up")).toHaveTextContent("/v1/sign-up");
  expect(appSkeleton).toHaveAttribute("aria-hidden", "true");
  expect(screen.queryByTestId("clerk-auth-loading")).not.toBeInTheDocument();
});

test("A trusted Okou destination brands the hosted sign-in", async () => {
  context.mocks.browser.matchMedia(false);
  const redirectUrl = "https://app.okou.ai/_/skeleton";
  await setupSignedOutPage(
    `/v1/sign-in?redirect_url=${encodeURIComponent(redirectUrl)}`,
  );

  const signIn = screen.getByTestId("clerk-sign-in");
  expect(signIn).toHaveAttribute("data-clerk-force-redirect-url", redirectUrl);
  expect(screen.getByTestId("clerk-google-one-tap")).toHaveAttribute(
    "data-sign-in-force-redirect-url",
    redirectUrl,
  );
  expect(document.title).toBe("Sign in | Okou");
  expect(screen.queryByAltText("VM0")).not.toBeInTheDocument();
  expect(okouBrandLink()).toHaveAttribute("href", "/");
  expect(clerkProviderConfig()).toHaveAttribute(
    "data-clerk-sign-in-start-title",
    "Sign in to Okou",
  );
  expect(clerkProviderConfig()).toHaveAttribute(
    "data-clerk-sign-in-email-code-subtitle",
    "to continue to Okou",
  );
  expect(clerkProviderConfig()).toHaveAttribute(
    "data-clerk-user-banned-error",
    expect.stringContaining("support@okou.ai"),
  );
  expect(clerkProviderConfig()).toHaveAttribute(
    "data-clerk-form-code-incorrect-error",
    "That code is incorrect. Try again.",
  );
  expect(clerkProviderConfig()).toHaveAttribute(
    "data-clerk-form-password-incorrect-error",
    "This action couldn't be completed. Please try again later or contact support if this persists.",
  );
  expect(clerkProviderConfig()).toHaveAttribute(
    "data-clerk-form-password-not-strong-enough-error",
    "Your password is not strong enough.",
  );
  expect(clerkProviderConfig()).toHaveAttribute(
    "data-clerk-reset-password-action",
    "Reset password",
  );
});

test("Okou auth intent survives Clerk moving the redirect into the hash", async () => {
  const redirectUrl = "https://app.okou.ai/onboarding?source=auth-switch";
  await setupSignedOutPage(
    `/v1/sign-up#/?redirect_url=${encodeURIComponent(redirectUrl)}`,
  );

  expect(screen.getByTestId("clerk-sign-up")).toHaveAttribute(
    "data-clerk-force-redirect-url",
    redirectUrl,
  );
  expect(document.title).toBe("Sign up | Okou");
  expect(okouBrandLink()).toHaveAttribute("href", "/");
});

test("An untrusted redirect URL does not control the auth brand", async () => {
  context.mocks.browser.matchMedia(false);
  const redirectUrl = "https://app.okou.ai.evil.example/sign-in";
  await setupSignedOutPage(
    `/v1/sign-in?redirect_url=${encodeURIComponent(redirectUrl)}`,
  );

  expect(screen.getByTestId("clerk-sign-in")).toHaveAttribute(
    "data-clerk-force-redirect-url",
    "https://app.okou.ai",
  );
  expect(document.title).toBe("Sign in | Okou");
  expect(screen.getByAltText("Okou")).toHaveAttribute(
    "src",
    platformOkouWordmarkDarkImg,
  );
});

test("Ad-attributed sign-ups continue to onboarding with their attribution", async () => {
  await setupSignedOutPage(
    "/v1/sign-up?gclid=click-123&utm_campaign=summer#/verify?step=code",
  );

  const redirectUrl = new URL(
    screen.getByTestId("clerk-sign-up").dataset.clerkForceRedirectUrl ?? "",
  );
  expect(redirectUrl.origin).toBe("https://app.okou.ai");
  expect(redirectUrl.pathname).toBe("/onboarding");
  expect(redirectUrl.searchParams.get("gclid")).toBe("click-123");
  expect(redirectUrl.searchParams.get("utm_campaign")).toBe("summer");
  expect(redirectUrl.searchParams.get("vm0_source")).toBe("homepage");
});

test("Sign-up redirects to sibling origins of the current host are kept", async () => {
  const redirectUrl = "https://www.okou.ai/connector/success?vm0_theme=light";
  await setupSignedOutPage(
    `/v1/sign-up?redirect_url=${encodeURIComponent(redirectUrl)}`,
  );

  expect(
    screen.getByTestId("clerk-sign-up").dataset.clerkForceRedirectUrl,
  ).toBe(redirectUrl);
});

test("Sign-up redirects to other environments fall back to onboarding", async () => {
  await setupSignedOutPage(
    "/v1/sign-up?redirect_url=https%3A%2F%2Fstaging-www.omby.ai%2Fconnector%2Fsuccess",
  );

  expect(
    screen.getByTestId("clerk-sign-up").dataset.clerkForceRedirectUrl,
  ).toBe("https://app.okou.ai/onboarding");
});

test("Hosted auth pages scroll inside the root safe area", async () => {
  context.mocks.browser.matchMedia(false);
  await setupSignedOutPage("/v1/sign-up");

  const layout = screen.getByTestId("app-auth-layout");
  expect(layout).toHaveClass("h-full");
  expect(layout).toHaveClass("min-h-0");
  expect(layout).toHaveClass("overflow-y-auto");
  expect(layout).toHaveClass("overflow-x-hidden");
  expect(layout).not.toHaveClass("overflow-hidden");

  const logoImage = screen.getByAltText("Okou");
  expect(logoImage).not.toHaveAttribute("crossorigin");
  const logo = logoImage.closest("a");
  expect(logo).toHaveClass("left-6");
  expect(logo).toHaveClass("top-6");

  const themeToggle = screen.getByLabelText("Toggle theme");
  expect(themeToggle.className).toContain("var(--sat)");
  expect(themeToggle.className).toContain("var(--sar)");
});
