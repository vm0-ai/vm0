import { clerk } from "@clerk/testing/playwright";
import { errors, type Page, type Route } from "@playwright/test";

const CLERK_BOOTSTRAP_TIMEOUTS_MS = [15_000, 30_000] as const;

export interface ClerkTestingSignInOptions {
  readonly activeOrganizationId?: string;
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

export async function signInWithClerkTestingHelper(
  page: Page,
  email: string,
  appUrl: string,
  options: ClerkTestingSignInOptions,
): Promise<string> {
  const helperUrl = new URL("/_/skeleton", appUrl);
  await navigateToLoadedClerk(page, helperUrl);
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
    await activateClerkOrganization(
      page,
      helperUrl,
      options.activeOrganizationId,
    );
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
  return token;
}

async function activateClerkOrganization(
  page: Page,
  helperUrl: URL,
  organizationId: string,
): Promise<void> {
  let resolveActivationFinished!: () => void;
  const activationFinished = new Promise<void>((resolve) => {
    resolveActivationFinished = resolve;
  });
  const routePattern = `${helperUrl.origin}/**`;
  const holdPostActivationNavigation = async (route: Route): Promise<void> => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      request.isNavigationRequest() &&
      request.frame() === page.mainFrame() &&
      url.origin === helperUrl.origin &&
      url.pathname !== helperUrl.pathname
    ) {
      // The app reloads after the Clerk organization event. Keep the old
      // document alive until Playwright receives the setActive result.
      await activationFinished;
    }
    await route.continue();
  };

  await page.route(routePattern, holdPostActivationNavigation);
  try {
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
      (async () => {
        try {
          await page.evaluate(async (targetOrganizationId) => {
            await window.Clerk?.setActive({
              organization: targetOrganizationId,
            });
          }, organizationId);
        } finally {
          resolveActivationFinished();
        }
      })(),
    ]);
  } finally {
    resolveActivationFinished();
    await page.unroute(routePattern, holdPostActivationNavigation);
  }
}

async function navigateToLoadedClerk(
  page: Page,
  helperUrl: URL,
): Promise<void> {
  for (const [attempt, timeout] of CLERK_BOOTSTRAP_TIMEOUTS_MS.entries()) {
    await page.goto(helperUrl.toString(), { waitUntil: "domcontentloaded" });
    try {
      await page.waitForFunction(
        () => Boolean(window.Clerk?.loaded),
        undefined,
        {
          timeout,
        },
      );
      return;
    } catch (error) {
      if (
        !(error instanceof errors.TimeoutError) ||
        attempt === CLERK_BOOTSTRAP_TIMEOUTS_MS.length - 1
      ) {
        throw error;
      }
      // Clerk's testing-token route allows a single FAPI fetch to consume 30s.
      // Retry sooner, then retain the original 30s tolerance on the final attempt.
      console.warn("[e2e] Clerk bootstrap stalled; retrying navigation");
    }
  }
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
