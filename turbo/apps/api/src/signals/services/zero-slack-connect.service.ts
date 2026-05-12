import { command, computed, type Computed } from "ccstate";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { and, eq, isNull } from "drizzle-orm";

import {
  buildSuccessMessage,
  buildWelcomeMessage,
} from "../../lib/slack-connect-blocks";
import { publishUserSignal } from "../external/realtime";
import {
  createSlackClient,
  postEphemeral,
  postMessage,
} from "../external/slack-message-client";
import { nowDate } from "../external/time";
import { db$, writeDb$, type Db } from "../external/db";
import { decryptSecretValue } from "./crypto.utils";

type SlackInstallation = typeof slackOrgInstallations.$inferSelect;

type ConnectResult =
  | { readonly kind: "not_found"; readonly message: string }
  | { readonly kind: "forbidden"; readonly message: string }
  | {
      readonly kind: "ok";
      readonly connectionId: string;
      readonly role: "admin" | "member";
      readonly installation: SlackInstallation;
      readonly slackUserId: string;
      readonly channelId?: string;
      readonly threadTs?: string;
    };

const workspaceNotFoundMessage =
  "Workspace not found. Please install the Slack app first.";
const adminRequiredMessage =
  "Only org admins can connect an unconfigured workspace. Ask your org admin to connect first.";
const orgMismatchMessage =
  "Your active organization doesn't match this Slack workspace. Please switch to the correct organization in the platform sidebar before connecting.";

async function upsertSlackConnection(
  writeDb: Db,
  args: {
    readonly slackUserId: string;
    readonly slackWorkspaceId: string;
    readonly vm0UserId: string;
  },
): Promise<string> {
  const [connection] = await writeDb
    .insert(slackOrgConnections)
    .values(args)
    .onConflictDoNothing({
      target: [
        slackOrgConnections.slackUserId,
        slackOrgConnections.slackWorkspaceId,
      ],
    })
    .returning({ id: slackOrgConnections.id });

  if (connection) {
    return connection.id;
  }

  const [existing] = await writeDb
    .select({ id: slackOrgConnections.id })
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.slackUserId, args.slackUserId),
        eq(slackOrgConnections.slackWorkspaceId, args.slackWorkspaceId),
      ),
    )
    .limit(1);

  if (!existing) {
    throw new Error("Slack connection upsert did not return a row");
  }

  return existing.id;
}

export function zeroSlackConnectStatus(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly isAdmin: boolean;
}): Computed<
  Promise<{
    readonly isConnected: boolean;
    readonly isAdmin: boolean;
    readonly workspaceName?: string | null;
    readonly defaultAgentName?: string | null;
  }>
> {
  return computed(async (get) => {
    const db = get(db$);
    const [orgInstallation] = await db
      .select()
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.orgId, args.orgId))
      .limit(1);

    const [connection] = orgInstallation
      ? await db
          .select()
          .from(slackOrgConnections)
          .where(
            and(
              eq(slackOrgConnections.vm0UserId, args.userId),
              eq(
                slackOrgConnections.slackWorkspaceId,
                orgInstallation.slackWorkspaceId,
              ),
            ),
          )
          .limit(1)
      : [];

    if (!connection) {
      return { isConnected: false, isAdmin: args.isAdmin };
    }

    const [metadata] = await db
      .select({ defaultAgentId: orgMetadata.defaultAgentId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);

    const [agent] = metadata?.defaultAgentId
      ? await db
          .select({ name: zeroAgents.name })
          .from(agentComposes)
          .innerJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
          .where(eq(agentComposes.id, metadata.defaultAgentId))
          .limit(1)
      : [];

    return {
      isConnected: true,
      workspaceName: orgInstallation?.slackWorkspaceName ?? null,
      isAdmin: args.isAdmin,
      defaultAgentName: agent?.name ?? null,
    };
  });
}

export const connectSlackWorkspace$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly orgRole: "admin" | "member";
      readonly workspaceId: string;
      readonly slackUserId: string;
      readonly channelId?: string;
      readonly threadTs?: string;
    },
    signal: AbortSignal,
  ): Promise<ConnectResult> => {
    const writeDb = set(writeDb$);
    const [installation] = await writeDb
      .select()
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.slackWorkspaceId, args.workspaceId))
      .limit(1);
    signal.throwIfAborted();

    if (!installation) {
      return { kind: "not_found", message: workspaceNotFoundMessage };
    }

    if (installation.orgId === null) {
      if (args.orgRole !== "admin") {
        return { kind: "forbidden", message: adminRequiredMessage };
      }

      const [updated] = await writeDb
        .update(slackOrgInstallations)
        .set({
          orgId: args.orgId,
          installedByUserId: args.userId,
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(slackOrgInstallations.slackWorkspaceId, args.workspaceId),
            isNull(slackOrgInstallations.orgId),
          ),
        )
        .returning();
      signal.throwIfAborted();

      let boundInstallation = updated;
      if (!boundInstallation) {
        const [existing] = await writeDb
          .select()
          .from(slackOrgInstallations)
          .where(eq(slackOrgInstallations.slackWorkspaceId, args.workspaceId))
          .limit(1);
        signal.throwIfAborted();
        if (!existing) {
          return { kind: "not_found", message: workspaceNotFoundMessage };
        }
        if (existing.orgId !== args.orgId) {
          return { kind: "forbidden", message: orgMismatchMessage };
        }
        boundInstallation = existing;
      }

      const connectionId = await upsertSlackConnection(writeDb, {
        slackUserId: args.slackUserId,
        slackWorkspaceId: args.workspaceId,
        vm0UserId: args.userId,
      });
      signal.throwIfAborted();

      return {
        kind: "ok",
        connectionId,
        role: "admin",
        installation: boundInstallation,
        slackUserId: args.slackUserId,
        channelId: args.channelId,
        threadTs: args.threadTs,
      };
    }

    if (installation.orgId !== args.orgId) {
      return { kind: "forbidden", message: orgMismatchMessage };
    }

    const connectionId = await upsertSlackConnection(writeDb, {
      slackUserId: args.slackUserId,
      slackWorkspaceId: args.workspaceId,
      vm0UserId: args.userId,
    });
    signal.throwIfAborted();

    return {
      kind: "ok",
      connectionId,
      role: args.orgRole,
      installation,
      slackUserId: args.slackUserId,
      channelId: args.channelId,
      threadTs: args.threadTs,
    };
  },
);

export const publishSlackAdminSignal$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly topic: string;
      readonly payload?: unknown;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = get(db$);
    const admins = await db
      .select({ userId: orgMembersCache.userId })
      .from(orgMembersCache)
      .where(
        and(
          eq(orgMembersCache.orgId, args.orgId),
          eq(orgMembersCache.role, "admin"),
        ),
      );
    signal.throwIfAborted();

    await publishUserSignal(
      admins.map((admin) => {
        return admin.userId;
      }),
      args.topic,
      args.payload,
    );
    signal.throwIfAborted();
  },
);

export const notifySlackConnect$ = command(
  async (
    { set },
    args: {
      readonly installation: SlackInstallation;
      readonly slackUserId: string;
      readonly channelId?: string;
      readonly threadTs?: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    const client = createSlackClient(
      decryptSecretValue(args.installation.encryptedBotToken),
    );
    const blocks = buildSuccessMessage(
      "You're connected! :tada:\nMention `@Zero` in any channel or send a DM to start chatting with your agent.",
    );

    let sentEphemeral = false;
    if (args.channelId) {
      const result = await postEphemeral(client, {
        channel: args.channelId,
        user: args.slackUserId,
        text: "You're connected!",
        blocks,
        threadTs: args.threadTs,
      });
      signal.throwIfAborted();
      sentEphemeral = result.kind === "ok";
    }

    if (sentEphemeral) {
      return;
    }

    const connectMessage = await postMessage(
      client,
      args.slackUserId,
      "You're connected!",
      { blocks },
    );
    signal.throwIfAborted();
    if (connectMessage.kind !== "ok") {
      return;
    }

    await postMessage(client, args.slackUserId, "Hi! I'm Zero.", {
      threadTs: connectMessage.ts,
      blocks: buildWelcomeMessage(),
    });
    signal.throwIfAborted();

    await writeDb
      .update(slackOrgConnections)
      .set({ dmWelcomeSent: true })
      .where(
        and(
          eq(slackOrgConnections.slackUserId, args.slackUserId),
          eq(
            slackOrgConnections.slackWorkspaceId,
            args.installation.slackWorkspaceId,
          ),
        ),
      );
    signal.throwIfAborted();
  },
);
