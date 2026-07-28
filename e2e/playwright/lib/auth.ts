import { clerk } from "@clerk/testing/playwright";
import type { Page } from "@playwright/test";

export interface ClerkTestingSignInOptions {
  readonly activeOrganizationId?: string;
}

export async function refreshClerkSessionToken(
  page: Page,
  options: { readonly activeOrganizationId?: string } = {},
): Promise<void> {
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
  const tokenRefreshed = await page.evaluate(async () => {
    return Boolean(await window.Clerk?.session?.getToken({ skipCache: true }));
  });
  if (!tokenRefreshed) {
    throw new Error("Clerk session token unavailable after refresh");
  }
}

export async function signInWithClerkTestingHelper(
  page: Page,
  email: string,
  appUrl: string,
  options: ClerkTestingSignInOptions,
): Promise<void> {
  const helperUrl = new URL("/_/skeleton", appUrl);
  await page.goto(helperUrl.toString(), { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.Clerk?.loaded), undefined, {
    timeout: 30_000,
  });
  const clerkStateBefore = await page.evaluate(() => {
    return {
      hasLoadedClerk: Boolean(window.Clerk?.loaded),
      hasSession: Boolean(window.Clerk?.session),
      hasUser: Boolean(window.Clerk?.user),
    };
  });

  console.log("[e2e] signing in with Clerk testing helper", {
    currentUrl: page.url(),
    email,
    ...clerkStateBefore,
  });

  await clerk.signIn({ page, emailAddress: email });
  await page.waitForFunction(() => Boolean(window.Clerk?.session), undefined, {
    timeout: 30_000,
  });
  if (options.activeOrganizationId) {
    // Activating the organization lets the skeleton route redirect to the app.
    // Observe that redirect before setActive so it cannot race the token read.
    await Promise.all([
      page.waitForURL(
        (url) =>
          url.origin === helperUrl.origin &&
          url.pathname !== helperUrl.pathname,
        {
          timeout: 30_000,
          waitUntil: "domcontentloaded",
        },
      ),
      page.evaluate(async (organizationId) => {
        await window.Clerk?.setActive({ organization: organizationId });
      }, options.activeOrganizationId),
    ]);
    await page.waitForFunction(
      () => Boolean(window.Clerk?.loaded && window.Clerk?.session),
      undefined,
      { timeout: 30_000 },
    );
    await page.waitForFunction(
      (organizationId) => window.Clerk?.organization?.id === organizationId,
      options.activeOrganizationId,
      { timeout: 30_000 },
    );
  }

  const clerkState = await page.evaluate(() => {
    return {
      hasSession: Boolean(window.Clerk?.session),
      hasUser: Boolean(window.Clerk?.user),
    };
  });
  const token = await page.evaluate(async () => {
    return (await window.Clerk?.session?.getToken({ skipCache: true })) ?? null;
  });
  if (!token) {
    throw new Error("Clerk session token unavailable after sign-in");
  }
  console.log("[e2e] Clerk testing helper completed", {
    currentUrl: page.url(),
    ...clerkState,
  });

  await gotoAboutBlankAfterClerkNavigation(page);
}

async function gotoAboutBlankAfterClerkNavigation(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.goto("about:blank", { waitUntil: "domcontentloaded" });
      return;
    } catch (error) {
      if (!isAboutBlankInterruptedByRedirect(error) || attempt === 2) {
        throw error;
      }
      await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
    }
  }
}

function isAboutBlankInterruptedByRedirect(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes(
      'Navigation to "about:blank" is interrupted by another navigation',
    )
  );
}
