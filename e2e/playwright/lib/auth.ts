import type { Page } from "@playwright/test";

import { createSignInTokenForEmail } from "./clerk-api";

export interface ClerkSignInTokenOptions {
  readonly activeOrganizationId: string;
  readonly preserveAppPage?: boolean;
}

export async function signInWithClerkSignInToken(
  page: Page,
  email: string,
  appUrl: string,
  options: ClerkSignInTokenOptions,
): Promise<string> {
  const signInToken = await createSignInTokenForEmail(
    email,
    options.activeOrganizationId,
  );
  const signInUrl = new URL("/sign-in-token", appUrl);
  signInUrl.searchParams.set("token", signInToken);

  await page.goto(signInUrl.toString(), { waitUntil: "domcontentloaded" });
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
  if (options.preserveAppPage) {
    await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  } else {
    await page.goto("about:blank");
  }
  return token;
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
