import type {
  ConnectorAccountSelection,
  ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import {
  connectorSlugSchema,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import { agentComposes } from "@okouai/db/schema/agent-compose";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { connectors } from "@okouai/db/schema/connector";
import { and, asc, eq, isNotNull } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import type { Db, ReadonlyDb } from "../external/db";
import {
  connectorAccountTargetKey,
  resolveConnectorAccounts,
} from "./connector-account-resolution.service";
import {
  loadAgentConnectorScope,
  type AgentConnectorScope,
} from "./agent-connector-scope.service";

interface OwnedChatThread {
  readonly agentId: string;
}

interface ConnectorSelectionRow {
  readonly connectorId: string;
  readonly connectorSlug: string | null;
  readonly customConnectorId: string | null;
}

export type PreparedChatThreadConnectorSelection = ConnectorAccountSelection;

type PrepareChatThreadConnectorSelectionsResult =
  | {
      readonly kind: "ready";
      readonly selections: readonly PreparedChatThreadConnectorSelection[];
    }
  | { readonly kind: "invalid"; readonly message: string };

type UpdateChatThreadConnectorSelectionResult =
  | { readonly kind: "updated"; readonly selection: ConnectorAccountSelection }
  | { readonly kind: "not_found" }
  | { readonly kind: "invalid"; readonly message: string };

type ClearChatThreadConnectorSelectionResult =
  | { readonly kind: "cleared" }
  | { readonly kind: "not_found" };

type ResolveChatThreadConnectorSelectionsResult =
  | {
      readonly kind: "resolved";
      readonly connectorIdsBySlug: ReadonlyMap<ConnectorSlug, string>;
      readonly connectorIdsByCustomConnectorId: ReadonlyMap<string, string>;
    }
  | { readonly kind: "invalid"; readonly message: string };

function targetFromRow(row: ConnectorSelectionRow): ConnectorAccountTarget {
  if (row.connectorSlug !== null && row.customConnectorId === null) {
    return {
      kind: "builtin",
      connectorSlug: connectorSlugSchema.parse(row.connectorSlug),
    };
  }
  if (row.customConnectorId !== null && row.connectorSlug === null) {
    return { kind: "custom", customConnectorId: row.customConnectorId };
  }
  throw new Error("Expected exactly one thread connector selection target");
}

function selectionFromRow(
  row: ConnectorSelectionRow,
): ConnectorAccountSelection {
  return {
    connectionId: row.connectorId,
    target: targetFromRow(row),
  };
}

function targetColumns(target: ConnectorAccountTarget): {
  readonly connectorSlug: string | null;
  readonly customConnectorId: string | null;
} {
  return target.kind === "builtin"
    ? { connectorSlug: target.connectorSlug, customConnectorId: null }
    : { connectorSlug: null, customConnectorId: target.customConnectorId };
}

function targetIsAuthorized(
  scope: AgentConnectorScope,
  target: ConnectorAccountTarget,
): boolean {
  return target.kind === "builtin"
    ? scope.allowedConnectorSlugs.includes(target.connectorSlug)
    : scope.allowedCustomConnectorIds.includes(target.customConnectorId);
}

async function loadOwnedChatThread(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly chatThreadId: string;
  },
): Promise<OwnedChatThread | undefined> {
  const [thread] = await db
    .select({ agentId: chatThreads.agentComposeId })
    .from(chatThreads)
    .innerJoin(
      agentComposes,
      and(
        eq(agentComposes.id, chatThreads.agentComposeId),
        eq(agentComposes.orgId, args.orgId),
      ),
    )
    .where(
      and(
        eq(chatThreads.id, args.chatThreadId),
        eq(chatThreads.userId, args.userId),
      ),
    )
    .limit(1);
  return thread;
}

async function loadSelectionRows(
  db: ReadonlyDb,
  chatThreadId: string,
): Promise<readonly ConnectorSelectionRow[]> {
  return await db
    .select({
      connectorId: chatThreadConnectorSelections.connectorId,
      connectorSlug: chatThreadConnectorSelections.connectorSlug,
      customConnectorId: chatThreadConnectorSelections.customConnectorId,
    })
    .from(chatThreadConnectorSelections)
    .where(eq(chatThreadConnectorSelections.chatThreadId, chatThreadId))
    .orderBy(
      asc(chatThreadConnectorSelections.connectorSlug),
      asc(chatThreadConnectorSelections.customConnectorId),
    );
}

async function loadConnectorTarget(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId: string;
  },
): Promise<ConnectorAccountTarget | undefined> {
  const [row] = await db
    .select({
      connectorId: connectors.id,
      connectorSlug: connectors.connectorSlug,
      customConnectorId: connectors.customConnectorId,
    })
    .from(connectors)
    .where(
      and(
        eq(connectors.id, args.connectorId),
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
      ),
    )
    .limit(1);
  return row ? targetFromRow(row) : undefined;
}

export async function listChatThreadConnectorSelections(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly chatThreadId: string;
  },
): Promise<readonly ConnectorAccountSelection[] | null> {
  const thread = await loadOwnedChatThread(db, args);
  if (!thread) {
    return null;
  }
  const rows = await loadSelectionRows(db, args.chatThreadId);
  return rows.map(selectionFromRow);
}

export async function prepareChatThreadConnectorSelections(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
    readonly selections: readonly ConnectorAccountSelection[];
  },
): Promise<PrepareChatThreadConnectorSelectionsResult> {
  const byTarget = new Map<string, ConnectorAccountSelection>();
  for (const selection of args.selections) {
    const key = connectorAccountTargetKey(selection.target);
    if (byTarget.has(key)) {
      return {
        kind: "invalid",
        message: "Only one connector account may be selected per target",
      };
    }
    byTarget.set(key, selection);
  }
  if (byTarget.size === 0) {
    return { kind: "ready", selections: [] };
  }

  const scope = await loadAgentConnectorScope(db, args);
  for (const selection of byTarget.values()) {
    if (!targetIsAuthorized(scope, selection.target)) {
      return {
        kind: "invalid",
        message: "Connector target is not authorized for this chat thread",
      };
    }
  }

  const resolutions = await resolveConnectorAccounts(db, {
    orgId: args.orgId,
    userId: args.userId,
    requests: [...byTarget.values()].map((selection) => {
      return {
        target: selection.target,
        selection: {
          kind: "exact" as const,
          sourceId: selection.connectionId,
        },
      };
    }),
  });
  for (const [key] of byTarget) {
    if (resolutions.get(key)?.kind !== "resolved") {
      return {
        kind: "invalid",
        message: "Connector account does not match the requested target",
      };
    }
  }
  return { kind: "ready", selections: [...byTarget.values()] };
}

async function upsertSelection(
  tx: Tx,
  chatThreadId: string,
  selection: ConnectorAccountSelection,
): Promise<ConnectorAccountSelection> {
  const values = {
    chatThreadId,
    connectorId: selection.connectionId,
    ...targetColumns(selection.target),
  };
  const [row] =
    selection.target.kind === "builtin"
      ? await tx
          .insert(chatThreadConnectorSelections)
          .values(values)
          .onConflictDoUpdate({
            target: [
              chatThreadConnectorSelections.chatThreadId,
              chatThreadConnectorSelections.connectorSlug,
            ],
            targetWhere: isNotNull(chatThreadConnectorSelections.connectorSlug),
            set: { connectorId: selection.connectionId },
          })
          .returning({
            connectorId: chatThreadConnectorSelections.connectorId,
            connectorSlug: chatThreadConnectorSelections.connectorSlug,
            customConnectorId: chatThreadConnectorSelections.customConnectorId,
          })
      : await tx
          .insert(chatThreadConnectorSelections)
          .values(values)
          .onConflictDoUpdate({
            target: [
              chatThreadConnectorSelections.chatThreadId,
              chatThreadConnectorSelections.customConnectorId,
            ],
            targetWhere: isNotNull(
              chatThreadConnectorSelections.customConnectorId,
            ),
            set: { connectorId: selection.connectionId },
          })
          .returning({
            connectorId: chatThreadConnectorSelections.connectorId,
            connectorSlug: chatThreadConnectorSelections.connectorSlug,
            customConnectorId: chatThreadConnectorSelections.customConnectorId,
          });
  if (!row) {
    throw new Error("Failed to persist chat thread connector selection");
  }
  return selectionFromRow(row);
}

export async function updateChatThreadConnectorSelection(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly chatThreadId: string;
    readonly selection: ConnectorAccountSelection;
  },
): Promise<UpdateChatThreadConnectorSelectionResult> {
  return await db.transaction(async (tx) => {
    const thread = await loadOwnedChatThread(tx, args);
    if (!thread) {
      return { kind: "not_found" };
    }
    const prepared = await prepareChatThreadConnectorSelections(tx, {
      orgId: args.orgId,
      userId: args.userId,
      agentId: thread.agentId,
      selections: [args.selection],
    });
    if (prepared.kind === "invalid") {
      return prepared;
    }
    const [selection] = prepared.selections;
    if (!selection) {
      throw new Error("Expected one prepared connector selection");
    }
    return {
      kind: "updated",
      selection: await upsertSelection(tx, args.chatThreadId, selection),
    };
  });
}

export async function clearChatThreadConnectorSelection(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly chatThreadId: string;
    readonly target: ConnectorAccountTarget;
  },
): Promise<ClearChatThreadConnectorSelectionResult> {
  return await db.transaction(async (tx) => {
    const thread = await loadOwnedChatThread(tx, args);
    if (!thread) {
      return { kind: "not_found" };
    }
    await tx
      .delete(chatThreadConnectorSelections)
      .where(
        and(
          eq(chatThreadConnectorSelections.chatThreadId, args.chatThreadId),
          args.target.kind === "builtin"
            ? eq(
                chatThreadConnectorSelections.connectorSlug,
                args.target.connectorSlug,
              )
            : eq(
                chatThreadConnectorSelections.customConnectorId,
                args.target.customConnectorId,
              ),
        ),
      );
    return { kind: "cleared" };
  });
}

export async function insertInitialChatThreadConnectorSelections(
  tx: Tx,
  args: {
    readonly chatThreadId: string;
    readonly selections: readonly PreparedChatThreadConnectorSelection[];
  },
): Promise<void> {
  if (args.selections.length === 0) {
    return;
  }
  await tx.insert(chatThreadConnectorSelections).values(
    args.selections.map((selection) => {
      return {
        chatThreadId: args.chatThreadId,
        connectorId: selection.connectionId,
        ...targetColumns(selection.target),
      };
    }),
  );
}

export async function resolveChatThreadConnectorSelections(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly chatThreadId: string;
    readonly scope: AgentConnectorScope;
    readonly connectorSourceId?: string;
  },
): Promise<ResolveChatThreadConnectorSelectionsResult> {
  const thread = await loadOwnedChatThread(db, args);
  if (!thread) {
    return {
      kind: "invalid",
      message: "Chat thread is no longer available",
    };
  }
  const rows = await loadSelectionRows(db, args.chatThreadId);
  const activeSelections = new Map<string, ConnectorAccountSelection>();
  for (const row of rows) {
    const selection = selectionFromRow(row);
    if (targetIsAuthorized(args.scope, selection.target)) {
      activeSelections.set(
        connectorAccountTargetKey(selection.target),
        selection,
      );
    }
  }
  if (args.connectorSourceId !== undefined) {
    const target = await loadConnectorTarget(db, {
      orgId: args.orgId,
      userId: args.userId,
      connectorId: args.connectorSourceId,
    });
    if (!target) {
      return {
        kind: "invalid",
        message: "Connector source is no longer available",
      };
    }
    if (targetIsAuthorized(args.scope, target)) {
      const key = connectorAccountTargetKey(target);
      const selected = activeSelections.get(key);
      if (
        selected !== undefined &&
        selected.connectionId !== args.connectorSourceId
      ) {
        return {
          kind: "invalid",
          message: "Connector source conflicts with the chat thread selection",
        };
      }
      activeSelections.set(key, {
        connectionId: args.connectorSourceId,
        target,
      });
    }
  }

  const exact = await resolveConnectorAccounts(db, {
    orgId: args.orgId,
    userId: args.userId,
    requests: [...activeSelections.values()].map((selection) => {
      return {
        target: selection.target,
        selection: {
          kind: "exact" as const,
          sourceId: selection.connectionId,
        },
      };
    }),
  });
  const connectorIdsBySlug = new Map<ConnectorSlug, string>();
  const connectorIdsByCustomConnectorId = new Map<string, string>();
  for (const selection of activeSelections.values()) {
    const resolution = exact.get(connectorAccountTargetKey(selection.target));
    if (resolution?.kind !== "resolved") {
      return {
        kind: "invalid",
        message: "Selected connector account is no longer available",
      };
    }
    if (selection.target.kind === "builtin") {
      connectorIdsBySlug.set(
        selection.target.connectorSlug,
        resolution.account.connectorId,
      );
    } else {
      connectorIdsByCustomConnectorId.set(
        selection.target.customConnectorId,
        resolution.account.connectorId,
      );
    }
  }
  return {
    kind: "resolved",
    connectorIdsBySlug,
    connectorIdsByCustomConnectorId,
  };
}
