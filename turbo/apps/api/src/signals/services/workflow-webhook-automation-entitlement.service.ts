import { and, eq, inArray } from "drizzle-orm";

import {
  zeroWorkflowAutomations,
  zeroWorkflowWebhookAutomations,
} from "@vm0/db/schema/zero-workflow";

import type { Db } from "../external/db";
import { nowDate } from "../external/time";
import { loadOrgPlanCapabilities } from "./org-plan-entitlement-read.service";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function lockWorkflowWebhookAutomationTierEligibleForOrg(
  tx: DbTransaction,
  args: { readonly orgId: string; readonly signal: AbortSignal },
): Promise<boolean> {
  const capabilities = await loadOrgPlanCapabilities(tx, args.orgId, {
    forUpdate: true,
  });
  args.signal.throwIfAborted();
  return capabilities?.workflowWebhookAutomationAllowed === true;
}

export async function disableIneligibleWorkflowWebhookAutomationsForOrg(
  db: Db,
  args: { readonly orgId: string; readonly signal: AbortSignal },
): Promise<number> {
  return await db.transaction(async (tx) => {
    const tierEligible = await lockWorkflowWebhookAutomationTierEligibleForOrg(
      tx,
      args,
    );
    if (tierEligible) {
      return 0;
    }

    const webhookAutomationIds = tx
      .select({ automationId: zeroWorkflowWebhookAutomations.automationId })
      .from(zeroWorkflowWebhookAutomations);
    const currentTime = nowDate();
    const disabled = await tx
      .update(zeroWorkflowAutomations)
      .set({ enabled: false, updatedAt: currentTime })
      .where(
        and(
          eq(zeroWorkflowAutomations.orgId, args.orgId),
          eq(zeroWorkflowAutomations.enabled, true),
          inArray(zeroWorkflowAutomations.id, webhookAutomationIds),
        ),
      )
      .returning({ id: zeroWorkflowAutomations.id });
    args.signal.throwIfAborted();
    if (disabled.length === 0) {
      return 0;
    }

    await tx
      .update(zeroWorkflowWebhookAutomations)
      .set({
        disabledReason: "paid_plan_required",
        updatedAt: currentTime,
      })
      .where(
        inArray(
          zeroWorkflowWebhookAutomations.automationId,
          disabled.map((automation) => {
            return automation.id;
          }),
        ),
      );
    args.signal.throwIfAborted();
    return disabled.length;
  });
}
