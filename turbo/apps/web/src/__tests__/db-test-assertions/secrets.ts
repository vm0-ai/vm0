import { and, eq } from "drizzle-orm";
import { secrets } from "@vm0/db/schema/secret";
import { variables } from "@vm0/db/schema/variable";
import { initServices } from "../../lib/init-services";

export async function findTestSecretsByOrgAndName(params: {
  orgId: string;
  name: string;
}): Promise<
  Array<{ id: string; orgId: string; userId: string; type: string }>
> {
  initServices();
  return globalThis.services.db
    .select({
      id: secrets.id,
      orgId: secrets.orgId,
      userId: secrets.userId,
      type: secrets.type,
    })
    .from(secrets)
    .where(and(eq(secrets.orgId, params.orgId), eq(secrets.name, params.name)));
}

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
