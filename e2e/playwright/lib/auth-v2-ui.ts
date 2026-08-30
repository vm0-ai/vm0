import {
  errors,
  expect,
  type Locator,
  type Page,
  type Request,
  type Response,
} from "@playwright/test";

export type AuthV2InputName =
  | "code"
  | "confirm-password"
  | "email-address"
  | "first-name"
  | "identifier"
  | "last-name"
  | "new-password"
  | "password";

export type AuthV2SignInMethod =
  | "email-code"
  | "google"
  | "passkey"
  | "password"
  | "password-reset";

const SIGN_IN_METHOD_NAMES: Record<AuthV2SignInMethod, RegExp> = {
  "email-code": /email code/i,
  google: /google/i,
  passkey: /passkey/i,
  password: /^sign in with your password$/i,
  "password-reset": /^reset your password$/i,
};

const AUTH_V2_BOOTSTRAP_TIMEOUT_MS = 15_000;
const CLERK_RESOURCE_PATH_SEGMENT = /\/(?:org|sess|sia|sua|user)_[^/]*/gu;

type AuthV2BootstrapRequestStatus = number | "failed" | "pending";

interface AuthV2BootstrapRequest {
  readonly method: string;
  readonly path: string;
  readonly status: AuthV2BootstrapRequestStatus;
}

interface AuthV2BootstrapOptions {
  readonly timeoutMs?: number;
}

interface AuthV2BootstrapState {
  readonly hasClerk: boolean;
  readonly hasLoadedClerk: boolean;
}

export function authV2Root(page: Page): Locator {
  return page.getByTestId("app-auth-v2");
}

export function authV2Input(page: Page, name: AuthV2InputName): Locator {
  return authV2Root(page).locator(`input[name="${name}"]`);
}

export async function openAuthV2(
  page: Page,
  url: string,
  options: AuthV2BootstrapOptions = {},
): Promise<void> {
  await navigateToReadyAuthV2(
    page,
    async () => page.goto(url, { waitUntil: "domcontentloaded" }),
    options,
  );
}

export async function reloadAuthV2(
  page: Page,
  options: AuthV2BootstrapOptions = {},
): Promise<void> {
  await navigateToReadyAuthV2(
    page,
    async () => page.reload({ waitUntil: "domcontentloaded" }),
    options,
  );
}

export async function submitSignInIdentifier(
  page: Page,
  identifier: string,
): Promise<void> {
  const input = authV2Input(page, "identifier");
  await expect(input).toBeVisible();
  await input.fill(identifier);
  await input.press("Enter");
}

export function signInMethodButton(
  page: Page,
  method: AuthV2SignInMethod,
): Locator {
  return authV2Root(page)
    .getByRole("button", { name: SIGN_IN_METHOD_NAMES[method] })
    .first();
}

export async function chooseSignInMethod(
  page: Page,
  method: AuthV2SignInMethod,
): Promise<void> {
  const button = signInMethodButton(page, method);
  await expect(button).toBeVisible();
  await button.click();
}

export async function expectStepAnnouncement(page: Page): Promise<void> {
  const announcer = page.getByTestId("auth-v2-announcer");
  await expect(announcer).not.toHaveText("");
}

export async function expectNoOrganizationCreation(page: Page): Promise<void> {
  await expect(
    authV2Root(page).getByText(/create (an )?organization/i),
  ).toHaveCount(0);
}

export async function continueWithOrganization(
  page: Page,
  organizationName: string,
): Promise<void> {
  const button = authV2Root(page).getByRole("button", {
    name: organizationName,
  });
  await expect(button).toBeVisible();
  await expectNoOrganizationCreation(page);
  await button.click();
}

export async function waitForPathname(
  page: Page,
  pathname: string,
): Promise<void> {
  await page.waitForURL((url) => url.pathname === pathname, {
    waitUntil: "domcontentloaded",
  });
}

async function navigateToReadyAuthV2(
  page: Page,
  navigate: () => Promise<Response | null>,
  options: AuthV2BootstrapOptions,
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? AUTH_V2_BOOTSTRAP_TIMEOUT_MS;
  const frontendApiHost = clerkFrontendApiHost();
  let lastRequest: AuthV2BootstrapRequest | undefined;
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

  page.on("request", recordRequest);
  page.on("response", recordResponse);
  page.on("requestfailed", recordFailedRequest);
  try {
    await navigate();
    try {
      await page.waitForFunction(
        () => Boolean(window.Clerk?.loaded),
        undefined,
        { timeout: timeoutMs },
      );
    } catch (error) {
      if (!(error instanceof errors.TimeoutError)) {
        throw error;
      }
      const state = await page.evaluate<AuthV2BootstrapState>(() => {
        return {
          hasClerk: window.Clerk !== undefined,
          hasLoadedClerk: Boolean(window.Clerk?.loaded),
        };
      });
      throw new Error(
        `Auth v2 bootstrap timed out after ${timeoutMs}ms: ${formatAuthV2BootstrapDiagnostic(
          state,
          lastRequest,
        )}`,
        { cause: error },
      );
    }
  } finally {
    page.off("request", recordRequest);
    page.off("response", recordResponse);
    page.off("requestfailed", recordFailedRequest);
  }

  await expect(authV2Root(page)).toBeVisible();
  await expect(page.getByTestId("app-auth-layout")).toBeVisible();
}

function clerkFrontendApiHost(): string {
  const frontendApi = process.env.CLERK_FAPI;
  if (!frontendApi) {
    throw new Error("CLERK_FAPI environment variable is required");
  }
  return new URL(`https://${frontendApi}`).host;
}

function clerkFrontendApiPath(
  request: Request,
  frontendApiHost: string,
): string | undefined {
  const url = new URL(request.url());
  if (url.host !== frontendApiHost || !url.pathname.startsWith("/v1/")) {
    return undefined;
  }
  return url.pathname.replace(
    CLERK_RESOURCE_PATH_SEGMENT,
    "/[masked-clerk-resource-id]",
  );
}

function formatAuthV2BootstrapDiagnostic(
  state: AuthV2BootstrapState,
  lastRequest: AuthV2BootstrapRequest | undefined,
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
