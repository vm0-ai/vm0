import { eq, and } from "drizzle-orm";
import { deriveApiTokenConnectedTypes } from "@vm0/connectors/connector-utils";
import type { ConnectorType } from "@vm0/connectors/connectors";
import { secrets } from "@vm0/db/schema/secret";
import { variables } from "@vm0/db/schema/variable";

/**
 * Derive api-token connector types from user secrets and variables.
 * API-token connectors don't have DB records — their existence is inferred
 * from matching user secrets/variables.
 */
export async function getApiTokenConnectorTypes(
  orgId: string,
  userId: string,
): Promise<ConnectorType[]> {
  const db = globalThis.services.db;
  const [userSecretRows, userVariableRows] = await Promise.all([
    db
      .select({ name: secrets.name })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, orgId),
          eq(secrets.userId, userId),
          eq(secrets.type, "user"),
        ),
      ),
    db
      .select({ name: variables.name })
      .from(variables)
      .where(and(eq(variables.orgId, orgId), eq(variables.userId, userId))),
  ]);
  return deriveApiTokenConnectedTypes(
    new Set(
      userSecretRows.map((r) => {
        return r.name;
      }),
    ),
    new Set(
      userVariableRows.map((r) => {
        return r.name;
      }),
    ),
  );
}
