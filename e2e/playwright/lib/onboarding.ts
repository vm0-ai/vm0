import type { APIResponse, Page } from "@playwright/test";

type AuthHeaders = Readonly<Record<"Authorization", string>>;

interface OnboardingSetupData {
  readonly displayName: string;
  readonly workspaceName: string;
  readonly selectedConnectors: readonly string[];
  readonly timezone: string;
  readonly role?: string;
}

export function authHeadersForToken(token: string): AuthHeaders {
  return { Authorization: `Bearer ${token}` };
}

export async function setupOnboarding(
  page: Page,
  apiUrl: string,
  headers: AuthHeaders,
  data: OnboardingSetupData,
): Promise<string> {
  const response = await page.request.post(
    `${apiUrl}/api/zero/onboarding/setup`,
    {
      headers,
      data,
    },
  );
  await expectStatus(response, [200, 409], "onboarding setup");

  const body: unknown = await response.json();
  if (!hasAgentId(body)) {
    throw new Error(`Unexpected onboarding setup response: ${stringify(body)}`);
  }
  return body.agentId;
}

export async function seedLimitedFreeBillingState(
  page: Page,
  apiUrl: string,
  orgId: string,
): Promise<string> {
  const response = await page.request.post(
    `${apiUrl}/api/test/billing-status-state/action`,
    {
      data: {
        action: "seed-org",
        org_id: orgId,
        credits: 1000,
        tier: "limited-free-1",
        onboarding_payment_pending: false,
      },
    },
  );
  await expectStatus(response, [200], "limited-free billing state seed");

  const body: unknown = await response.json();
  if (!hasTestStateFixture(body)) {
    throw new Error(
      `Unexpected limited-free billing state response: ${stringify(body)}`,
    );
  }
  return body.fixture.org_id;
}

export async function createProTrialCheckout(
  page: Page,
  apiUrl: string,
  appUrl: string,
  headers: AuthHeaders,
): Promise<string> {
  const successUrl = new URL("/_/skeleton", appUrl);
  successUrl.searchParams.set("billing", "pro");
  successUrl.searchParams.set("billing_session_id", "{CHECKOUT_SESSION_ID}");
  const stripeSuccessUrl = successUrl
    .toString()
    .replace(
      "billing_session_id=%7BCHECKOUT_SESSION_ID%7D",
      "billing_session_id={CHECKOUT_SESSION_ID}",
    );

  const cancelUrl = new URL("/_/skeleton", appUrl);
  cancelUrl.searchParams.set("billing", "canceled");

  const response = await page.request.post(
    `${apiUrl}/api/zero/billing/checkout`,
    {
      headers,
      data: {
        tier: "pro",
        trialDays: 7,
        successUrl: stripeSuccessUrl,
        cancelUrl: cancelUrl.toString(),
      },
    },
  );
  await expectStatus(response, [200], "pro trial checkout");

  const body: unknown = await response.json();
  if (!hasCheckoutUrl(body)) {
    throw new Error(`Unexpected checkout response: ${stringify(body)}`);
  }
  return body.url;
}

export async function completeCheckout(
  page: Page,
  apiUrl: string,
  headers: AuthHeaders,
  sessionId: string,
): Promise<boolean> {
  const response = await page.request.post(
    `${apiUrl}/api/zero/billing/checkout/complete`,
    {
      headers,
      data: { sessionId },
    },
  );
  await expectStatus(response, [200], "checkout completion");

  const body: unknown = await response.json();
  if (!hasCheckoutCompletion(body)) {
    throw new Error(
      `Unexpected checkout completion response: ${stringify(body)}`,
    );
  }
  return body.completed;
}

export async function waitForBillingSessionRedirect(
  page: Page,
  appUrl: string,
): Promise<string> {
  const appOrigin = new URL(appUrl).origin;
  const request = await page.waitForRequest(
    (candidate) => {
      const url = new URL(candidate.url());
      return (
        url.origin === appOrigin && url.searchParams.has("billing_session_id")
      );
    },
    { timeout: 120_000 },
  );
  const sessionId = new URL(request.url()).searchParams.get(
    "billing_session_id",
  );
  if (!sessionId) {
    throw new Error(`Missing billing session id in ${request.url()}`);
  }
  return sessionId;
}

async function expectStatus(
  response: APIResponse,
  statuses: readonly number[],
  action: string,
): Promise<void> {
  if (statuses.includes(response.status())) {
    return;
  }

  throw new Error(
    `${action} failed with ${response.status()}: ${await response.text()}`,
  );
}

function hasAgentId(value: unknown): value is { readonly agentId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "agentId" in value &&
    typeof value.agentId === "string"
  );
}

function hasCheckoutUrl(value: unknown): value is { readonly url: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "url" in value &&
    typeof value.url === "string"
  );
}

function hasCheckoutCompletion(
  value: unknown,
): value is { readonly completed: boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    "completed" in value &&
    typeof value.completed === "boolean"
  );
}

function hasTestStateFixture(value: unknown): value is {
  readonly ok: true;
  readonly fixture: { readonly org_id: string };
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    value.ok === true &&
    "fixture" in value &&
    typeof value.fixture === "object" &&
    value.fixture !== null &&
    "org_id" in value.fixture &&
    typeof value.fixture.org_id === "string"
  );
}

function stringify(value: unknown): string {
  return JSON.stringify(value);
}
