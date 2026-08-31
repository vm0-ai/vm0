import { expect, type Page } from "@playwright/test";

import {
  authV2Input,
  authV2Root,
  openAuthV2,
  signInMethodButton,
  submitSignInIdentifier,
} from "./auth-v2-ui";

const CLERK_TEST_EMAIL_CODE = "424242";

export interface ClerkEmailCodeSignInOptions {
  readonly activeOrganizationId: string;
}

export async function signInWithClerkEmailCode(
  page: Page,
  email: string,
  appUrl: string,
  options: ClerkEmailCodeSignInOptions,
): Promise<string> {
  const signInUrl = new URL("/sign-in", appUrl);
  await openAuthV2(page, signInUrl.toString());
  await submitSignInIdentifier(page, email);
  await submitClerkEmailCode(page);
  await page.waitForURL(
    (url) =>
      url.origin === signInUrl.origin && !url.pathname.startsWith("/sign-in"),
    { timeout: 30_000, waitUntil: "domcontentloaded" },
  );
  await page.waitForFunction(
    () => Boolean(window.Clerk?.loaded && window.Clerk.session),
    undefined,
    { timeout: 30_000 },
  );
  await activateClerkOrganization(page, options.activeOrganizationId);
  await page.waitForFunction(
    (organizationId) => {
      return Boolean(
        window.Clerk?.loaded &&
        window.Clerk.session &&
        window.Clerk.organization?.id === organizationId,
      );
    },
    options.activeOrganizationId,
    { timeout: 30_000 },
  );

  const token = await refreshClerkSessionToken(page, {
    activeOrganizationId: options.activeOrganizationId,
  });
  return token;
}

async function submitClerkEmailCode(page: Page): Promise<void> {
  const root = authV2Root(page);
  const codeInput = authV2Input(page, "code");
  const emailCodeButton = signInMethodButton(page, "email-code");
  const useAnotherMethodButton = root.getByRole("button", {
    name: /use another method/i,
  });

  await expect(
    codeInput.or(emailCodeButton).or(useAnotherMethodButton),
  ).toBeVisible({ timeout: 30_000 });
  if (!(await codeInput.isVisible())) {
    if (await useAnotherMethodButton.isVisible()) {
      await useAnotherMethodButton.click();
    }
    await expect(emailCodeButton).toBeVisible({ timeout: 30_000 });
    await emailCodeButton.click();
  }

  await expect(codeInput).toBeVisible({ timeout: 30_000 });
  await codeInput.fill(CLERK_TEST_EMAIL_CODE);
  await root.getByRole("button", { exact: true, name: "Continue" }).click();
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
  await page.waitForFunction(() => Boolean(window.Clerk?.session), undefined, {
    timeout: 30_000,
  });
  if (options.activeOrganizationId) {
    await page.waitForFunction(
      (organizationId) => window.Clerk?.organization?.id === organizationId,
      options.activeOrganizationId,
      { timeout: 30_000 },
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
