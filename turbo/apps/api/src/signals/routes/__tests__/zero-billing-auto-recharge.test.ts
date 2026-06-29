import { randomUUID } from "node:crypto";

import { zeroBillingAutoRechargeContract } from "@vm0/api-contracts/contracts/zero-billing";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createRunsAutomationsApi } from "./helpers/api-bdd-runs-automations";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const bdd = createBddApi(context);
const billingApi = createBillingMediaApi(context);
const runsApi = createRunsAutomationsApi(context);
const mocks = createZeroRouteMocks(context);

const defaultAutoRechargeConfig = Object.freeze({
  enabled: false,
  threshold: null,
  amount: null,
});

type AutoRechargeActor = ApiTestUser & { readonly orgId: string };

function autoRechargeClient() {
  return setupApp({ context })(zeroBillingAutoRechargeContract);
}

function createActor(
  options: {
    readonly orgId?: string;
    readonly orgRole?: NonNullable<ApiTestUser["orgRole"]>;
  } = {},
): AutoRechargeActor {
  const user = bdd.user(options);
  if (!user.orgId) {
    throw new Error("Expected auto-recharge test actor to have an org");
  }
  return { ...user, orgId: user.orgId };
}

async function createOnboardedActor(): Promise<AutoRechargeActor> {
  const admin = createActor();
  await billingApi.setupOnboarding(admin, {
    displayName: "BDD Auto Recharge",
  });
  return admin;
}

async function createProActor(
  options?: Parameters<typeof runsApi.grantProEntitlement>[1],
): Promise<{
  readonly admin: AutoRechargeActor;
  readonly entitlement: {
    readonly customerId: string;
    readonly subscriptionId: string;
    readonly invoiceId: string;
  };
}> {
  const admin = createActor();
  const entitlement = await runsApi.grantProEntitlement(admin, options);
  return { admin, entitlement };
}

function acceptAutoRechargeStripeInvoice(customerId: string): string {
  const invoiceId = `in_auto_recharge_${randomUUID().slice(0, 8)}`;
  context.mocks.stripe.customers.retrieve.mockResolvedValue({
    id: customerId,
    deleted: false,
    invoice_settings: { default_payment_method: "pm_test" },
  });
  context.mocks.stripe.invoices.create.mockResolvedValue({ id: invoiceId });
  context.mocks.stripe.invoiceItems.create.mockResolvedValue({
    id: `ii_auto_recharge_${randomUUID().slice(0, 8)}`,
  });
  context.mocks.stripe.invoices.finalizeInvoice.mockResolvedValue({
    id: invoiceId,
  });
  context.mocks.stripe.invoices.pay.mockResolvedValue({
    id: invoiceId,
    status: "paid",
  });
  return invoiceId;
}

describe("GET /api/zero/billing/auto-recharge", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const client = autoRechargeClient();

    const response = await accept(client.get({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns 401 when the user has no active org", async () => {
    const user = bdd.user({ orgId: null });
    mocks.clerk.session(user.userId, null);

    const client = autoRechargeClient();

    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns the org auto-recharge config after a public api update", async () => {
    const { admin } = await createProActor();
    await billingApi.updateAutoRecharge(
      admin,
      {
        enabled: true,
        threshold: 2000,
        amount: 10_000,
      },
      [200],
    );

    const response = await billingApi.readAutoRecharge(admin);

    expect(response).toStrictEqual({
      enabled: true,
      threshold: 2000,
      amount: 10_000,
    });
  });

  it("returns default config for a new org metadata row", async () => {
    const admin = await createOnboardedActor();
    const response = await billingApi.readAutoRecharge(admin);

    expect(response).toStrictEqual(defaultAutoRechargeConfig);
  });

  it("returns the legacy default when the org metadata row does not exist", async () => {
    const admin = createActor();
    const response = await billingApi.readAutoRecharge(admin);

    expect(response).toStrictEqual(defaultAutoRechargeConfig);
  });
});

describe("PUT /api/zero/billing/auto-recharge", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const client = autoRechargeClient();

    const response = await accept(
      client.update({
        body: { enabled: true, threshold: 1000, amount: 5000 },
        headers: {},
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("enables auto-recharge for pro tier org", async () => {
    const { admin } = await createProActor();

    const response = await billingApi.updateAutoRecharge(
      admin,
      { enabled: true, threshold: 1000, amount: 5000 },
      [200],
    );

    expect(response.body).toStrictEqual({
      enabled: true,
      threshold: 1000,
      amount: 5000,
    });

    const readBack = await billingApi.readAutoRecharge(admin);
    expect(readBack).toStrictEqual(response.body);
  });

  it("triggers auto-recharge immediately when enabling below threshold", async () => {
    const { admin, entitlement } = await createProActor();
    const status = await billingApi.readBillingStatus(admin);
    const threshold = status.credits + 1000;
    const amount = threshold + 5000;
    const invoiceId = acceptAutoRechargeStripeInvoice(entitlement.customerId);

    const response = await billingApi.updateAutoRecharge(
      admin,
      { enabled: true, threshold, amount },
      [200],
    );

    expect(response.body).toStrictEqual({
      enabled: true,
      threshold,
      amount,
    });
    expect(context.mocks.stripe.invoices.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: entitlement.customerId,
        auto_advance: false,
        default_payment_method: "pm_test",
        metadata: expect.objectContaining({
          type: "auto_recharge",
          orgId: admin.orgId,
          creditsAmount: String(amount),
        }),
      }),
    );
    expect(context.mocks.stripe.invoiceItems.create).toHaveBeenCalledWith(
      expect.objectContaining({
        invoice: invoiceId,
        customer: entitlement.customerId,
        amount: Math.ceil(amount / 1000) * 100,
        currency: "usd",
      }),
    );
    expect(context.mocks.stripe.invoices.pay).toHaveBeenCalledWith(invoiceId);
  });

  it("disables auto-recharge after a public recharge trigger", async () => {
    const { admin, entitlement } = await createProActor();
    const status = await billingApi.readBillingStatus(admin);
    acceptAutoRechargeStripeInvoice(entitlement.customerId);
    await billingApi.updateAutoRecharge(
      admin,
      {
        enabled: true,
        threshold: status.credits + 1000,
        amount: status.credits + 6000,
      },
      [200],
    );

    const response = await billingApi.updateAutoRecharge(
      admin,
      { enabled: false },
      [200],
    );

    expect(response.body).toStrictEqual(defaultAutoRechargeConfig);

    const readBack = await billingApi.readAutoRecharge(admin);
    expect(readBack).toStrictEqual(response.body);
  });

  it("returns 400 when enabling on a suspended org", async () => {
    const admin = await createOnboardedActor();

    const response = await billingApi.updateAutoRecharge(
      admin,
      { enabled: true, threshold: 1000, amount: 5000 },
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Auto-recharge is only available for paid plans (Pro/Team)",
        code: "BAD_REQUEST",
      },
    });
  });

  it("returns 400 when enabling without threshold and amount", async () => {
    const { admin } = await createProActor();

    await billingApi.updateAutoRecharge(admin, { enabled: true }, [400]);
  });

  it("returns 400 when amount is below minimum", async () => {
    const { admin } = await createProActor();

    await billingApi.updateAutoRecharge(
      admin,
      { enabled: true, threshold: 1000, amount: 500 },
      [400],
    );
  });

  it("returns 400 when amount exceeds the maximum", async () => {
    const { admin } = await createProActor();

    await billingApi.updateAutoRecharge(
      admin,
      { enabled: true, threshold: 1000, amount: 10_000_001 },
      [400],
    );
  });

  it("returns 400 when threshold exceeds the maximum", async () => {
    const { admin } = await createProActor();

    await billingApi.updateAutoRecharge(
      admin,
      { enabled: true, threshold: 10_000_001, amount: 20_000_000 },
      [400],
    );
  });

  it("returns 400 when threshold equals amount", async () => {
    const { admin } = await createProActor();

    const response = await billingApi.updateAutoRecharge(
      admin,
      { enabled: true, threshold: 5000, amount: 5000 },
      [400],
    );

    expect(response.body).toMatchObject({
      error: {
        message: "threshold must be less than amount to avoid recharge loops",
      },
    });
  });

  it("returns 400 when threshold is greater than amount", async () => {
    const { admin } = await createProActor();

    const response = await billingApi.updateAutoRecharge(
      admin,
      { enabled: true, threshold: 6000, amount: 5000 },
      [400],
    );

    expect(response.body).toMatchObject({
      error: {
        message: "threshold must be less than amount to avoid recharge loops",
      },
    });
  });

  it("returns 403 for non-admin member", async () => {
    const admin = createActor();
    const member = createActor({
      orgId: admin.orgId,
      orgRole: "org:member",
    });
    await runsApi.grantProEntitlement(admin);

    const response = await billingApi.updateAutoRecharge(
      member,
      { enabled: true, threshold: 1000, amount: 5000 },
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Only org admins can update auto-recharge settings",
        code: "FORBIDDEN",
      },
    });
  });
});
