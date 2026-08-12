import { connectorOauthStates } from "@vm0/db/schema/connector-oauth-state";
import { feishuOrgConnections } from "@vm0/db/schema/feishu-org-connection";
import { orgCustomConnectors } from "@vm0/db/schema/org-custom-connector";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { userCustomConnectors } from "@vm0/db/schema/user-custom-connector";
import { eq, type SQL } from "drizzle-orm";

import type { Db } from "../external/db";
import {
  deleteConnectorCredentialStorageConnectionsForOwner,
  type ConnectorOwnerScope,
} from "./connector-credential-storage-write.service";

interface ConnectorOwnerDeleteConditions {
  readonly builtinGrant: SQL;
  readonly customGrant: SQL;
  readonly oauthState: SQL;
}

function connectorOwnerDeleteConditions(
  owner: ConnectorOwnerScope,
): ConnectorOwnerDeleteConditions {
  return owner.kind === "user"
    ? {
        builtinGrant: eq(userConnectors.userId, owner.userId),
        customGrant: eq(userCustomConnectors.userId, owner.userId),
        oauthState: eq(connectorOauthStates.userId, owner.userId),
      }
    : {
        builtinGrant: eq(userConnectors.orgId, owner.orgId),
        customGrant: eq(userCustomConnectors.orgId, owner.orgId),
        oauthState: eq(connectorOauthStates.orgId, owner.orgId),
      };
}

export async function deleteConnectorOwnerState(
  db: Db,
  owner: ConnectorOwnerScope,
  signal: AbortSignal,
): Promise<void> {
  if (owner.kind === "user") {
    await db
      .delete(feishuOrgConnections)
      .where(eq(feishuOrgConnections.vm0UserId, owner.userId));
    signal.throwIfAborted();
  }

  const conditions = connectorOwnerDeleteConditions(owner);
  await db.delete(userConnectors).where(conditions.builtinGrant);
  signal.throwIfAborted();
  await db.delete(userCustomConnectors).where(conditions.customGrant);
  signal.throwIfAborted();
  await db.delete(connectorOauthStates).where(conditions.oauthState);
  signal.throwIfAborted();

  await deleteConnectorCredentialStorageConnectionsForOwner(db, owner, signal);

  if (owner.kind === "organization") {
    await db
      .delete(orgCustomConnectors)
      .where(eq(orgCustomConnectors.orgId, owner.orgId));
    signal.throwIfAborted();
  }
}
