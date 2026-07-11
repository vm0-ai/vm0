import { and, eq, inArray } from "drizzle-orm";

import { orgMetadata } from "@vm0/db/schema/org-metadata";
import {
  zeroWorkflowTriggers,
  zeroWorkflowWebhookTriggers,
} from "@vm0/db/schema/zero-workflow";

import type { Db } from "../external/db";
import { nowDate } from "../external/time";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const WORKFLOW_WEBHOOK_TRIGGER_ELIGIBLE_TIERS = [
  "team",
  "custom",
] as const;

function workflowWebhookTriggerTierEligible(
  tier: string | null | undefined,
): boolean {
  return tier === "team" || tier === "custom";
}

export async function lockWorkflowWebhookTriggerTierEligibleForOrg(
  tx: DbTransaction,
  args: { readonly orgId: string; readonly signal: AbortSignal },
): Promise<boolean> {
  const [org] = await tx
    .select({ tier: orgMetadata.tier })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, args.orgId))
    .limit(1)
    .for("update");
  args.signal.throwIfAborted();
  return workflowWebhookTriggerTierEligible(org?.tier);
}

export async function disableIneligibleWorkflowWebhookTriggersForOrg(
  db: Db,
  args: { readonly orgId: string; readonly signal: AbortSignal },
): Promise<number> {
  return await db.transaction(async (tx) => {
    const tierEligible = await lockWorkflowWebhookTriggerTierEligibleForOrg(
      tx,
      args,
    );
    if (tierEligible) {
      return 0;
    }

    const webhookTriggerIds = tx
      .select({ triggerId: zeroWorkflowWebhookTriggers.triggerId })
      .from(zeroWorkflowWebhookTriggers);
    const currentTime = nowDate();
    const disabled = await tx
      .update(zeroWorkflowTriggers)
      .set({ enabled: false, updatedAt: currentTime })
      .where(
        and(
          eq(zeroWorkflowTriggers.orgId, args.orgId),
          eq(zeroWorkflowTriggers.enabled, true),
          inArray(zeroWorkflowTriggers.id, webhookTriggerIds),
        ),
      )
      .returning({ id: zeroWorkflowTriggers.id });
    args.signal.throwIfAborted();
    if (disabled.length === 0) {
      return 0;
    }

    await tx
      .update(zeroWorkflowWebhookTriggers)
      .set({
        disabledReason: "paid_plan_required",
        updatedAt: currentTime,
      })
      .where(
        inArray(
          zeroWorkflowWebhookTriggers.triggerId,
          disabled.map((trigger) => {
            return trigger.id;
          }),
        ),
      );
    args.signal.throwIfAborted();
    return disabled.length;
  });
}
