import { clerk } from "@clerk/testing/playwright";
import type { Page } from "@playwright/test";

export interface HostedAuthSession {
  readonly token: string;
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
  await page.evaluate(async () => {
    await window.Clerk?.session?.getToken({ skipCache: true });
  });
}

export async function signInThroughHostedAuth(
  page: Page,
  email: string,
  appUrl: string,
  options: {
    readonly followRedirect?: boolean;
    readonly activeOrganizationId?: string;
    readonly mirrorStorageToUrls?: readonly string[];
  } = {},
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

async function signInWithClerkTestingHelper(
  page: Page,
  email: string,
  appUrl: string,
  authUrl: string,
  redirectUrl: string | null,
  options: {
    readonly followRedirect?: boolean;
    readonly activeOrganizationId?: string;
    readonly mirrorStorageToUrls?: readonly string[];
  },
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
    await page.goto("about:blank", { waitUntil: "domcontentloaded" });
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

  for (const targetUrl of options.mirrorStorageToUrls ?? []) {
    await mirrorBrowserStateToUrl(page, appUrl, targetUrl);
  }

  if (redirectUrl && options.followRedirect !== false) {
    await page.goto(redirectUrl, { waitUntil: "domcontentloaded" });
  } else {
    await page.goto("about:blank", { waitUntil: "domcontentloaded" });
  }

  return { token };
}

async function mirrorBrowserStateToUrl(
  page: Page,
  sourceUrl: string,
  targetUrl: string,
): Promise<void> {
  const targetOrigin = new URL(targetUrl).origin;
  const storage = await page.evaluate(() => {
    return {
      localStorageEntries: Object.entries(window.localStorage),
      sessionStorageEntries: Object.entries(window.sessionStorage),
    };
  });
  await page.addInitScript(
    (snapshot: {
      readonly targetOrigin: string;
      readonly localStorageEntries: readonly (readonly [string, string])[];
      readonly sessionStorageEntries: readonly (readonly [string, string])[];
    }) => {
      if (window.location.origin !== snapshot.targetOrigin) {
        return;
      }
      for (const [key, value] of snapshot.localStorageEntries) {
        window.localStorage.setItem(key, value);
      }
      for (const [key, value] of snapshot.sessionStorageEntries) {
        window.sessionStorage.setItem(key, value);
      }
    },
    { targetOrigin, ...storage },
  );

  const cookies = await page.context().cookies(sourceUrl);
  await page.context().addCookies(
    cookies.map((cookie) => {
      return {
        name: cookie.name,
        value: cookie.value,
        url: targetOrigin,
        expires: cookie.expires,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite,
      };
    }),
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
