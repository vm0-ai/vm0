import { command } from "ccstate";
import type {
  TestBillingRedeemStateActionBody,
  TestBillingRedeemStateActionResponse,
  TestBillingRedeemStateFixture,
} from "@vm0/api-contracts/contracts/test-billing-redeem-state";

import { createAppWithRoutes } from "../../../../app-factory-core";
import { testBillingRedeemStateRoutes } from "../../test-billing-redeem-state";

const BILLING_REDEEM_STATE_ROUTE = "/api/test/billing-redeem-state";

export interface RedeemFixture {
  readonly orgId: string;
  readonly userId: string;
}

interface SeedOrgArgs {
  readonly stripeCustomerId?: string;
}

interface PromoRow {
  readonly orgId: string;
  readonly campaignKey: string;
  readonly stripeSessionId: string;
}

interface CreditRow {
  readonly orgId: string;
  readonly source: string;
  readonly stripeInvoiceId: string;
  readonly amount: number;
  readonly expiresAt: Date;
}

function requestBillingRedeemState(
  signal: AbortSignal | undefined,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const requestSignal = signal ?? new AbortController().signal;
  const app = createAppWithRoutes({
    signal: requestSignal,
    routes: testBillingRedeemStateRoutes,
  });
  return Promise.resolve(app.request(path, init));
}

function fixtureFromWire(
  fixture: TestBillingRedeemStateFixture,
): RedeemFixture {
  return { orgId: fixture.org_id, userId: fixture.user_id };
}

function fixtureToWire(fixture: RedeemFixture): TestBillingRedeemStateFixture {
  return { org_id: fixture.orgId, user_id: fixture.userId };
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
  signal: AbortSignal | undefined,
  body: TestBillingRedeemStateActionBody,
): Promise<TestBillingRedeemStateActionResponse> {
  const requestSignal = signal ?? new AbortController().signal;
  const response = await requestBillingRedeemState(
    requestSignal,
    `${BILLING_REDEEM_STATE_ROUTE}/action`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  requestSignal.throwIfAborted();
  expectOk(response, `billing redeem state action ${body.action}`);
  requestSignal.throwIfAborted();
  const result = await readJson<TestBillingRedeemStateActionResponse>(response);
  requestSignal.throwIfAborted();
  return result;
}

export const seedRedeemOrg$ = command(
  async (_, args: SeedOrgArgs, signal: AbortSignal): Promise<RedeemFixture> => {
    const response = await postAction(signal, {
      action: "seed-org",
      stripe_customer_id: args.stripeCustomerId ?? null,
    });
    if (!response.fixture) {
      throw new Error("seedRedeemOrg$: response missing fixture");
    }
    return fixtureFromWire(response.fixture);
  },
);

export const deleteRedeemOrg$ = command(
  async (_, fixture: RedeemFixture, signal: AbortSignal): Promise<void> => {
    await postAction(signal, {
      action: "delete-org",
      fixture: fixtureToWire(fixture),
    });
  },
);

export const seedOrgPromoRedemption$ = command(
  async (_, args: PromoRow, signal: AbortSignal): Promise<void> => {
    await postAction(signal, {
      action: "seed-org-promo-redemption",
      org_id: args.orgId,
      campaign_key: args.campaignKey,
      stripe_session_id: args.stripeSessionId,
    });
  },
);

export const findOrgPromoRedemption$ = command(
  async (
    _,
    args: Pick<PromoRow, "orgId" | "campaignKey">,
  ): Promise<{ stripeSessionId: string } | undefined> => {
    const response = await postAction(undefined, {
      action: "read-org-promo-redemption",
      org_id: args.orgId,
      campaign_key: args.campaignKey,
    });
    if (!response.promo_redemption) {
      return undefined;
    }
    return {
      stripeSessionId: response.promo_redemption.stripe_session_id,
    };
  },
);

export const seedCreditExpiresRecord$ = command(
  async (_, args: CreditRow, signal: AbortSignal): Promise<void> => {
    await postAction(signal, {
      action: "seed-credit-expires-record",
      org_id: args.orgId,
      source: args.source,
      stripe_invoice_id: args.stripeInvoiceId,
      amount: args.amount,
      expires_at: args.expiresAt.toISOString(),
    });
  },
);
