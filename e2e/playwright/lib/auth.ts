import { expect, type Locator, type Page } from "@playwright/test";

import { waitForClerkReadiness } from "./clerk-readiness";

const CLERK_TEST_EMAIL_CODE = "424242";
const CLERK_UI_READY_TIMEOUT_MS = 30_000;
const CLERK_OTP_INPUT_SELECTOR =
  'input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]';

export interface ClerkEmailCodeSignInOptions {
  readonly activeOrganizationId: string;
}

function hostedSignIn(page: Page): Locator {
  return page.locator(".cl-signIn-root");
}

export async function signInWithClerkEmailCode(
  page: Page,
  email: string,
  appUrl: string,
  options: ClerkEmailCodeSignInOptions,
): Promise<string> {
  const signInUrl = new URL("/sign-in", appUrl);
  await openHostedSignIn(page, signInUrl.toString());
  await submitSignInIdentifier(page, email);
  await submitClerkEmailCode(page);
  await page.waitForURL(
    (url) =>
      url.origin === signInUrl.origin && !url.pathname.startsWith("/sign-in"),
    { timeout: 30_000, waitUntil: "domcontentloaded" },
  );
  await waitForClerkReadiness(
    page,
    "the Clerk client to load and expose a session on the page reached after email-code sign-in",
    () =>
      page.waitForFunction(
        () => Boolean(window.Clerk?.loaded && window.Clerk.session),
        undefined,
        { timeout: 30_000 },
      ),
  );
  await activateClerkOrganization(page, options.activeOrganizationId);
  await waitForClerkReadiness(
    page,
    `Clerk to activate organization ${options.activeOrganizationId}`,
    () =>
      page.waitForFunction(
        (organizationId) => {
          return Boolean(
            window.Clerk?.loaded &&
            window.Clerk.session &&
            window.Clerk.organization?.id === organizationId,
          );
        },
        options.activeOrganizationId,
        { timeout: 30_000 },
      ),
  );

  const token = await refreshClerkSessionToken(page, {
    activeOrganizationId: options.activeOrganizationId,
  });
  return token;
}

/**
 * The hosted Clerk form mounts once the core, the hosted UI script, and the
 * environment have all loaded, so readiness is the identifier field itself.
 */
async function openHostedSignIn(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("app-auth-layout")).toBeVisible({
    timeout: CLERK_UI_READY_TIMEOUT_MS,
  });
  await expect(
    hostedSignIn(page).locator('input[name="identifier"]'),
  ).toBeVisible({ timeout: CLERK_UI_READY_TIMEOUT_MS });
}

async function submitSignInIdentifier(
  page: Page,
  identifier: string,
): Promise<void> {
  const input = hostedSignIn(page).locator('input[name="identifier"]');
  await input.fill(identifier);
  await input.press("Enter");
}

async function submitClerkEmailCode(page: Page): Promise<void> {
  const root = hostedSignIn(page);
  const codeInput = root.locator(CLERK_OTP_INPUT_SELECTOR).first();
  const emailCodeButton = root
    .getByRole("button", { name: /email code/i })
    .first();
  const useAnotherMethod = root.getByText(/use another method/i).first();

  await expect(codeInput.or(emailCodeButton).or(useAnotherMethod)).toBeVisible({
    timeout: CLERK_UI_READY_TIMEOUT_MS,
  });
  if (!(await codeInput.isVisible())) {
    if (await useAnotherMethod.isVisible()) {
      await useAnotherMethod.click();
    }
    await expect(emailCodeButton).toBeVisible({
      timeout: CLERK_UI_READY_TIMEOUT_MS,
    });
    await emailCodeButton.click();
  }

  await expect(codeInput).toBeVisible({ timeout: CLERK_UI_READY_TIMEOUT_MS });
  // Clerk verifies the code as soon as the last digit arrives.
  await codeInput.click();
  await page.keyboard.type(CLERK_TEST_EMAIL_CODE);
}

async function activateClerkOrganization(
  page: Page,
  organizationId: string,
): Promise<void> {
  const activeOrganizationId = await page.evaluate(() => {
    return window.Clerk?.organization?.id ?? null;
  });
  if (activeOrganizationId === organizationId) {
    return;
  }

  await page.evaluate((targetOrganizationId) => {
    const clerk = window.Clerk;
    if (!clerk?.session) {
      throw new Error("Clerk session unavailable for organization activation");
    }
    void clerk.setActive({ organization: targetOrganizationId });
  }, organizationId);
}

export async function refreshClerkSessionToken(
  page: Page,
  options: { readonly activeOrganizationId?: string } = {},
): Promise<string> {
  await waitForClerkReadiness(
    page,
    "a Clerk session before refreshing its token",
    () =>
      page.waitForFunction(() => Boolean(window.Clerk?.session), undefined, {
        timeout: 30_000,
      }),
  );
  if (options.activeOrganizationId) {
    await waitForClerkReadiness(
      page,
      `Clerk to report organization ${options.activeOrganizationId} before refreshing its token`,
      () =>
        page.waitForFunction(
          (organizationId) => window.Clerk?.organization?.id === organizationId,
          options.activeOrganizationId,
          { timeout: 30_000 },
        ),
    );
  }
  const token = await page.evaluate(async () => {
    return (await window.Clerk?.session?.getToken({ skipCache: true })) ?? null;
  });
  if (!token) {
    throw new Error("Clerk session token unavailable after refresh");
  }
  return token;
}
