import { testStripeInvoicePaidFixtureContract } from "@vm0/api-contracts/contracts/test-stripe-invoice-paid-readiness";
import { connectors } from "@vm0/db/schema/connector";
import { variables } from "@vm0/db/schema/variable";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const STRIPE_LIVEMODE_VARIABLE_NAME = "STRIPE_LIVEMODE";
const fixtureBody$ = bodyResultOf(testStripeInvoicePaidFixtureContract.apply);

const applyStripeInvoicePaidFixture$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(fixtureBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const db = set(writeDb$);
    const [connection] = await db
      .select({ id: connectors.id })
      .from(connectors)
      .where(
        and(
          eq(connectors.id, bodyResult.data.connector_id),
          eq(connectors.connectorSlug, "stripe"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!connection) {
      return {
        status: 400 as const,
        body: { error: "Stripe connector fixture was not found" },
      };
    }

    switch (bodyResult.data.state) {
      case "storage-incompatible": {
        await db
          .update(connectors)
          .set({ storageVersion: sql`${connectors.storageVersion} + 1` })
          .where(eq(connectors.id, connection.id));
        signal.throwIfAborted();
        break;
      }
      case "needs-reconnect": {
        await db
          .update(connectors)
          .set({ needsReconnect: true })
          .where(eq(connectors.id, connection.id));
        signal.throwIfAborted();
        break;
      }
      case "missing-external-id": {
        await db
          .update(connectors)
          .set({ externalId: null })
          .where(eq(connectors.id, connection.id));
        signal.throwIfAborted();
        break;
      }
      case "blank-external-id": {
        await db
          .update(connectors)
          .set({ externalId: "" })
          .where(eq(connectors.id, connection.id));
        signal.throwIfAborted();
        break;
      }
      case "missing-livemode": {
        await db
          .delete(variables)
          .where(
            and(
              eq(variables.connectorId, connection.id),
              eq(variables.name, STRIPE_LIVEMODE_VARIABLE_NAME),
            ),
          );
        signal.throwIfAborted();
        break;
      }
      case "malformed-livemode": {
        await db
          .update(variables)
          .set({ value: "TRUE" })
          .where(
            and(
              eq(variables.connectorId, connection.id),
              eq(variables.name, STRIPE_LIVEMODE_VARIABLE_NAME),
            ),
          );
        signal.throwIfAborted();
        break;
      }
    }

    return { status: 200 as const, body: { ok: true as const } };
  },
);

/**
 * Test-only corruption boundary. Production connector APIs enforce compatible
 * storage, canonical identity, reconnect state, and OAuth variables, so these
 * historical or corrupt states cannot be constructed externally. Tests first
 * create a real connector through the public API, then mutate only one fact.
 */
export const testStripeInvoicePaidReadinessRoutes: readonly RouteEntry[] = [
  {
    route: testStripeInvoicePaidFixtureContract.apply,
    handler: applyStripeInvoicePaidFixture$,
  },
];
