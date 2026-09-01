import { testStripeAutomationEventFixtureContract } from "@okouai/api-contracts/contracts/test-stripe-automation-events";
import { stripeWorkflowDeliveries } from "@okouai/db/schema/stripe-automation-event";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { desc, eq, sql } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const fixtureBody$ = bodyResultOf(
  testStripeAutomationEventFixtureContract.apply,
);

async function installIngressFailureTrigger(db: Db): Promise<void> {
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION test_fail_stripe_workflow_ingress()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM stripe_workflow_deliveries marker
        WHERE marker.automation_id = NEW.automation_id
          AND marker.last_error = 'test_force_ingress_failure'
      ) THEN
        RAISE EXCEPTION 'forced Stripe workflow ingress failure';
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await db.execute(
    sql`DROP TRIGGER IF EXISTS test_fail_stripe_workflow_ingress ON stripe_workflow_deliveries`,
  );
  await db.execute(sql`
    CREATE TRIGGER test_fail_stripe_workflow_ingress
    BEFORE INSERT ON stripe_workflow_deliveries
    FOR EACH ROW EXECUTE FUNCTION test_fail_stripe_workflow_ingress()
  `);
}

async function installQueueAdmissionFailureTrigger(db: Db): Promise<void> {
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION test_fail_stripe_workflow_queue_admission()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.event_type = 'input.automation' AND EXISTS (
        SELECT 1
        FROM workflow_user_automation_threads thread
        INNER JOIN workflow_automations automation
          ON automation.workflow_id = thread.workflow_id
          AND automation.org_id = thread.org_id
          AND automation.owner_user_id = thread.user_id
        INNER JOIN stripe_workflow_deliveries marker
          ON marker.automation_id = automation.id
        WHERE thread.chat_thread_id = NEW.chat_thread_id
          AND marker.last_error = 'test_force_queue_admission_failure'
      ) THEN
        RAISE EXCEPTION 'forced Stripe workflow queue admission failure';
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await db.execute(
    sql`DROP TRIGGER IF EXISTS test_fail_stripe_workflow_queue_admission ON chat_events`,
  );
  await db.execute(sql`
    CREATE TRIGGER test_fail_stripe_workflow_queue_admission
    BEFORE INSERT ON chat_events
    FOR EACH ROW EXECUTE FUNCTION test_fail_stripe_workflow_queue_admission()
  `);
}

async function clearFailureTriggers(db: Db): Promise<void> {
  await db.execute(
    sql`DROP TRIGGER IF EXISTS test_fail_stripe_workflow_ingress ON stripe_workflow_deliveries`,
  );
  await db.execute(
    sql`DROP FUNCTION IF EXISTS test_fail_stripe_workflow_ingress()`,
  );
  await db.execute(
    sql`DROP TRIGGER IF EXISTS test_fail_stripe_workflow_queue_admission ON chat_events`,
  );
  await db.execute(
    sql`DROP FUNCTION IF EXISTS test_fail_stripe_workflow_queue_admission()`,
  );
}

const applyStripeAutomationEventFixture$ = command(
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
    if (bodyResult.data.action === "clear-automation-account-projection") {
      const [automation] = await db
        .update(workflowAutomations)
        .set({ eventConnectorId: null })
        .where(eq(workflowAutomations.id, bodyResult.data.automation_id))
        .returning({ id: workflowAutomations.id });
      signal.throwIfAborted();
      if (!automation) {
        return testEndpointNotFoundResponse();
      }
      return { status: 200 as const, body: { ok: true as const } };
    }
    const [delivery] = await db
      .select({ id: stripeWorkflowDeliveries.id })
      .from(stripeWorkflowDeliveries)
      .where(
        eq(
          stripeWorkflowDeliveries.automationId,
          bodyResult.data.automation_id,
        ),
      )
      .orderBy(desc(stripeWorkflowDeliveries.createdAt))
      .limit(1);
    signal.throwIfAborted();
    if (!delivery) {
      return testEndpointNotFoundResponse();
    }

    const currentTime = nowDate();
    switch (bodyResult.data.action) {
      case "corrupt-latest-snapshot": {
        await db
          .update(stripeWorkflowDeliveries)
          .set({ snapshot: sql`'{}'::jsonb`, updatedAt: currentTime })
          .where(eq(stripeWorkflowDeliveries.id, delivery.id));
        signal.throwIfAborted();
        break;
      }
      case "hold-latest-claim": {
        await db
          .update(stripeWorkflowDeliveries)
          .set({
            claimExpiresAt: new Date(currentTime.getTime() + 300_000),
            updatedAt: currentTime,
          })
          .where(eq(stripeWorkflowDeliveries.id, delivery.id));
        signal.throwIfAborted();
        break;
      }
      case "expire-latest-retry-window": {
        await db
          .update(stripeWorkflowDeliveries)
          .set({
            receivedAt: new Date(currentTime.getTime() - 262_800_000),
            claimExpiresAt: null,
            nextAttemptAt: currentTime,
            updatedAt: currentTime,
          })
          .where(eq(stripeWorkflowDeliveries.id, delivery.id));
        signal.throwIfAborted();
        break;
      }
      case "make-latest-due": {
        await db
          .update(stripeWorkflowDeliveries)
          .set({
            claimExpiresAt: null,
            nextAttemptAt: currentTime,
            updatedAt: currentTime,
          })
          .where(eq(stripeWorkflowDeliveries.id, delivery.id));
        signal.throwIfAborted();
        break;
      }
      case "fail-next-ingress-for-automation": {
        await db
          .update(stripeWorkflowDeliveries)
          .set({
            lastError: "test_force_ingress_failure",
            updatedAt: currentTime,
          })
          .where(eq(stripeWorkflowDeliveries.id, delivery.id));
        signal.throwIfAborted();
        await installIngressFailureTrigger(db);
        signal.throwIfAborted();
        break;
      }
      case "fail-next-queue-admission-for-automation": {
        await db
          .update(stripeWorkflowDeliveries)
          .set({
            lastError: "test_force_queue_admission_failure",
            updatedAt: currentTime,
          })
          .where(eq(stripeWorkflowDeliveries.id, delivery.id));
        signal.throwIfAborted();
        await installQueueAdmissionFailureTrigger(db);
        signal.throwIfAborted();
        break;
      }
      case "clear-forced-failures": {
        await db
          .update(stripeWorkflowDeliveries)
          .set({ lastError: null, updatedAt: currentTime })
          .where(
            eq(
              stripeWorkflowDeliveries.automationId,
              bodyResult.data.automation_id,
            ),
          );
        signal.throwIfAborted();
        await clearFailureTriggers(db);
        signal.throwIfAborted();
        break;
      }
    }
    signal.throwIfAborted();
    return { status: 200 as const, body: { ok: true as const } };
  },
);

export const testStripeAutomationEventRoutes: readonly RouteEntry[] = [
  {
    route: testStripeAutomationEventFixtureContract.apply,
    handler: applyStripeAutomationEventFixture$,
  },
];
