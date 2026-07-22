import { clerk } from "@clerk/testing/playwright";
import type { Page } from "@playwright/test";

export interface HostedAuthSession {
  readonly token: string;
}

export interface HostedAuthOptions {
  readonly followRedirect?: boolean;
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

export async function signInThroughHostedAuth(
  page: Page,
  email: string,
  appUrl: string,
  options: HostedAuthOptions = {},
): Promise<HostedAuthSession> {
  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  await page.waitForURL((url) => url.pathname.includes("/sign-in"), {
    timeout: 30_000,
  });

  const authUrl = page.url();
  const redirectUrl = redirectUrlFromAuthUrl(new URL(authUrl));
  return await signInWithClerkTestingHelper(
    page,
    email,
    appUrl,
    authUrl,
    redirectUrl,
    options,
  );
}

export async function signInFromCurrentHostedAuthPage(
  page: Page,
  email: string,
  options: HostedAuthOptions = {},
): Promise<HostedAuthSession> {
  const authUrl = page.url();
  const appUrl = new URL(authUrl).origin;
  const redirectUrl = redirectUrlFromAuthUrl(new URL(authUrl));
  return await signInWithClerkTestingHelper(
    page,
    email,
    appUrl,
    authUrl,
    redirectUrl,
    options,
  );
}

async function signInWithClerkTestingHelper(
  page: Page,
  email: string,
  appUrl: string,
  authUrl: string,
  redirectUrl: string | null,
  options: HostedAuthOptions,
): Promise<HostedAuthSession> {
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
    authUrl,
    email,
    redirectUrl,
    ...clerkStateBefore,
  });

  await clerk.signIn({ page, emailAddress: email });
  await page.waitForFunction(() => Boolean(window.Clerk?.session), undefined, {
    timeout: 30_000,
  });
  if (options.activeOrganizationId) {
    await page.evaluate(async (organizationId) => {
      await window.Clerk?.setActive({ organization: organizationId });
    }, options.activeOrganizationId);
    await gotoAboutBlankAfterClerkNavigation(page);
    await page.goto(helperUrl.toString(), { waitUntil: "domcontentloaded" });
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

  if (redirectUrl && options.followRedirect !== false) {
    await page.goto(redirectUrl, { waitUntil: "domcontentloaded" });
  } else {
    await gotoAboutBlankAfterClerkNavigation(page);
  }

  return { token };
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

function redirectUrlFromAuthUrl(url: URL): string | null {
  const searchRedirect = url.searchParams.get("redirect_url");
  if (searchRedirect) {
    return searchRedirect;
  }

  const hashQueryStart = url.hash.indexOf("?");
  if (hashQueryStart === -1) {
    return null;
  }

  return new URLSearchParams(url.hash.slice(hashQueryStart + 1)).get(
    "redirect_url",
  );
}
