import { eq } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import { connectorBilling } from "../../db/schema/connector-billing";

/**
 * Find connector_billing records by runId.
 */
export async function findTestConnectorBillingByRunId(runId: string): Promise<
  Array<{
    id: string;
    runId: string | null;
    flowId: string;
    orgId: string;
    userId: string;
    connector: string;
    category: string;
    quantity: number;
    status: string;
  }>
> {
  initServices();
  return globalThis.services.db
    .select({
      id: connectorBilling.id,
      runId: connectorBilling.runId,
      flowId: connectorBilling.flowId,
      orgId: connectorBilling.orgId,
      userId: connectorBilling.userId,
      connector: connectorBilling.connector,
      category: connectorBilling.category,
      quantity: connectorBilling.quantity,
      status: connectorBilling.status,
    })
    .from(connectorBilling)
    .where(eq(connectorBilling.runId, runId));
}
