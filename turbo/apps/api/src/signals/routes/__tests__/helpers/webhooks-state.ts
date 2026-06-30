import type {
  TestWebhooksStateActionBody,
  TestWebhooksStateActionResponse,
  TestWebhooksStateBillingState,
  TestWebhooksStateOrgCleanupRows,
} from "@vm0/api-contracts/contracts/test-webhooks-state";

import { createAppWithRoutes } from "../../../../app-factory-core";
import type { TestContext } from "../../../../__tests__/test-context";
import { testWebhooksStateRoutes } from "../../test-webhooks-state";

const WEBHOOKS_STATE_ROUTE = "/api/test/webhooks-state";

interface OrgCleanupRows {
  readonly cache: readonly { readonly orgId: string }[];
  readonly metadata: readonly {
    readonly stripeCustomerId: string | null;
    readonly stripeSubscriptionId: string | null;
  }[];
  readonly members: readonly { readonly userId: string }[];
}

interface WebhookBillingState {
  readonly stripeSubscriptionId: string | null;
  readonly concurrencyEntitlements: readonly {
    readonly stripeInvoiceLineId: string;
    readonly stripeSubscriptionId: string;
    readonly slots: number;
    readonly startsAt: string;
    readonly expiresAt: string;
  }[];
  readonly concurrencySubscriptions: readonly {
    readonly stripeSubscriptionId: string;
    readonly slots: number;
    readonly subscriptionStatus: string;
    readonly currentPeriodEnd: string | null;
    readonly cancelAtPeriodEnd: boolean;
  }[];
}

function requestWebhooksState(
  context: TestContext,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: testWebhooksStateRoutes,
  });
  return Promise.resolve(app.request(path, init));
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function expectOk(response: Response, operation: string): void {
  if (response.ok) {
    return;
  }
  throw new Error(`${operation} failed with ${response.status}`);
}

async function postAction(
  context: TestContext,
  body: TestWebhooksStateActionBody,
): Promise<TestWebhooksStateActionResponse> {
  const response = await requestWebhooksState(
    context,
    `${WEBHOOKS_STATE_ROUTE}/action`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  await expectOk(response, `webhooks state action ${body.action}`);
  return await readJson<TestWebhooksStateActionResponse>(response);
}

function orgCleanupFromWire(
  rows: TestWebhooksStateOrgCleanupRows,
): OrgCleanupRows {
  return {
    cache: rows.cache.map((row) => {
      return { orgId: row.org_id };
    }),
    metadata: rows.metadata.map((row) => {
      return {
        stripeCustomerId: row.stripe_customer_id,
        stripeSubscriptionId: row.stripe_subscription_id,
      };
    }),
    members: rows.members.map((row) => {
      return { userId: row.user_id };
    }),
  };
}

function billingStateFromWire(
  state: TestWebhooksStateBillingState,
): WebhookBillingState {
  return {
    stripeSubscriptionId: state.stripe_subscription_id,
    concurrencyEntitlements: state.concurrency_entitlements.map((row) => {
      return {
        stripeInvoiceLineId: row.stripe_invoice_line_id,
        stripeSubscriptionId: row.stripe_subscription_id,
        slots: row.slots,
        startsAt: row.starts_at,
        expiresAt: row.expires_at,
      };
    }),
    concurrencySubscriptions: state.concurrency_subscriptions.map((row) => {
      return {
        stripeSubscriptionId: row.stripe_subscription_id,
        slots: row.slots,
        subscriptionStatus: row.subscription_status,
        currentPeriodEnd: row.current_period_end,
        cancelAtPeriodEnd: row.cancel_at_period_end,
      };
    }),
  };
}

export async function expireAtomGrantState(
  context: TestContext,
  orgId: string,
  expiredAt: Date,
): Promise<void> {
  await postAction(context, {
    action: "expire-atom-grants",
    org_id: orgId,
    expired_at: expiredAt.toISOString(),
  });
}

export async function readOrgCleanupRows(
  context: TestContext,
  orgId: string,
): Promise<OrgCleanupRows> {
  const response = await postAction(context, {
    action: "read-org-cleanup",
    org_id: orgId,
  });
  if (!response.org_cleanup) {
    throw new Error("readOrgCleanupRows: response missing org_cleanup");
  }
  return orgCleanupFromWire(response.org_cleanup);
}

export async function seedOrgMemberCache(
  context: TestContext,
  input: {
    readonly orgId: string;
    readonly userId: string;
    readonly role: string;
    readonly cachedAt: Date;
  },
): Promise<void> {
  await postAction(context, {
    action: "seed-org-member",
    org_id: input.orgId,
    user_id: input.userId,
    role: input.role,
    cached_at: input.cachedAt.toISOString(),
  });
}

export async function readWebhookBillingState(
  context: TestContext,
  input: {
    readonly orgId: string;
    readonly stripeSubscriptionId?: string;
  },
): Promise<WebhookBillingState> {
  const response = await postAction(context, {
    action: "read-billing-state",
    org_id: input.orgId,
    stripe_subscription_id: input.stripeSubscriptionId,
  });
  if (!response.billing_state) {
    throw new Error("readWebhookBillingState: response missing billing_state");
  }
  return billingStateFromWire(response.billing_state);
}

export async function setFirewallAuthRefreshTimeoutMsState(
  context: TestContext,
  timeoutMs: number,
): Promise<void> {
  await postAction(context, {
    action: "set-firewall-auth-refresh-timeout-ms",
    timeout_ms: timeoutMs,
  });
}

export async function resetFirewallAuthRefreshTimeoutMsState(
  context: TestContext,
): Promise<void> {
  await postAction(context, {
    action: "reset-firewall-auth-refresh-timeout-ms",
  });
}
