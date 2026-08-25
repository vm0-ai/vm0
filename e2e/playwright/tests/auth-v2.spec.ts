import { clerk } from "@clerk/testing/playwright";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../auth-v2-fixtures";
import {
  AUTH_V2_TEST_OTP,
  mockNextAuthV2VerificationExpiry,
  mockNextAuthV2VerificationServerError,
  observeAuthV2VerificationRequests,
} from "../lib/auth-v2";
import {
  activateTwice,
  authV2Input,
  authV2Root,
  chooseSignInMethod,
  continueWithOrganization,
  expectNoOrganizationCreation,
  expectStepAnnouncement,
  openAuthV2,
  resendOrRetryButton,
  signInMethodButton,
  submitSignInIdentifier,
  waitForPathname,
} from "../lib/auth-v2-ui";

const ORGANIZATION_ALPHA = "Auth v2 Browser Alpha";
const ORGANIZATION_BETA = "Auth v2 Browser Beta";
const SUPPORTED_AUTH_V2_LOCALES = [
  "en-US",
  "pt-BR",
  "ja-JP",
  "ko-KR",
  "id-ID",
  "de-DE",
  "es-ES",
  "it-IT",
  "fr-FR",
  "hi-IN",
] as const;

test("base, nested, refreshed, and legacy auth routes coexist on desktop", async ({
  page,
}) => {
  const v2Routes = [
    "/v2/sign-in",
    "/v2/sign-in/factor-one?auth_v2_e2e=nested#/factor-one",
    "/v2/sign-up",
    "/v2/sign-up/verify-email-address?auth_v2_e2e=nested#/verify",
  ];
  for (const route of v2Routes) {
    await openAuthV2(page, route);
    const expectedPathname = new URL(route, "https://auth-v2.invalid").pathname;
    expect(new URL(page.url()).pathname).toBe(expectedPathname);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(authV2Root(page)).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(expectedPathname);
  }

  expect(await page.evaluate(() => window.innerWidth)).toBeGreaterThanOrEqual(
    1_000,
  );
  for (const legacyRoute of ["/sign-in", "/sign-up"]) {
    await page.goto(legacyRoute, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("app-auth-layout")).toBeVisible();
    await expect(authV2Root(page)).toHaveCount(0);
    expect(new URL(page.url()).pathname.startsWith(legacyRoute)).toBe(true);
  }
});

test.describe("localized mobile presentation", () => {
  test.use({
    colorScheme: "dark",
    locale: "fr-FR",
    viewport: { height: 844, width: 390 },
  });

  test("keeps brand, theme, focus, announcements, and layout accessible", async ({
    page,
  }) => {
    await openAuthV2(
      page,
      "/v2/sign-in/factor-one?auth_v2_e2e=mobile#/factor-one",
    );

    const heading = authV2Root(page).locator("h1");
    await expect(heading).toBeVisible();
    await expect(heading).toContainText(/Okou|VM0/);
    await expect(heading).not.toHaveText(/^Sign in to (Okou|VM0)$/);
    await expect(page.locator("html")).toHaveAttribute("lang", /^fr/i);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(heading).toBeFocused();
    await expectStepAnnouncement(page);

    const themeToggle = page.getByRole("button", {
      name: /theme|thème/i,
    });
    await expect(themeToggle).toHaveAttribute("aria-pressed", "true");
    await themeToggle.focus();
    await page.keyboard.press("Enter");
    await expect(themeToggle).toBeFocused();
    await expect(themeToggle).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    const hasHorizontalOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    expect(hasHorizontalOverflow).toBe(false);
  });
});

for (const locale of SUPPORTED_AUTH_V2_LOCALES) {
  test.describe(`Auth v2 locale ${locale}`, () => {
    test.use({ locale });

    test("loads platform-owned sign-up copy", async ({ page }) => {
      await openAuthV2(page, "/v2/sign-up/verify-email-address");
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      const heading = authV2Root(page).locator("h1");
      await expect(heading).toContainText(/Okou|VM0/);
      if (locale !== "en-US") {
        await expect(heading).not.toHaveText(
          /^Create your (Okou|VM0) account$/,
        );
      }
    });
  });
}

test("password sign-in recovers from a server error and honors an allowed redirect", async ({
  authV2Resources,
  baseURL,
  page,
}) => {
  const identity = await authV2Resources.createPasswordIdentity([
    ORGANIZATION_ALPHA,
    ORGANIZATION_BETA,
  ]);
  const redirect = sameOriginRedirect(baseURL, "password");
  await openAuthV2(page, authUrl("/v2/sign-in", redirect));
  await submitSignInIdentifier(page, identity.email);
  await chooseSignInMethod(page, "password");

  const password = authV2Input(page, "password");
  await expect(password).toBeVisible();
  await password.fill(identity.password);
  const reveal = authV2Root(page).getByRole("button", {
    name: /show password/i,
  });
  await reveal.click();
  await expect(password).toHaveAttribute("type", "text");
  await expect(password).not.toHaveValue("");
  await authV2Root(page)
    .getByRole("button", { name: /hide password/i })
    .click();
  await expect(password).toHaveAttribute("type", "password");

  await mockNextAuthV2VerificationServerError(page, "sign-in");
  await password.press("Enter");
  const serverError = authV2Root(page).getByRole("alert");
  await expect(serverError).toBeVisible();
  await expect(serverError).toBeFocused();
  await expect(password).toHaveAttribute("aria-invalid", "true");
  await expectStepAnnouncement(page);

  const changedPassword = authV2Resources.createPassword();
  await password.fill(changedPassword);
  await expect(serverError).toHaveCount(0);
  await expect(password).not.toHaveAttribute("aria-invalid");
  await expect(password).not.toHaveAttribute("aria-describedby");
  await password.fill(identity.password);
  await password.press("Enter");
  await finishAuthV2Continuation(page, redirect, ORGANIZATION_BETA);
});

test("email-code sign-in sends once, coalesces retry, edits, expires, and refreshes", async ({
  authV2Resources,
  baseURL,
  page,
}) => {
  test.setTimeout(150_000);
  const identity = await authV2Resources.createPasswordIdentity([
    ORGANIZATION_ALPHA,
  ]);
  const editedIdentity = await authV2Resources.createPasswordIdentity([
    ORGANIZATION_BETA,
  ]);
  const redirect = sameOriginRedirect(baseURL, "email-code");
  const requests = observeAuthV2VerificationRequests(page);
  try {
    await openAuthV2(page, authUrl("/v2/sign-in", redirect));
    await submitSignInIdentifier(page, identity.email);
    await chooseSignInMethod(page, "email-code");
    await expect(authV2Input(page, "code")).toBeVisible();
    await expect.poll(() => requests.count("sign-in", "prepare")).toBe(1);

    const initialResend = resendOrRetryButton(page);
    await expect(initialResend).toBeDisabled();
    await activateTwice(initialResend);
    expect(requests.count("sign-in", "prepare")).toBe(1);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(authV2Input(page, "code")).toBeVisible();
    expect(requests.count("sign-in", "prepare")).toBe(1);
    await expect(initialResend).toBeEnabled({ timeout: 35_000 });
    await activateTwice(initialResend);
    await expect.poll(() => requests.count("sign-in", "prepare")).toBe(2);
    await page.waitForTimeout(250);
    expect(requests.count("sign-in", "prepare")).toBe(2);

    await mockNextAuthV2VerificationExpiry(page, "sign-in");
    const code = authV2Input(page, "code");
    await code.fill(AUTH_V2_TEST_OTP);
    await code.press("Enter");
    const expiryError = authV2Root(page).getByRole("alert");
    await expect(expiryError).toBeVisible();
    await expect(expiryError).toBeFocused();
    await expectStepAnnouncement(page);

    const retry = resendOrRetryButton(page);
    await expect(retry).toBeEnabled();
    await activateTwice(retry);
    await expect.poll(() => requests.count("sign-in", "prepare")).toBe(3);
    await page.waitForTimeout(250);
    expect(requests.count("sign-in", "prepare")).toBe(3);
    await expect(authV2Input(page, "code")).toBeVisible();

    await authV2Root(page)
      .getByRole("button", { name: /back|edit/i })
      .last()
      .click();
    await expect(signInMethodButton(page, "email-code")).toBeVisible();
    await authV2Root(page).getByRole("button", { name: /edit/i }).click();
    const identifier = authV2Input(page, "identifier");
    await expect(identifier).toBeVisible();
    expect(
      await identifier.evaluate((input: HTMLInputElement) => {
        return input.value.length > 0;
      }),
    ).toBe(true);
    await identifier.fill(editedIdentity.email);
    await identifier.press("Enter");
    await chooseSignInMethod(page, "email-code");
    await expect(authV2Input(page, "code")).toBeVisible();
    await expect.poll(() => requests.count("sign-in", "prepare")).toBe(4);

    await authV2Input(page, "code").fill(AUTH_V2_TEST_OTP);
    await authV2Input(page, "code").press("Enter");
    await finishAuthV2Continuation(page, redirect, ORGANIZATION_BETA);
  } finally {
    requests.dispose();
  }
});

test("password reset retries an expired code, survives refresh, and sets a new password", async ({
  authV2Resources,
  baseURL,
  page,
}) => {
  const identity = await authV2Resources.createPasswordIdentity([
    ORGANIZATION_ALPHA,
  ]);
  const newPassword = authV2Resources.createPassword();
  const redirect = sameOriginRedirect(baseURL, "password-reset");
  const requests = observeAuthV2VerificationRequests(page);
  try {
    await openAuthV2(page, authUrl("/v2/sign-in", redirect));
    await submitSignInIdentifier(page, identity.email);
    await chooseSignInMethod(page, "password");
    await authV2Root(page)
      .getByRole("button", { name: /forgot password/i })
      .click();
    await expect(authV2Input(page, "code")).toBeVisible();
    await expect.poll(() => requests.count("sign-in", "prepare")).toBe(1);
    await expect(resendOrRetryButton(page)).toBeDisabled();

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(authV2Input(page, "code")).toBeVisible();
    expect(requests.count("sign-in", "prepare")).toBe(1);

    await mockNextAuthV2VerificationExpiry(page, "sign-in");
    await authV2Input(page, "code").fill(AUTH_V2_TEST_OTP);
    await authV2Input(page, "code").press("Enter");
    const retry = resendOrRetryButton(page);
    await expect(retry).toBeEnabled();
    await activateTwice(retry);
    await expect.poll(() => requests.count("sign-in", "prepare")).toBe(2);
    await page.waitForTimeout(250);
    expect(requests.count("sign-in", "prepare")).toBe(2);

    await authV2Input(page, "code").fill(AUTH_V2_TEST_OTP);
    await authV2Input(page, "code").press("Enter");
    await expect(authV2Input(page, "new-password")).toBeVisible();
    await page.reload({ waitUntil: "domcontentloaded" });
    const newPasswordInput = authV2Input(page, "new-password");
    const confirmation = authV2Input(page, "confirm-password");
    await expect(newPasswordInput).toBeVisible();

    await newPasswordInput.fill(newPassword);
    await confirmation.fill(identity.password);
    await confirmation.press("Enter");
    const mismatchError = authV2Root(page).getByRole("alert");
    await expect(mismatchError).toBeVisible();
    await expect(mismatchError).toBeFocused();
    await expect(newPasswordInput).toHaveAttribute("aria-invalid", "true");
    await expect(confirmation).toHaveAttribute("aria-invalid", "true");
    await confirmation.fill(newPassword);
    await expect(newPasswordInput).toHaveAttribute("aria-invalid", "false");
    await expect(confirmation).toHaveAttribute("aria-invalid", "false");
    await expect(mismatchError).toHaveCount(0);
    await confirmation.press("Enter");
    await finishAuthV2Continuation(page, redirect, ORGANIZATION_ALPHA);
  } finally {
    requests.dispose();
  }
});

test("progressive sign-up validates details and activates after one verification", async ({
  authV2Resources,
  baseURL,
  page,
}) => {
  const initialEmail = authV2Resources.allocateEmail();
  const editedEmail = authV2Resources.allocateEmail();
  const password = authV2Resources.createPassword();
  const redirect = sameOriginRedirect(baseURL, "sign-up");
  const requests = observeAuthV2VerificationRequests(page);
  try {
    await openAuthV2(page, authUrl("/v2/sign-up", redirect));
    const email = authV2Input(page, "email-address");
    const passwordInput = authV2Input(page, "password");
    const firstName = authV2Input(page, "first-name");
    const lastName = authV2Input(page, "last-name");
    await expect(email).toBeVisible();
    await expect(passwordInput).toBeVisible();
    await expect(firstName).toBeVisible();
    await expect(lastName).toBeVisible();
    await email.fill(initialEmail);
    await passwordInput.fill("short");
    await firstName.fill("Auth");
    await lastName.fill("Browser");

    const legal = authV2Root(page).getByRole("checkbox");
    await expect(legal).toBeVisible();
    await passwordInput.press("Enter");
    await expect(authV2Root(page).getByRole("alert")).toBeVisible();
    expect(requests.count("sign-up", "prepare")).toBe(0);
    await legal.check();
    await expect(authV2Root(page).getByRole("alert")).toHaveCount(0);
    await passwordInput.press("Enter");
    await expect(authV2Root(page).getByRole("alert")).toBeVisible();
    await expect(passwordInput).toBeFocused();
    expect(requests.count("sign-up", "prepare")).toBe(0);

    await passwordInput.fill(password);
    await passwordInput.press("Enter");
    await expect(authV2Input(page, "code")).toBeVisible();
    await expect.poll(() => requests.count("sign-up", "prepare")).toBe(1);
    const initialResend = resendOrRetryButton(page);
    await expect(initialResend).toBeDisabled();
    await activateTwice(initialResend);
    expect(requests.count("sign-up", "prepare")).toBe(1);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(authV2Input(page, "code")).toBeVisible();
    expect(requests.count("sign-up", "prepare")).toBe(1);

    await mockNextAuthV2VerificationExpiry(page, "sign-up");
    await authV2Input(page, "code").fill(AUTH_V2_TEST_OTP);
    await authV2Input(page, "code").press("Enter");
    await expect(authV2Root(page).getByRole("alert")).toBeVisible();
    const retry = resendOrRetryButton(page);
    await expect(retry).toBeEnabled();
    await activateTwice(retry);
    await expect.poll(() => requests.count("sign-up", "prepare")).toBe(2);
    await page.waitForTimeout(250);
    expect(requests.count("sign-up", "prepare")).toBe(2);

    await authV2Root(page)
      .getByRole("button", { name: /edit email|back/i })
      .click();
    const editedEmailInput = authV2Input(page, "email-address");
    await expect(editedEmailInput).toBeVisible();
    await editedEmailInput.fill(editedEmail);
    await editedEmailInput.press("Enter");
    await expect(authV2Input(page, "code")).toBeVisible();
    await expect.poll(() => requests.count("sign-up", "prepare")).toBe(3);

    await page.reload({ waitUntil: "domcontentloaded" });
    expect(requests.count("sign-up", "prepare")).toBe(3);
    await authV2Input(page, "code").fill(AUTH_V2_TEST_OTP);
    await authV2Input(page, "code").press("Enter");
    await waitForActivatedSessionOrRedirect(page, redirect);
    await expectNoOrganizationCreation(page);
  } finally {
    requests.dispose();
  }
});

test("existing sessions continue without exposing organization creation", async ({
  authV2Resources,
  baseURL,
  page,
}) => {
  const identity = await authV2Resources.createPasswordIdentity([
    ORGANIZATION_ALPHA,
  ]);
  const redirect = sameOriginRedirect(baseURL, "existing-session");
  await page.goto("/_/skeleton", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.Clerk?.loaded));
  await clerk.signIn({ emailAddress: identity.email, page });

  await openAuthV2(page, authUrl("/v2/sign-in", redirect));
  const account = authV2Root(page).getByRole("button", {
    name: /Auth Browser/i,
  });
  await expect(account).toBeVisible();
  await expectStepAnnouncement(page);
  await account.click();
  await finishAuthV2Continuation(page, redirect, ORGANIZATION_ALPHA);
});

test("bounds Google One Tap, OAuth, and passkey behavior at external handoffs", async ({
  page,
}, testInfo) => {
  await installExternalAuthBoundaryStubs(page);
  await openAuthV2(page, "/v2/sign-in");
  await expect(authV2Input(page, "identifier")).toBeVisible();

  const oneTapConfigured = await page.evaluate(() => {
    const clerkEnvironment = window.Clerk as unknown as {
      readonly __internal_environment?: {
        readonly displayConfig?: { readonly googleOneTapClientId?: string };
      };
    };
    return Boolean(
      clerkEnvironment?.__internal_environment?.displayConfig
        ?.googleOneTapClientId,
    );
  });
  if (oneTapConfigured) {
    await expect
      .poll(async () => {
        return await googleBoundaryCount(page, "prompts");
      })
      .toBe(1);
    expect(await googleBoundaryCount(page, "initializes")).toBe(1);
    expect(await googleBoundaryCount(page, "fedCmInitializes")).toBe(1);
    await openAuthV2(page, "/v2/sign-in/factor-one");
    expect(await googleBoundaryCount(page, "prompts")).toBe(1);
    expect(await googleBoundaryCount(page, "initializes")).toBe(1);
    expect(await googleBoundaryCount(page, "fedCmInitializes")).toBe(1);
  } else {
    testInfo.annotations.push({
      description: "Google is disabled in this Clerk development instance",
      type: "external-limitation",
    });
  }

  await openAuthV2(page, "/v2/sign-in");
  await expect(authV2Input(page, "identifier")).toBeVisible();
  const passkey = signInMethodButton(page, "passkey");
  if (await passkey.isVisible()) {
    await passkey.click();
    await expect(authV2Root(page).getByRole("alert")).toBeVisible();
    await expect(authV2Input(page, "identifier")).toBeVisible();
  } else {
    testInfo.annotations.push({
      description: "Passkeys are disabled in this Clerk development instance",
      type: "external-limitation",
    });
  }

  const google = signInMethodButton(page, "google");
  if (await google.isVisible()) {
    const handoff = page.waitForRequest(
      (request) => new URL(request.url()).hostname === "accounts.google.com",
    );
    await google.click();
    const request = await handoff;
    expect(new URL(request.url()).protocol).toBe("https:");

    const signUpPage = await page.context().newPage();
    try {
      await installExternalAuthBoundaryStubs(signUpPage);
      await openAuthV2(signUpPage, "/v2/sign-up");
      await expect(authV2Input(signUpPage, "email-address")).toBeVisible();
      const legal = authV2Root(signUpPage).getByRole("checkbox");
      if (await legal.isVisible()) {
        await legal.check();
      }
      const signUpGoogle = authV2Root(signUpPage).getByRole("button", {
        name: /google/i,
      });
      await expect(signUpGoogle).toBeVisible();
      const signUpHandoff = signUpPage.waitForRequest(
        (candidate) =>
          new URL(candidate.url()).hostname === "accounts.google.com",
      );
      await signUpGoogle.click();
      expect(new URL((await signUpHandoff).url()).protocol).toBe("https:");
    } finally {
      await signUpPage.close();
    }
  } else {
    testInfo.annotations.push({
      description:
        "Google OAuth is disabled in this Clerk development instance",
      type: "external-limitation",
    });
  }
});

function sameOriginRedirect(
  baseURL: string | undefined,
  testCase: string,
): URL {
  if (!baseURL) {
    throw new Error("Playwright baseURL is required");
  }
  const redirect = new URL("/_/skeleton", baseURL);
  redirect.searchParams.set("auth_v2_e2e", testCase);
  return redirect;
}

function authUrl(pathname: string, redirect: URL): string {
  const url = new URL(pathname, redirect.origin);
  url.searchParams.set("redirect_url", redirect.toString());
  return url.toString();
}

async function finishAuthV2Continuation(
  page: Page,
  redirect: URL,
  organizationName: string,
): Promise<void> {
  const organization = organizationButton(page, organizationName);
  await expect
    .poll(async () => {
      return (
        new URL(page.url()).pathname === redirect.pathname ||
        (await organization.isVisible())
      );
    })
    .toBe(true);
  await expectNoOrganizationCreation(page);
  if (new URL(page.url()).pathname !== redirect.pathname) {
    await continueWithOrganization(page, organizationName);
    await waitForPathname(page, redirect.pathname);
  }
  expect(new URL(page.url()).searchParams.get("auth_v2_e2e")).toBe(
    redirect.searchParams.get("auth_v2_e2e"),
  );
}

async function waitForActivatedSessionOrRedirect(
  page: Page,
  redirect: URL,
): Promise<void> {
  await expect
    .poll(async () => {
      if (new URL(page.url()).pathname === redirect.pathname) {
        return "activated";
      }
      return await page.evaluate(() => {
        return window.Clerk?.client?.signUp.status === "complete" &&
          window.Clerk.session
          ? "activated"
          : "pending";
      });
    })
    .toBe("activated");
}

function organizationButton(page: Page, organizationName: string): Locator {
  return authV2Root(page).getByRole("button", {
    name: organizationName,
  });
}

interface GoogleBoundaryState {
  readonly fedCmInitializes: number;
  readonly initializes: number;
  readonly prompts: number;
}

async function installExternalAuthBoundaryStubs(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const storedFedCmInitializes = Number(
      sessionStorage.getItem("auth-v2-google-fedcm-initializes") ?? "0",
    );
    const storedInitializes = Number(
      sessionStorage.getItem("auth-v2-google-initializes") ?? "0",
    );
    const storedPrompts = Number(
      sessionStorage.getItem("auth-v2-google-prompts") ?? "0",
    );
    const state = {
      fedCmInitializes: storedFedCmInitializes,
      initializes: storedInitializes,
      prompts: storedPrompts,
    };
    const boundaryWindow = window as Window & {
      __authV2GoogleBoundary?: GoogleBoundaryState;
      google?: unknown;
    };
    boundaryWindow.__authV2GoogleBoundary = state;
    Object.defineProperty(boundaryWindow, "google", {
      configurable: true,
      value: {
        accounts: {
          id: {
            cancel: () => undefined,
            initialize: (options: {
              readonly use_fedcm_for_prompt?: boolean;
            }) => {
              state.initializes += 1;
              sessionStorage.setItem(
                "auth-v2-google-initializes",
                String(state.initializes),
              );
              if (options.use_fedcm_for_prompt === true) {
                state.fedCmInitializes += 1;
                sessionStorage.setItem(
                  "auth-v2-google-fedcm-initializes",
                  String(state.fedCmInitializes),
                );
              }
            },
            prompt: (
              callback: (notification: {
                getMomentType: () => "dismissed" | "display" | "skipped";
              }) => void,
            ) => {
              state.prompts += 1;
              sessionStorage.setItem(
                "auth-v2-google-prompts",
                String(state.prompts),
              );
              callback({
                getMomentType: () => "skipped",
              });
            },
          },
        },
      },
    });
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: {
        create: async () => null,
        get: async () => {
          throw new DOMException(
            "Passkey request cancelled",
            "NotAllowedError",
          );
        },
        preventSilentAccess: async () => undefined,
        store: async () => undefined,
      },
    });
  });
  await page.route("https://accounts.google.com/**", async (route) => {
    await route.abort("blockedbyclient");
  });
}

async function googleBoundaryCount(
  page: Page,
  property: keyof GoogleBoundaryState,
): Promise<number> {
  return await page.evaluate((selectedProperty) => {
    const boundaryWindow = window as Window & {
      __authV2GoogleBoundary?: GoogleBoundaryState;
    };
    return boundaryWindow.__authV2GoogleBoundary?.[selectedProperty] ?? 0;
  }, property);
}
