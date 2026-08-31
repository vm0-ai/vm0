import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { connectors } from "@okouai/db/schema/connector";
import {
  workflowAutomations,
  workflowUserAutomationThreads,
} from "@okouai/db/schema/workflow";
import { and, eq, inArray } from "drizzle-orm";

import type { Db, ReadonlyDb } from "../external/db";

const GMAIL_EVENT_TYPES = ["gmail-new-message", "gmail-label-applied"] as const;

export async function resolveGmailAutomationConnectorId(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly workflowId: string;
  },
): Promise<string | null> {
  const [selection] = await db
    .select({ connectorId: chatThreadConnectorSelections.connectorId })
    .from(workflowUserAutomationThreads)
    .innerJoin(
      chatThreadConnectorSelections,
      and(
        eq(
          chatThreadConnectorSelections.chatThreadId,
          workflowUserAutomationThreads.chatThreadId,
        ),
        eq(chatThreadConnectorSelections.connectorSlug, "gmail"),
      ),
    )
    .where(
      and(
        eq(workflowUserAutomationThreads.orgId, args.orgId),
        eq(workflowUserAutomationThreads.userId, args.userId),
        eq(workflowUserAutomationThreads.workflowId, args.workflowId),
      ),
    )
    .limit(1);
  if (selection) {
    return selection.connectorId;
  }

  const [defaultAccount] = await db
    .select({ connectorId: connectors.id })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        eq(connectors.connectorSlug, "gmail"),
        eq(connectors.isDefault, true),
      ),
    )
    .limit(1);
  return defaultAccount?.connectorId ?? null;
}

export async function reprojectGmailAutomationsForOwner(
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
      eventConnectorId: workflowAutomations.eventConnectorId,
    })
    .from(workflowAutomations)
    .where(
      and(
        eq(workflowAutomations.orgId, args.orgId),
        eq(workflowAutomations.ownerUserId, args.userId),
        eq(workflowAutomations.kind, "event"),
        inArray(workflowAutomations.eventType, [...GMAIL_EVENT_TYPES]),
      ),
    );

  for (const automation of automations) {
    const eventConnectorId = await resolveGmailAutomationConnectorId(db, {
      ...args,
      workflowId: automation.workflowId,
    });
    if (automation.eventConnectorId === eventConnectorId) {
      continue;
    }
    await db
      .update(workflowAutomations)
      .set({ eventConnectorId })
      .where(eq(workflowAutomations.id, automation.id));
  }
}
