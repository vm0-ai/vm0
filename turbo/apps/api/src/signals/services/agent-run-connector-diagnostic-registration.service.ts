import { agentRunConnectorDiagnosticRegistrations } from "@okouai/db/schema/agent-run-connector-diagnostic-registration";
import { inArray } from "drizzle-orm";

import type { Db } from "../external/db";

export async function deleteRunConnectorDiagnosticRegistrations(
  db: Pick<Db, "delete">,
  runIds: readonly string[],
): Promise<void> {
  if (runIds.length === 0) {
    return;
  }
  await db
    .delete(agentRunConnectorDiagnosticRegistrations)
    .where(inArray(agentRunConnectorDiagnosticRegistrations.runId, runIds));
}
