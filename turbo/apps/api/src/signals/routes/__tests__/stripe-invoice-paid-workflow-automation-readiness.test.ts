import { randomUUID } from "node:crypto";

import {
  testStripeInvoicePaidReadinessContract,
  type TestStripeInvoicePaidReadinessActionBody,
  type TestStripeInvoicePaidReadinessActionResponse,
} from "@vm0/api-contracts/contracts/test-stripe-invoice-paid-readiness";
import type {
  StripeInvoicePaidEventConfig,
  StripeInvoicePaidEventCreateConfig,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { testStripeInvoicePaidReadinessRoutes } from "../test-stripe-invoice-paid-readiness";

const context = testContext();
const STRIPE_ACCOUNT_ID = "acct_live_owner";

interface ReadinessOwner {
  readonly orgId: string;
  readonly userId: string;
}

function readinessOwner(): ReadinessOwner {
  const suffix = randomUUID();
  return {
    orgId: `org_stripe_readiness_${suffix}`,
    userId: `user_stripe_readiness_${suffix}`,
  };
}

function createConfig(): StripeInvoicePaidEventCreateConfig {
  return {
    provider: "stripe",
    event: "invoice_paid",
    billingReasons: ["subscription_cycle"],
  };
}

async function action(
  body: TestStripeInvoicePaidReadinessActionBody,
): Promise<TestStripeInvoicePaidReadinessActionResponse> {
  const response = await accept(
    setupApp({
      context,
      routes: testStripeInvoicePaidReadinessRoutes,
    })(testStripeInvoicePaidReadinessContract).action({ body }),
    [200],
  );
  return response.body;
}

async function seedConnection(
  owner: ReadinessOwner,
  args: {
    readonly authMethod?: "api-token" | "cli" | "oauth";
    readonly externalId?: string | null;
    readonly livemode?: string | null;
    readonly needsReconnect?: boolean;
    readonly orgId?: string;
    readonly storageCompatible?: boolean;
    readonly userId?: string;
  } = {},
): Promise<string> {
  const response = await action({
    action: "seed-connection",
    org_id: args.orgId ?? owner.orgId,
    user_id: args.userId ?? owner.userId,
    auth_method: args.authMethod ?? "oauth",
    ...(args.externalId === undefined ? {} : { external_id: args.externalId }),
    ...(args.livemode === undefined ? {} : { livemode: args.livemode }),
    ...(args.needsReconnect === undefined
      ? {}
      : { needs_reconnect: args.needsReconnect }),
    ...(args.storageCompatible === undefined
      ? {}
      : { storage_compatible: args.storageCompatible }),
  });
  if (!response.connector_id) {
    throw new Error("Expected Stripe connector fixture ID");
  }
  return response.connector_id;
}

async function resolveBinding(
  owner: ReadinessOwner,
): Promise<
  NonNullable<TestStripeInvoicePaidReadinessActionResponse["readiness"]>
> {
  const response = await action({
    action: "resolve-binding",
    org_id: owner.orgId,
    user_id: owner.userId,
  });
  if (!response.readiness) {
    throw new Error("Expected Stripe readiness result");
  }
  return response.readiness;
}

async function validateBinding(
  owner: ReadinessOwner,
  eventConfig: StripeInvoicePaidEventConfig,
) {
  const response = await action({
    action: "validate-binding",
    org_id: owner.orgId,
    user_id: owner.userId,
    event_config: eventConfig,
  });
  if (!response.readiness) {
    throw new Error("Expected Stripe readiness result");
  }
  return response.readiness;
}

function persistedConfig(
  connectorId: string,
  stripeAccountId = STRIPE_ACCOUNT_ID,
): StripeInvoicePaidEventConfig {
  return {
    ...createConfig(),
    connectorId,
    stripeAccountId,
    mode: "live",
  };
}

describe("Stripe invoice-paid standalone readiness service", () => {
  it("resolves a Live OAuth binding without an access-token fixture", async () => {
    const owner = readinessOwner();
    const connectorId = await seedConnection(owner);

    await expect(resolveBinding(owner)).resolves.toStrictEqual({
      kind: "ok",
      binding: {
        connectorId,
        stripeAccountId: STRIPE_ACCOUNT_ID,
        mode: "live",
      },
    });
  });

  it("requires a connection owned by the exact organization and user", async () => {
    const owner = readinessOwner();
    await seedConnection(owner, { userId: `${owner.userId}_other` });
    await seedConnection(owner, { orgId: `${owner.orgId}_other` });

    await expect(resolveBinding(owner)).resolves.toMatchObject({
      kind: "bad_request",
      message: expect.stringContaining("Connect Stripe with OAuth"),
    });
  });

  it.each(["api-token", "cli"] as const)(
    "rejects the %s auth method with an OAuth-required error",
    async (authMethod) => {
      const owner = readinessOwner();
      await seedConnection(owner, { authMethod });

      await expect(resolveBinding(owner)).resolves.toMatchObject({
        kind: "bad_request",
        message: expect.stringMatching(/require OAuth/u),
      });
    },
  );

  it("rejects storage-incompatible connections", async () => {
    const owner = readinessOwner();
    await seedConnection(owner, { storageCompatible: false });

    await expect(resolveBinding(owner)).resolves.toMatchObject({
      kind: "bad_request",
      message: expect.stringContaining("Reconnect Stripe with OAuth"),
    });
  });

  it.each([
    { name: "reconnect-required", needsReconnect: true },
    { name: "missing external account", externalId: null },
    { name: "empty external account", externalId: "" },
  ])("rejects $name connections", async (fixture) => {
    const owner = readinessOwner();
    await seedConnection(owner, fixture);

    await expect(resolveBinding(owner)).resolves.toMatchObject({
      kind: "bad_request",
      message: expect.stringContaining("Reconnect Stripe with OAuth"),
    });
  });

  it("returns an actionable Live-mode-only error for Test mode", async () => {
    const owner = readinessOwner();
    await seedConnection(owner, { livemode: "false" });

    await expect(resolveBinding(owner)).resolves.toMatchObject({
      kind: "bad_request",
      message: expect.stringMatching(/require Live mode/u),
    });
  });

  it.each([
    { name: "missing", livemode: null },
    { name: "malformed", livemode: "TRUE" },
  ])("fails closed for $name livemode", async ({ livemode }) => {
    const owner = readinessOwner();
    await seedConnection(owner, { livemode });

    await expect(resolveBinding(owner)).resolves.toMatchObject({
      kind: "bad_request",
      message: expect.stringContaining("Reconnect Stripe with OAuth"),
    });
  });

  it("accepts a same-account Live reconnect that preserves connector ID", async () => {
    const owner = readinessOwner();
    const connectorId = await seedConnection(owner);
    await action({
      action: "update-connection",
      connector_id: connectorId,
      needs_reconnect: true,
    });
    await action({
      action: "update-connection",
      connector_id: connectorId,
      external_id: STRIPE_ACCOUNT_ID,
      needs_reconnect: false,
      livemode: "true",
    });

    await expect(
      validateBinding(owner, persistedConfig(connectorId)),
    ).resolves.toMatchObject({ kind: "ok", binding: { connectorId } });
  });

  it("rejects a reconnect to a different Stripe account", async () => {
    const owner = readinessOwner();
    const connectorId = await seedConnection(owner);
    await action({
      action: "update-connection",
      connector_id: connectorId,
      external_id: "acct_different",
    });

    await expect(
      validateBinding(owner, persistedConfig(connectorId)),
    ).resolves.toMatchObject({
      kind: "bad_request",
      message: expect.stringMatching(/delete and recreate/u),
    });
  });

  it("rejects a reconnect to Test mode", async () => {
    const owner = readinessOwner();
    const connectorId = await seedConnection(owner);
    await action({
      action: "update-connection",
      connector_id: connectorId,
      livemode: "false",
    });

    await expect(
      validateBinding(owner, persistedConfig(connectorId)),
    ).resolves.toMatchObject({
      kind: "bad_request",
      message: expect.stringMatching(/require Live mode/u),
    });
  });

  it("does not silently rebind after connector deletion", async () => {
    const owner = readinessOwner();
    const connectorId = await seedConnection(owner);
    await action({ action: "delete-connection", connector_id: connectorId });
    const replacementId = await seedConnection(owner);

    expect(replacementId).not.toBe(connectorId);
    await expect(
      validateBinding(owner, persistedConfig(connectorId)),
    ).resolves.toMatchObject({
      kind: "bad_request",
      message: expect.stringMatching(/delete and recreate/u),
    });
  });
});
