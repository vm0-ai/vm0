import { eq, and } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import { usageEvent } from "@vm0/db/schema/usage-event";

/** Find `usage_event` rows of kind=connector by runId. */
export async function findTestConnectorBillingByRunId(runId: string): Promise<
  Array<{
    id: string;
    runId: string | null;
    orgId: string;
    userId: string;
    provider: string;
    category: string;
    quantity: number;
    status: string;
  }>
> {
  initServices();
  return globalThis.services.db
    .select({
      id: usageEvent.id,
      runId: usageEvent.runId,
      orgId: usageEvent.orgId,
      userId: usageEvent.userId,
      provider: usageEvent.provider,
      category: usageEvent.category,
      quantity: usageEvent.quantity,
      status: usageEvent.status,
    })
    .from(usageEvent)
    .where(and(eq(usageEvent.runId, runId), eq(usageEvent.kind, "connector")));
}
