import { and, eq } from "drizzle-orm";
import { variables } from "@vm0/db/schema/variable";
import { initServices } from "../../lib/init-services";

export async function findTestVariablesByOrgAndName(params: {
  orgId: string;
  name: string;
}): Promise<Array<{ id: string; orgId: string; userId: string }>> {
  initServices();
  return globalThis.services.db
    .select({
      id: variables.id,
      orgId: variables.orgId,
      userId: variables.userId,
    })
    .from(variables)
    .where(
      and(eq(variables.orgId, params.orgId), eq(variables.name, params.name)),
    );
}
