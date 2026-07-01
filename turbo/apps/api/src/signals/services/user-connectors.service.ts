import { and, eq, inArray, or } from "drizzle-orm";
import type { ConnectorType } from "@vm0/connectors/connectors";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { orgCustomConnectors } from "@vm0/db/schema/org-custom-connector";
import { userCustomConnectors } from "@vm0/db/schema/user-custom-connector";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { zeroAgents } from "@vm0/db/schema/zero-agent";

import type { Db } from "../external/db";

type UpdateUserConnectorsResult =
  | {
      readonly status: "updated";
      readonly enabledTypes: readonly ConnectorType[];
    }
  | { readonly status: "agentNotFound" };

type UserConnectorUpdateOperation = "replace" | "add" | "remove";

type UpdateUserCustomConnectorsResult =
  | {
      readonly status: "updated";
      readonly enabledIds: readonly string[];
    }
  | { readonly status: "agentNotFound" }
  | {
      readonly status: "customConnectorsNotFound";
      readonly missingIds: readonly string[];
    };

type UserCustomConnectorUpdateOperation = "replace" | "add" | "remove";

type AddUserCustomConnectorResult =
  | { readonly status: "added" }
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
    readonly userId: string;
    readonly agentId: string;
  },
): Promise<boolean> {
  const [agent] = await db
    .select({ id: zeroAgents.id })
    .from(zeroAgents)
    .where(
      and(
        eq(zeroAgents.orgId, args.orgId),
        eq(zeroAgents.id, args.agentId),
        or(
          eq(zeroAgents.visibility, "public"),
          eq(zeroAgents.owner, args.userId),
        ),
      ),
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

  const sortedIds = [...args.enabledIds].sort();
  const lockedIds = new Set<string>();
  for (const id of sortedIds) {
    const [locked] = await db
      .select({ id: orgCustomConnectors.id })
      .from(orgCustomConnectors)
      .where(
        and(
          eq(orgCustomConnectors.orgId, args.orgId),
          eq(orgCustomConnectors.id, id),
        ),
      )
      .for("update")
      .limit(1);
    if (locked) {
      lockedIds.add(locked.id);
    }
  }

  return args.enabledIds.filter((id) => {
    return !lockedIds.has(id);
  });
}

export async function updateUserConnectors(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
    readonly enabledTypes: readonly ConnectorType[];
    readonly operation?: UserConnectorUpdateOperation;
    readonly allowMissingZeroAgentForEmptyReplace: boolean;
  },
): Promise<UpdateUserConnectorsResult> {
  const enabledTypes = Array.from(new Set(args.enabledTypes));
  const operation = args.operation ?? "replace";

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

    const connectorScope = and(
      eq(userConnectors.orgId, args.orgId),
      eq(userConnectors.userId, args.userId),
      eq(userConnectors.agentId, args.agentId),
    );

    if (operation === "replace") {
      await tx.delete(userConnectors).where(connectorScope);
    } else if (operation === "remove" && enabledTypes.length > 0) {
      await tx
        .delete(userConnectors)
        .where(
          and(
            connectorScope,
            inArray(userConnectors.connectorType, enabledTypes),
          ),
        );
    }

    if (operation !== "remove" && enabledTypes.length > 0) {
      await tx
        .insert(userConnectors)
        .values(
          enabledTypes.map((connectorType) => {
            return {
              orgId: args.orgId,
              userId: args.userId,
              agentId: args.agentId,
              connectorType,
            };
          }),
        )
        .onConflictDoNothing();
    }

    if (operation === "replace") {
      return { status: "updated", enabledTypes };
    }

    const rows = await tx
      .select({ connectorType: userConnectors.connectorType })
      .from(userConnectors)
      .where(connectorScope);
    return {
      status: "updated",
      enabledTypes: rows.map((row) => {
        return row.connectorType as ConnectorType;
      }),
    };
  });
}

export async function updateUserCustomConnectors(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
    readonly enabledIds: readonly string[];
    readonly operation?: UserCustomConnectorUpdateOperation;
  },
): Promise<UpdateUserCustomConnectorsResult> {
  const enabledIds = Array.from(new Set(args.enabledIds));
  const operation = args.operation ?? "replace";

  return await db.transaction(async (tx) => {
    const composeLocked = await lockAgentComposeForConnectorReplace(tx, args);
    if (!composeLocked) {
      return { status: "agentNotFound" };
    }

    if (operation !== "remove") {
      const missingIds = await lockCustomConnectorsForReplace(tx, {
        orgId: args.orgId,
        enabledIds,
      });
      if (missingIds.length > 0) {
        return { status: "customConnectorsNotFound", missingIds };
      }
    }

    const agentLocked = await lockZeroAgentForConnectorReplace(tx, args);
    if (!agentLocked) {
      return { status: "agentNotFound" };
    }

    const connectorScope = and(
      eq(userCustomConnectors.orgId, args.orgId),
      eq(userCustomConnectors.userId, args.userId),
      eq(userCustomConnectors.agentId, args.agentId),
    );

    if (operation === "replace") {
      await tx.delete(userCustomConnectors).where(connectorScope);
    } else if (operation === "remove" && enabledIds.length > 0) {
      await tx
        .delete(userCustomConnectors)
        .where(
          and(
            connectorScope,
            inArray(userCustomConnectors.customConnectorId, enabledIds),
          ),
        );
    }

    if (operation !== "remove" && enabledIds.length > 0) {
      await tx
        .insert(userCustomConnectors)
        .values(
          enabledIds.map((customConnectorId) => {
            return {
              orgId: args.orgId,
              userId: args.userId,
              agentId: args.agentId,
              customConnectorId,
            };
          }),
        )
        .onConflictDoNothing();
    }

    if (operation === "replace") {
      return { status: "updated", enabledIds };
    }

    const rows = await tx
      .select({ customConnectorId: userCustomConnectors.customConnectorId })
      .from(userCustomConnectors)
      .where(connectorScope);
    return {
      status: "updated",
      enabledIds: rows.map((row) => {
        return row.customConnectorId;
      }),
    };
  });
}

export async function addUserCustomConnector(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
    readonly customConnectorId: string;
  },
): Promise<AddUserCustomConnectorResult> {
  const result = await updateUserCustomConnectors(db, {
    orgId: args.orgId,
    userId: args.userId,
    agentId: args.agentId,
    enabledIds: [args.customConnectorId],
    operation: "add",
  });
  if (result.status === "updated") {
    return { status: "added" };
  }
  return result;
}
