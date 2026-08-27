import { clerk } from "@clerk/testing/playwright";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../auth-v2-fixtures";
import { AUTH_V2_TEST_OTP } from "../lib/auth-v2";
import {
  authV2Input,
  authV2Root,
  chooseSignInMethod,
  continueWithOrganization,
  expectNoOrganizationCreation,
  expectStepAnnouncement,
  openAuthV2,
  reloadAuthV2,
  signInMethodButton,
  submitSignInIdentifier,
  waitForPathname,
} from "../lib/auth-v2-ui";

const ORGANIZATION_ALPHA = "Auth v2 Browser Alpha";
const ORGANIZATION_BETA = "Auth v2 Browser Beta";
const AUTH_V2_PRIMARY_COLOR = "rgb(239, 80, 1)";
const SUPPORTED_AUTH_V2_LOCALES = [
  { locale: "en-US", title: "Create your account" },
  { locale: "pt-BR", title: "Criar sua conta" },
  { locale: "ja-JP", title: "アカウントを作成" },
  { locale: "ko-KR", title: "계정 만들기" },
  { locale: "id-ID", title: "Buat akun Anda" },
  { locale: "de-DE", title: "Ihr Konto erstellen" },
  { locale: "es-ES", title: "Crea tu cuenta" },
  { locale: "it-IT", title: "Crea il tuo account" },
  { locale: "fr-FR", title: "Créer votre compte" },
  { locale: "hi-IN", title: "अपना खाता बनाएं" },
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
    await reloadAuthV2(page);
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

test("primary and link actions retain accessible brand colors in both themes", async ({
  page,
}) => {
  await openAuthV2(page, "/v2/sign-up");

  const root = authV2Root(page);
  const continueButton = root.getByRole("button", {
    exact: true,
    name: "Continue",
  });
  const signInLink = root.getByRole("link", {
    exact: true,
    name: "Sign in",
  });
  const passwordVisibilityAction = root.getByRole("button", {
    name: "Show password",
  });

  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(continueButton).toHaveCSS(
    "background-color",
    AUTH_V2_PRIMARY_COLOR,
  );
  await expect(continueButton).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(signInLink).toHaveCSS("color", AUTH_V2_PRIMARY_COLOR);
  await expect(passwordVisibilityAction).toHaveCSS("color", "rgb(21, 24, 30)");

  await page.getByRole("button", { name: "Toggle theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(continueButton).toHaveCSS(
    "background-color",
    AUTH_V2_PRIMARY_COLOR,
  );
  await expect(continueButton).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(signInLink).toHaveCSS("color", AUTH_V2_PRIMARY_COLOR);
  await expect(passwordVisibilityAction).toHaveCSS(
    "color",
    "rgb(233, 234, 236)",
  );
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

for (const { locale, title } of SUPPORTED_AUTH_V2_LOCALES) {
  test.describe(`Auth v2 locale ${locale}`, () => {
    test.use({ locale });

    test("loads platform-owned sign-up copy", async ({ page }) => {
      await openAuthV2(page, "/v2/sign-up/verify-email-address");
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      const heading = authV2Root(page).locator("h1");
      await expect(heading).toHaveText(title);
    });
  });
}

test("password sign-in completes Device Trust and honors an allowed redirect", async ({
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

  const password = authV2Input(page, "password");
  await expect(password).toBeVisible();
  await password.fill(identity.password);
  await password.press("Enter");
  const code = authV2Input(page, "code");
  await expect(code).toBeVisible();
  await code.fill(AUTH_V2_TEST_OTP);
  await code.press("Enter");
  await finishAuthV2Continuation(page, redirect, ORGANIZATION_BETA);
});

test("email-code sign-in completes with the development verification code", async ({
  authV2Resources,
  baseURL,
  page,
}) => {
  test.setTimeout(150_000);
  const identity = await authV2Resources.createPasswordIdentity([
    ORGANIZATION_ALPHA,
  ]);
  const redirect = sameOriginRedirect(baseURL, "email-code");
  await openAuthV2(page, authUrl("/v2/sign-in", redirect));
  await submitSignInIdentifier(page, identity.email);
  await authV2Root(page)
    .getByRole("button", { name: /use another method/i })
    .click();
  await chooseSignInMethod(page, "email-code");
  const code = authV2Input(page, "code");
  await expect(code).toBeVisible();
  await code.fill(AUTH_V2_TEST_OTP);
  await code.press("Enter");
  await finishAuthV2Continuation(page, redirect, ORGANIZATION_ALPHA);
});

test("password reset completes through email verification", async ({
  authV2Resources,
  baseURL,
  page,
}) => {
  const identity = await authV2Resources.createPasswordIdentity([
    ORGANIZATION_ALPHA,
  ]);
  const newPassword = authV2Resources.createPassword();
  const redirect = sameOriginRedirect(baseURL, "password-reset");
  await openAuthV2(page, authUrl("/v2/sign-in", redirect));
  await submitSignInIdentifier(page, identity.email);
  await authV2Root(page)
    .getByRole("button", { name: /forgot password/i })
    .click();
  await chooseSignInMethod(page, "password-reset");
  const code = authV2Input(page, "code");
  await expect(code).toBeVisible();
  await code.fill(AUTH_V2_TEST_OTP);
  await code.press("Enter");

  const newPasswordInput = authV2Input(page, "new-password");
  const confirmation = authV2Input(page, "confirm-password");
  await expect(newPasswordInput).toBeVisible();
  await newPasswordInput.fill(newPassword);
  await confirmation.fill(newPassword);
  await confirmation.press("Enter");
  await finishAuthV2Continuation(page, redirect, ORGANIZATION_ALPHA);
});

test("progressive sign-up activates without optional profile fields", async ({
  authV2Resources,
  baseURL,
  page,
}) => {
  const emailAddress = authV2Resources.allocateEmail();
  const password = authV2Resources.createPassword();
  const redirect = sameOriginRedirect(baseURL, "sign-up");
  await openAuthV2(page, authUrl("/v2/sign-up", redirect));
  const email = authV2Input(page, "email-address");
  const passwordInput = authV2Input(page, "password");
  await expect(email).toBeVisible();
  await expect(authV2Input(page, "first-name")).toHaveCount(0);
  await expect(authV2Input(page, "last-name")).toHaveCount(0);
  await email.fill(emailAddress);
  await passwordInput.fill(password);
  const legal = authV2Root(page).getByRole("checkbox");
  if (await legal.isVisible()) {
    await legal.check();
  }
  await passwordInput.press("Enter");

  const code = authV2Input(page, "code");
  await expect(code).toBeVisible();
  await code.fill(AUTH_V2_TEST_OTP);
  await code.press("Enter");
  await waitForActivatedSessionOrRedirect(page, redirect);
  await expectNoOrganizationCreation(page);
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
  await waitForSignedInAccount(page, identity.email);

  await openAuthV2(page, authUrl("/v2/sign-in", redirect));
  const account = authV2Root(page).getByRole("button", {
    name: identity.email,
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
  try {
    await expect
      .poll(
        async () => {
          return (
            new URL(page.url()).pathname === redirect.pathname ||
            (await organization.isVisible())
          );
        },
        { timeout: 30_000 },
      )
      .toBe(true);
  } catch {
    throw new Error(
      `Auth v2 continuation did not settle: ${JSON.stringify(
        await authV2ContinuationDiagnostics(page, redirect, organization),
      )}`,
    );
  }
  await expectNoOrganizationCreation(page);
  if (new URL(page.url()).pathname !== redirect.pathname) {
    await continueWithOrganization(page, organizationName);
    await waitForPathname(page, redirect.pathname);
  }
  expect(new URL(page.url()).searchParams.get("auth_v2_e2e")).toBe(
    redirect.searchParams.get("auth_v2_e2e"),
  );
}

async function authV2ContinuationDiagnostics(
  page: Page,
  redirect: URL,
  organization: Locator,
): Promise<Record<string, boolean | null | string>> {
  const currentUrl = new URL(page.url());
  const alert = authV2Root(page).getByRole("alert").first();
  const alertText = (await alert.isVisible())
    ? sanitizeAuthV2DiagnosticText(await alert.innerText())
    : null;
  const clerkState = await page.evaluate(() => {
    const clerk = window.Clerk as unknown as {
      readonly client?: {
        readonly signIn?: {
          readonly createdSessionId?: unknown;
          readonly status?: unknown;
        };
      };
      readonly session?: {
        readonly currentTask?: unknown;
        readonly status?: unknown;
      };
    };
    const currentTask = clerk?.session?.currentTask;
    return {
      clientSignInHasCreatedSession:
        typeof clerk?.client?.signIn?.createdSessionId === "string",
      clientSignInStatus:
        typeof clerk?.client?.signIn?.status === "string"
          ? clerk.client.signIn.status
          : null,
      sessionStatus:
        typeof clerk?.session?.status === "string"
          ? clerk.session.status
          : null,
      sessionTask:
        currentTask &&
        typeof currentTask === "object" &&
        "key" in currentTask &&
        typeof currentTask.key === "string"
          ? currentTask.key
          : null,
    };
  });
  return {
    alert: alertText,
    clientSignInHasCreatedSession: clerkState.clientSignInHasCreatedSession,
    clientSignInStatus: clerkState.clientSignInStatus,
    currentPathname: currentUrl.pathname,
    organizationChooserVisible: await authV2Root(page)
      .getByRole("heading", { name: /choose an organization/i })
      .isVisible(),
    requestedOrganizationVisible: await organization.isVisible(),
    redirectReached: currentUrl.pathname === redirect.pathname,
    sessionStatus: clerkState.sessionStatus,
    sessionTask: clerkState.sessionTask,
  };
}

function sanitizeAuthV2DiagnosticText(value: string): string {
  return value
    .replace(/[\w.+-]+@[\w.-]+/g, "[masked-email]")
    .replace(/\b(?:org|sess|sia|sua|user)_[\w-]+\b/g, "[masked-clerk-id]")
    .replace(/https?:\/\/\S+/g, "[masked-url]")
    .slice(0, 240);
}

async function waitForActivatedSessionOrRedirect(
  page: Page,
  redirect: URL,
): Promise<void> {
  await page.waitForFunction(
    (redirectPathname) => {
      return (
        window.location.pathname === redirectPathname ||
        Boolean(
          window.Clerk?.client?.signUp.status === "complete" &&
          window.Clerk.session,
        )
      );
    },
    redirect.pathname,
    { timeout: 5_000 },
  );
}

async function waitForSignedInAccount(
  page: Page,
  emailAddress: string,
): Promise<void> {
  await page.waitForFunction(
    (expectedEmailAddress) => {
      return Boolean(
        window.Clerk?.client?.signedInSessions.some(
          (session) =>
            session.user.primaryEmailAddress?.emailAddress ===
            expectedEmailAddress,
        ),
      );
    },
    emailAddress,
    { timeout: 5_000 },
  );
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
