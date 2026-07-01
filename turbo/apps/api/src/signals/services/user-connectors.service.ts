import { and, eq, inArray } from "drizzle-orm";
import type { ConnectorType } from "@vm0/connectors/connectors";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { orgCustomConnectors } from "@vm0/db/schema/org-custom-connector";
import { userCustomConnectors } from "@vm0/db/schema/user-custom-connector";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { zeroAgents } from "@vm0/db/schema/zero-agent";

import type { Db } from "../external/db";

type ReplaceUserConnectorsResult =
  | { readonly status: "replaced" }
  | { readonly status: "agentNotFound" };

type ReplaceUserCustomConnectorsResult =
  | { readonly status: "replaced" }
  | { readonly status: "agentNotFound" }
  | {
      readonly status: "customConnectorsNotFound";
      readonly missingIds: readonly string[];
    };

async function lockAgentComposeForConnectorReplace(
  db: Pick<Db, "select">,
  args: {
    readonly orgId: string;
    readonly agentId: string;
  },
): Promise<boolean> {
  const [compose] = await db
    .select({ id: agentComposes.id })
    .from(agentComposes)
    .where(
      and(
        eq(agentComposes.orgId, args.orgId),
        eq(agentComposes.id, args.agentId),
      ),
    )
    .for("update")
    .limit(1);
  return compose !== undefined;
}

async function lockZeroAgentForConnectorReplace(
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

async function lockCustomConnectorsForReplace(
  db: Pick<Db, "select">,
  args: {
    readonly orgId: string;
    readonly enabledIds: readonly string[];
  },
): Promise<readonly string[]> {
  if (args.enabledIds.length === 0) {
    return [];
  }

  const lockedRows = await db
    .select({ id: orgCustomConnectors.id })
    .from(orgCustomConnectors)
    .where(
      and(
        eq(orgCustomConnectors.orgId, args.orgId),
        inArray(orgCustomConnectors.id, [...args.enabledIds]),
      ),
    )
    .orderBy(orgCustomConnectors.id)
    .for("update");
  const lockedIds = new Set(
    lockedRows.map((row) => {
      return row.id;
    }),
  );
  return args.enabledIds.filter((id) => {
    return !lockedIds.has(id);
  });
}

export async function replaceUserConnectors(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
    readonly enabledTypes: readonly ConnectorType[];
    readonly allowMissingZeroAgentForEmptyReplace: boolean;
  },
): Promise<ReplaceUserConnectorsResult> {
  const enabledTypes = Array.from(new Set(args.enabledTypes));

  return await db.transaction(async (tx) => {
    const composeLocked = await lockAgentComposeForConnectorReplace(tx, args);
    if (!composeLocked) {
      return { status: "agentNotFound" };
    }

    const agentLocked = await lockZeroAgentForConnectorReplace(tx, args);
    if (
      !agentLocked &&
      (enabledTypes.length > 0 || !args.allowMissingZeroAgentForEmptyReplace)
    ) {
      return { status: "agentNotFound" };
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
      return { status: "replaced" };
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
    return { status: "replaced" };
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
): Promise<ReplaceUserCustomConnectorsResult> {
  const enabledIds = Array.from(new Set(args.enabledIds));

  return await db.transaction(async (tx) => {
    const missingIds = await lockCustomConnectorsForReplace(tx, {
      orgId: args.orgId,
      enabledIds,
    });
    if (missingIds.length > 0) {
      return { status: "customConnectorsNotFound", missingIds };
    }

    // Serialize replace semantics for concurrent saves of the same agent.
    const agentLocked = await lockZeroAgentForConnectorReplace(tx, args);
    if (!agentLocked) {
      return { status: "agentNotFound" };
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
      return { status: "replaced" };
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
    return { status: "replaced" };
  });
}
