import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import {
  errors,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
  type Request,
  type Response,
  type Route,
} from "@playwright/test";

const CLERK_BOOTSTRAP_TIMEOUTS_MS = [15_000, 30_000] as const;

type ClerkBootstrapTimeouts = readonly [number, number];

interface ClerkBootstrapRequest {
  readonly method: string;
  readonly path: string;
  readonly status: number | "failed" | "pending";
}

interface ClerkBootstrapState {
  readonly hasClerk: boolean;
  readonly hasLoadedClerk: boolean;
}

interface LoadedClerkAttempt {
  readonly loaded: true;
  readonly page: Page;
}

interface TimedOutClerkAttempt {
  readonly cause: Error;
  readonly diagnostic: string;
  readonly loaded: false;
}

type ClerkBootstrapAttempt = LoadedClerkAttempt | TimedOutClerkAttempt;

interface LoadedClerkContext {
  readonly context: BrowserContext;
  readonly page: Page;
}

export interface ClerkTestingSignInOptions {
  readonly activeOrganizationId?: string;
  readonly preserveAppPage?: boolean;
}

export interface ClerkSessionTokenCache {
  refreshedAt: number;
  token: string;
}

export interface CurrentClerkSessionTokenOptions {
  readonly activeOrganizationId?: string;
  readonly reuseMs: number;
}

export interface LoadedClerkTestingPageOptions {
  readonly appUrl: string;
  readonly bootstrapTimeoutsMs?: ClerkBootstrapTimeouts;
  readonly contextOptions: BrowserContextOptions;
}

export async function withLoadedClerkTestingPage<Result>(
  browser: Browser,
  options: LoadedClerkTestingPageOptions,
  use: (page: Page) => Promise<Result>,
): Promise<Result> {
  const { context, page } = await createLoadedClerkContext(browser, options);
  try {
    return await use(page);
  } finally {
    await context.close();
  }
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

export async function getCurrentClerkSessionToken(
  page: Page,
  cache: ClerkSessionTokenCache,
  options: CurrentClerkSessionTokenOptions,
): Promise<string> {
  if (Date.now() - cache.refreshedAt < options.reuseMs) {
    return cache.token;
  }
  const token = await refreshClerkSessionToken(page, {
    activeOrganizationId: options.activeOrganizationId,
  });
  cache.refreshedAt = Date.now();
  cache.token = token;
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
  return signInWithLoadedClerkTestingHelper(page, email, appUrl, options);
}

export async function signInWithLoadedClerkTestingHelper(
  page: Page,
  email: string,
  appUrl: string,
  options: ClerkTestingSignInOptions,
): Promise<string> {
  const helperUrl = new URL("/_/skeleton", appUrl);
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

  // Generated E2E identities are Clerk testing emails. Keep sign-in on the
  // testing-token FAPI path instead of adding Backend API lookup/token calls.
  await clerk.signIn({
    page,
    signInParams: { strategy: "email_code", identifier: email },
  });
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

  if (!options.preserveAppPage) {
    await gotoAboutBlankAfterClerkNavigation(page);
  }
  return token;
}

async function createLoadedClerkContext(
  browser: Browser,
  options: LoadedClerkTestingPageOptions,
): Promise<LoadedClerkContext> {
  const timeouts = options.bootstrapTimeoutsMs ?? CLERK_BOOTSTRAP_TIMEOUTS_MS;

  for (const [attempt, timeout] of timeouts.entries()) {
    const context = await browser.newContext(options.contextOptions);
    let result: ClerkBootstrapAttempt;
    try {
      result = await loadClerkInContext(context, options.appUrl, timeout);
    } catch (error) {
      await context.close();
      throw error;
    }

    if (result.loaded) {
      return { context, page: result.page };
    }

    await context.close();
    if (attempt === timeouts.length - 1) {
      throw new Error(
        `Clerk bootstrap timed out after ${timeouts.length} attempts: ${result.diagnostic}`,
        { cause: result.cause },
      );
    }
    console.warn(
      `[e2e] Clerk bootstrap stalled; recreating context: ${result.diagnostic}`,
    );
  }

  throw new Error("Clerk bootstrap attempts exhausted");
}

async function loadClerkInContext(
  context: BrowserContext,
  appUrl: string,
  timeout: number,
): Promise<ClerkBootstrapAttempt> {
  await setupClerkTestingToken({ context });
  const frontendApi = process.env.CLERK_FAPI;
  if (!frontendApi) {
    throw new Error("CLERK_FAPI environment variable is required");
  }
  const frontendApiHost = new URL(`https://${frontendApi}`).host;
  let lastRequest: ClerkBootstrapRequest | undefined;
  const recordRequest = (request: Request): void => {
    const path = clerkFrontendApiPath(request, frontendApiHost);
    if (path) {
      lastRequest = { method: request.method(), path, status: "pending" };
    }
  };
  const recordResponse = (response: Response): void => {
    const request = response.request();
    const path = clerkFrontendApiPath(request, frontendApiHost);
    if (path) {
      lastRequest = {
        method: request.method(),
        path,
        status: response.status(),
      };
    }
  };
  const recordFailedRequest = (request: Request): void => {
    const path = clerkFrontendApiPath(request, frontendApiHost);
    if (path) {
      lastRequest = { method: request.method(), path, status: "failed" };
    }
  };

  context.on("request", recordRequest);
  context.on("response", recordResponse);
  context.on("requestfailed", recordFailedRequest);
  try {
    const page = await context.newPage();
    const helperUrl = new URL("/_/skeleton", appUrl);
    await page.goto(helperUrl.toString(), { waitUntil: "domcontentloaded" });
    try {
      await page.waitForFunction(
        () => Boolean(window.Clerk?.loaded),
        undefined,
        { timeout },
      );
      return { loaded: true, page };
    } catch (error) {
      if (!(error instanceof errors.TimeoutError)) {
        throw error;
      }
      const state = await page.evaluate<ClerkBootstrapState>(() => {
        return {
          hasClerk: window.Clerk !== undefined,
          hasLoadedClerk: Boolean(window.Clerk?.loaded),
        };
      });
      return {
        cause: error,
        diagnostic: formatClerkBootstrapDiagnostic(state, lastRequest),
        loaded: false,
      };
    }
  } finally {
    context.off("request", recordRequest);
    context.off("response", recordResponse);
    context.off("requestfailed", recordFailedRequest);
  }
}

function clerkFrontendApiPath(
  request: Request,
  frontendApiHost: string,
): string | undefined {
  const url = new URL(request.url());
  if (url.host === frontendApiHost && url.pathname.startsWith("/v1/")) {
    return url.pathname;
  }
  return undefined;
}

function formatClerkBootstrapDiagnostic(
  state: ClerkBootstrapState,
  lastRequest: ClerkBootstrapRequest | undefined,
): string {
  const clerkState = state.hasLoadedClerk
    ? "ClerkJS loaded after wait timeout"
    : state.hasClerk
      ? "ClerkJS present but not loaded"
      : "ClerkJS absent";
  if (!lastRequest) {
    return clerkState;
  }
  return `${clerkState}; last Clerk request: ${lastRequest.method} ${lastRequest.path} -> ${lastRequest.status}`;
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
