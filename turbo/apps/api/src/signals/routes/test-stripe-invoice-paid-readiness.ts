import {
  testStripeInvoicePaidReadinessContract,
  type TestStripeInvoicePaidReadinessActionBody,
} from "@vm0/api-contracts/contracts/test-stripe-invoice-paid-readiness";
import { connectors } from "@vm0/db/schema/connector";
import { variables } from "@vm0/db/schema/variable";
import { command } from "ccstate";
import { eq } from "drizzle-orm";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  getConnectorRuntimeMethod,
  loadConnectorRuntimeSnapshot,
} from "../services/connector-catalog-runtime.service";
import {
  resolveStripeInvoicePaidAutomationBinding,
  validateStripeInvoicePaidAutomationBinding,
} from "../services/stripe-invoice-paid-workflow-automation.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const STRIPE_LIVEMODE_VARIABLE_NAME = "STRIPE_LIVEMODE";
const actionBody$ = bodyResultOf(testStripeInvoicePaidReadinessContract.action);

type ReadinessAction<
  TAction extends TestStripeInvoicePaidReadinessActionBody["action"],
> = Extract<TestStripeInvoicePaidReadinessActionBody, { action: TAction }>;

function actionOk(extra: Record<string, unknown> = {}) {
  return { status: 200 as const, body: { ok: true as const, ...extra } };
}

async function stripeStorageVersion(
  db: Db,
  authMethodId: "api-token" | "cli" | "oauth",
): Promise<number> {
  const snapshot = await loadConnectorRuntimeSnapshot(db);
  const method = getConnectorRuntimeMethod({
    snapshot,
    connectorSlug: "stripe",
    authMethodId,
    requireExecutable: true,
  });
  if (!method) {
    throw new Error(`Missing executable Stripe ${authMethodId} test method`);
  }
  return method.method.storage.version;
}

async function seedConnection(
  db: Db,
  body: ReadinessAction<"seed-connection">,
  signal: AbortSignal,
) {
  const compatibleVersion = await stripeStorageVersion(db, body.auth_method);
  signal.throwIfAborted();
  const [connection] = await db
    .insert(connectors)
    .values({
      connectorSlug: "stripe",
      authMethod: body.auth_method,
      storageVersion:
        body.storage_compatible === false
          ? compatibleVersion + 1
          : compatibleVersion,
      externalId:
        body.external_id === undefined ? "acct_live_owner" : body.external_id,
      needsReconnect: body.needs_reconnect ?? false,
      orgId: body.org_id,
      userId: body.user_id,
    })
    .returning({ id: connectors.id });
  signal.throwIfAborted();
  if (!connection) {
    throw new Error("Expected Stripe connector readiness fixture");
  }
  if (body.auth_method === "oauth" && body.livemode !== null) {
    await db.insert(variables).values({
      connectorId: connection.id,
      orgId: body.org_id,
      userId: body.user_id,
      name: STRIPE_LIVEMODE_VARIABLE_NAME,
      value: body.livemode ?? "true",
      type: "connector",
    });
  }
  signal.throwIfAborted();
  return actionOk({ connector_id: connection.id });
}

async function updateConnection(
  db: Db,
  body: ReadinessAction<"update-connection">,
  signal: AbortSignal,
) {
  const connectionFieldsChanged =
    body.external_id !== undefined || body.needs_reconnect !== undefined;
  const [connection] = connectionFieldsChanged
    ? await db
        .update(connectors)
        .set({
          ...(body.external_id === undefined
            ? {}
            : { externalId: body.external_id }),
          ...(body.needs_reconnect === undefined
            ? {}
            : { needsReconnect: body.needs_reconnect }),
        })
        .where(eq(connectors.id, body.connector_id))
        .returning({
          id: connectors.id,
          orgId: connectors.orgId,
          userId: connectors.userId,
        })
    : await db
        .select({
          id: connectors.id,
          orgId: connectors.orgId,
          userId: connectors.userId,
        })
        .from(connectors)
        .where(eq(connectors.id, body.connector_id))
        .limit(1);
  signal.throwIfAborted();
  if (!connection) {
    return {
      status: 400 as const,
      body: { error: "Stripe connector readiness fixture was not found" },
    };
  }
  if (body.livemode === null) {
    await db.delete(variables).where(eq(variables.connectorId, connection.id));
  } else if (body.livemode !== undefined) {
    await db
      .insert(variables)
      .values({
        connectorId: connection.id,
        orgId: connection.orgId,
        userId: connection.userId,
        name: STRIPE_LIVEMODE_VARIABLE_NAME,
        value: body.livemode,
        type: "connector",
      })
      .onConflictDoUpdate({
        target: [
          variables.orgId,
          variables.userId,
          variables.type,
          variables.name,
        ],
        set: { value: body.livemode },
      });
  }
  signal.throwIfAborted();
  return actionOk({ connector_id: connection.id });
}

async function deleteConnection(
  db: Db,
  body: ReadinessAction<"delete-connection">,
  signal: AbortSignal,
) {
  const [deleted] = await db
    .delete(connectors)
    .where(eq(connectors.id, body.connector_id))
    .returning({ id: connectors.id });
  signal.throwIfAborted();
  return deleted
    ? actionOk()
    : {
        status: 400 as const,
        body: { error: "Stripe connector readiness fixture was not found" },
      };
}

async function performAction(
  db: Db,
  body: TestStripeInvoicePaidReadinessActionBody,
  signal: AbortSignal,
) {
  switch (body.action) {
    case "seed-connection": {
      return await seedConnection(db, body, signal);
    }
    case "update-connection": {
      return await updateConnection(db, body, signal);
    }
    case "delete-connection": {
      return await deleteConnection(db, body, signal);
    }
    case "resolve-binding": {
      const readiness = await resolveStripeInvoicePaidAutomationBinding({
        db,
        orgId: body.org_id,
        userId: body.user_id,
        signal,
      });
      return actionOk({ readiness });
    }
    case "validate-binding": {
      const readiness = await validateStripeInvoicePaidAutomationBinding({
        db,
        eventConfig: body.event_config,
        orgId: body.org_id,
        userId: body.user_id,
        signal,
      });
      return actionOk({ readiness });
    }
  }
}

const stripeInvoicePaidReadinessAction$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    return await performAction(set(writeDb$), bodyResult.data, signal);
  },
);

/**
 * Test-only boundary for the standalone readiness service. Corrupt credential
 * states are not constructible through production APIs, and this route is
 * mounted explicitly by the focused test instead of the production registry.
 */
export const testStripeInvoicePaidReadinessRoutes: readonly RouteEntry[] = [
  {
    route: testStripeInvoicePaidReadinessContract.action,
    handler: stripeInvoicePaidReadinessAction$,
  },
];
