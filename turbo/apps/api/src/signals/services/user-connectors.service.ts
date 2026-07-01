import { and, eq } from "drizzle-orm";
import type { ConnectorType } from "@vm0/connectors/connectors";
import { userCustomConnectors } from "@vm0/db/schema/user-custom-connector";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { zeroAgents } from "@vm0/db/schema/zero-agent";

import type { Db } from "../external/db";

async function lockAgentForConnectorReplace(
  db: Pick<Db, "select">,
  args: {
    readonly orgId: string;
    readonly agentId: string;
  },
): Promise<boolean> {
  const [agent] = await db
    .select({ id: zeroAgents.id })
    .from(zeroAgents)
    .where(
      and(eq(zeroAgents.orgId, args.orgId), eq(zeroAgents.id, args.agentId)),
    )
    .for("update")
    .limit(1);
  return agent !== undefined;
}

export async function replaceUserConnectors(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
    readonly enabledTypes: readonly ConnectorType[];
  },
): Promise<boolean> {
  const enabledTypes = Array.from(new Set(args.enabledTypes));

  return await db.transaction(async (tx) => {
    // Serialize replace semantics for concurrent saves of the same agent.
    const agentLocked = await lockAgentForConnectorReplace(tx, args);
    if (!agentLocked && enabledTypes.length > 0) {
      return false;
    }

    await tx
      .delete(userConnectors)
      .where(
        and(
          eq(userConnectors.orgId, args.orgId),
          eq(userConnectors.userId, args.userId),
          eq(userConnectors.agentId, args.agentId),
        ),
      );

    if (enabledTypes.length === 0) {
      return true;
    }

    await tx.insert(userConnectors).values(
      enabledTypes.map((connectorType) => {
        return {
          orgId: args.orgId,
          userId: args.userId,
          agentId: args.agentId,
          connectorType,
        };
      }),
    );
    return true;
  });
}

export async function replaceUserCustomConnectors(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
    readonly enabledIds: readonly string[];
  },
): Promise<boolean> {
  const enabledIds = Array.from(new Set(args.enabledIds));

  return await db.transaction(async (tx) => {
    // Serialize replace semantics for concurrent saves of the same agent.
    const agentLocked = await lockAgentForConnectorReplace(tx, args);
    if (!agentLocked) {
      return false;
    }

    await tx
      .delete(userCustomConnectors)
      .where(
        and(
          eq(userCustomConnectors.orgId, args.orgId),
          eq(userCustomConnectors.userId, args.userId),
          eq(userCustomConnectors.agentId, args.agentId),
        ),
      );

    if (enabledIds.length === 0) {
      return true;
    }

    await tx.insert(userCustomConnectors).values(
      enabledIds.map((customConnectorId) => {
        return {
          orgId: args.orgId,
          userId: args.userId,
          agentId: args.agentId,
          customConnectorId,
        };
      }),
    );
    return true;
  });
}
