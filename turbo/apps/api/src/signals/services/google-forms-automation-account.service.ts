import { googleFormsResponseSubmittedEventConfigSchema } from "@okouai/api-contracts/contracts/workflows";
import { googleFormsAutomationCursors } from "@okouai/db/schema/google-forms-event";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { and, eq } from "drizzle-orm";

import type { Db, ReadonlyDb } from "../external/db";
import { resolveWorkflowAutomationConnectorId } from "./workflow-automation-account.service";

export async function resolveGoogleFormsAutomationConnectorId(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly workflowId: string;
  },
): Promise<string | null> {
  return await resolveWorkflowAutomationConnectorId(db, {
    ...args,
    connectorSlug: "google-forms",
  });
}

export async function reprojectGoogleFormsAutomationsForOwner(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
  },
): Promise<void> {
  const automations = await db
    .select({
      id: workflowAutomations.id,
      workflowId: workflowAutomations.workflowId,
      eventConfig: workflowAutomations.eventConfig,
      eventConnectorId: workflowAutomations.eventConnectorId,
    })
    .from(workflowAutomations)
    .where(
      and(
        eq(workflowAutomations.orgId, args.orgId),
        eq(workflowAutomations.ownerUserId, args.userId),
        eq(workflowAutomations.kind, "event"),
        eq(workflowAutomations.eventType, "google-forms-response-submitted"),
      ),
    );

  for (const automation of automations) {
    const config = googleFormsResponseSubmittedEventConfigSchema.parse(
      automation.eventConfig,
    );
    const desiredConnectorId = await resolveGoogleFormsAutomationConnectorId(
      db,
      {
        ...args,
        workflowId: automation.workflowId,
      },
    );
    const sourceChanged =
      desiredConnectorId === null ||
      config.connectorId !== desiredConnectorId ||
      (automation.eventConnectorId !== null &&
        automation.eventConnectorId !== desiredConnectorId);
    if (sourceChanged) {
      await db
        .delete(googleFormsAutomationCursors)
        .where(eq(googleFormsAutomationCursors.automationId, automation.id));
    }
    const eventConfig =
      desiredConnectorId === null || config.connectorId === desiredConnectorId
        ? config
        : { ...config, connectorId: desiredConnectorId };
    if (
      automation.eventConnectorId === desiredConnectorId &&
      eventConfig.connectorId === config.connectorId
    ) {
      continue;
    }
    await db
      .update(workflowAutomations)
      .set({ eventConnectorId: desiredConnectorId, eventConfig })
      .where(eq(workflowAutomations.id, automation.id));
  }
}
