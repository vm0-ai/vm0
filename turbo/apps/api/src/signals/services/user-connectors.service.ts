import { and, eq } from "drizzle-orm";
import type { ConnectorType } from "@vm0/connectors/connectors";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { zeroAgents } from "@vm0/db/schema/zero-agent";

import type { Db } from "../external/db";

export async function replaceUserConnectors(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
    readonly enabledTypes: readonly ConnectorType[];
  },
): Promise<void> {
  const enabledTypes = Array.from(new Set(args.enabledTypes));

  await db.transaction(async (tx) => {
    // Serialize replace semantics for concurrent saves of the same agent.
    await tx
      .select({ id: zeroAgents.id })
      .from(zeroAgents)
      .where(
        and(eq(zeroAgents.orgId, args.orgId), eq(zeroAgents.id, args.agentId)),
      )
      .for("update")
      .limit(1);

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
      return;
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
  });
}
