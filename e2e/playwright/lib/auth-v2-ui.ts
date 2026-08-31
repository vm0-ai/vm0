import {
  expect,
  type Locator,
  type Page,
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

const AUTH_V2_READY_TIMEOUT_MS = 30_000;

interface AuthV2ReadyOptions {
  readonly timeoutMs?: number;
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
  options: AuthV2ReadyOptions = {},
): Promise<void> {
  await navigateToReadyAuthV2(
    page,
    async () => page.goto(url, { waitUntil: "domcontentloaded" }),
    options,
  );
}

export async function reloadAuthV2(
  page: Page,
  options: AuthV2ReadyOptions = {},
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
  options: AuthV2ReadyOptions,
): Promise<void> {
  const timeout = options.timeoutMs ?? AUTH_V2_READY_TIMEOUT_MS;
  await navigate();

  const root = authV2Root(page);
  await expect(root).toBeVisible({ timeout });
  await expect(page.getByTestId("app-auth-layout")).toBeVisible({ timeout });
  await expect(root.getByRole("status")).toHaveCount(0, { timeout });
}
