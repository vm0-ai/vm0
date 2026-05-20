import { command, computed, type Computed } from "ccstate";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { slackUserAgentPreferences } from "@vm0/db/schema/slack-user-agent-preference";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { and, eq, isNull } from "drizzle-orm";

import {
  buildAppHomeView,
  buildSuccessMessage,
  buildWelcomeMessage,
} from "../../lib/slack-connect-blocks";
import { env } from "../../lib/env";
import { clerk$ } from "../external/clerk";
import { publishUserSignal } from "../external/realtime";
import {
  createSlackClient,
  postEphemeral,
  postMessage,
} from "../external/slack-message-client";
import { nowDate } from "../external/time";
import { settle } from "../utils";
import { db$, writeDb$, type Db } from "../external/db";
import { ensureUserArtifactStorage } from "./agent-run-storage.service";
import { decryptPersistentSecretValue } from "./crypto.utils";
import { userFeatureSwitchContext } from "./feature-switches.service";

type SlackInstallation = typeof slackOrgInstallations.$inferSelect;
type SlackClient = ReturnType<typeof createSlackClient>;

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

async function resolveDefaultComposeId(
  db: Db,
  orgId: string,
): Promise<string | null> {
  const [metadata] = await db
    .select({ defaultAgentId: orgMetadata.defaultAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return metadata?.defaultAgentId ?? null;
}

async function getUserAgentPreference(
  db: Db,
  vm0UserId: string,
  orgId: string,
): Promise<string | null> {
  const [preference] = await db
    .select({ selectedComposeId: slackUserAgentPreferences.selectedComposeId })
    .from(slackUserAgentPreferences)
    .where(
      and(
        eq(slackUserAgentPreferences.vm0UserId, vm0UserId),
        eq(slackUserAgentPreferences.orgId, orgId),
      ),
    )
    .limit(1);
  return preference?.selectedComposeId ?? null;
}

async function resolveEffectiveComposeId(
  db: Db,
  vm0UserId: string,
  orgId: string,
): Promise<string | null> {
  const override = await getUserAgentPreference(db, vm0UserId, orgId);
  if (override) {
    const [agent] = await db
      .select({ id: zeroAgents.id })
      .from(zeroAgents)
      .where(and(eq(zeroAgents.id, override), eq(zeroAgents.orgId, orgId)))
      .limit(1);
    if (agent?.id) {
      return override;
    }
  }
  return resolveDefaultComposeId(db, orgId);
}

async function getWorkspaceAgentName(
  db: Db,
  composeId: string,
): Promise<string | undefined> {
  const [agent] = await db
    .select({ name: zeroAgents.name, displayName: zeroAgents.displayName })
    .from(zeroAgents)
    .where(eq(zeroAgents.id, composeId))
    .limit(1);
  return agent?.displayName ?? agent?.name;
}

async function getPrimaryUserEmail(
  clerkClient: ReturnType<typeof clerk$.read>,
  userId: string,
): Promise<string | undefined> {
  const users = await clerkClient.users.getUserList({ userId: [userId] });
  const user = users.data.find((candidate) => {
    return candidate.id === userId;
  });
  const primaryEmailAddressId = user?.primaryEmailAddressId;
  const email = user?.emailAddresses.find((candidate) => {
    return candidate.id === primaryEmailAddressId;
  });
  return email?.emailAddress;
}

function buildSlackConnectUrl(
  workspaceId: string,
  slackUserId: string,
): string {
  const params = new URLSearchParams({ w: workspaceId, u: slackUserId });
  return `${env("VM0_WEB_URL")}/settings/slack?${params.toString()}`;
}

async function refreshSlackAppHome(args: {
  readonly db: Db;
  readonly clerkClient: ReturnType<typeof clerk$.read>;
  readonly client: SlackClient;
  readonly installation: SlackInstallation;
  readonly slackUserId: string;
}): Promise<void> {
  const [connection] = await args.db
    .select()
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.slackUserId, args.slackUserId),
        eq(
          slackOrgConnections.slackWorkspaceId,
          args.installation.slackWorkspaceId,
        ),
      ),
    )
    .limit(1);

  if (!connection) {
    await args.client.views.publish({
      user_id: args.slackUserId,
      view: buildAppHomeView({
        appUrl: env("VM0_WEB_URL"),
        isLinked: false,
        loginUrl: buildSlackConnectUrl(
          args.installation.slackWorkspaceId,
          args.slackUserId,
        ),
      }),
    });
    return;
  }

  let agentName: string | undefined;
  let isOverrideActive = false;
  let canSwitch = false;
  if (args.installation.orgId) {
    const [effectiveComposeId, overrideComposeId, defaultComposeId] =
      await Promise.all([
        resolveEffectiveComposeId(
          args.db,
          connection.vm0UserId,
          args.installation.orgId,
        ),
        getUserAgentPreference(
          args.db,
          connection.vm0UserId,
          args.installation.orgId,
        ),
        resolveDefaultComposeId(args.db, args.installation.orgId),
      ]);

    if (effectiveComposeId) {
      agentName = await getWorkspaceAgentName(args.db, effectiveComposeId);
    }
    isOverrideActive = Boolean(
      overrideComposeId && overrideComposeId !== defaultComposeId,
    );
    canSwitch = Boolean(defaultComposeId);
  }

  await args.client.views.publish({
    user_id: args.slackUserId,
    view: buildAppHomeView({
      appUrl: env("VM0_WEB_URL"),
      isLinked: true,
      vm0UserId: connection.vm0UserId,
      userEmail: await getPrimaryUserEmail(
        args.clerkClient,
        connection.vm0UserId,
      ),
      agentName,
      isOverrideActive,
      canSwitch,
    }),
  });
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
    { get, set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly orgRole: "admin" | "member";
      readonly workspaceId: string;
      readonly slackUserId: string;
      readonly channelId?: string;
      readonly threadTs?: string;
      readonly pendingPrompt?: string;
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

      await ensureUserArtifactStorage({
        get,
        db: writeDb,
        orgId: args.orgId,
        userId: args.userId,
        name: "artifact",
        bucket: env("R2_USER_STORAGES_BUCKET_NAME"),
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

    await ensureUserArtifactStorage({
      get,
      db: writeDb,
      orgId: args.orgId,
      userId: args.userId,
      name: "artifact",
      bucket: env("R2_USER_STORAGES_BUCKET_NAME"),
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
    { get, set },
    args: {
      readonly installation: SlackInstallation;
      readonly slackUserId: string;
      readonly orgId: string;
      readonly userId: string;
      readonly channelId?: string;
      readonly threadTs?: string;
      readonly pendingPrompt?: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    const client = createSlackClient(
      await decryptPersistentSecretValue(
        args.installation.encryptedBotToken,
        await get(userFeatureSwitchContext(args.orgId, args.userId)),
      ),
    );
    const defaultComposeId = await resolveDefaultComposeId(writeDb, args.orgId);
    signal.throwIfAborted();
    const agentName = defaultComposeId
      ? await getWorkspaceAgentName(writeDb, defaultComposeId)
      : undefined;
    signal.throwIfAborted();

    const blocks = buildSuccessMessage(
      "You're connected! :tada:\nMention `@Zero` in any channel or send a DM to start chatting with your agent.",
    );

    let sentEphemeral = false;
    if (args.channelId) {
      const settled = await settle(
        postEphemeral(client, {
          channel: args.channelId,
          user: args.slackUserId,
          text: "You're connected!",
          blocks,
          threadTs: args.threadTs,
        }),
      );
      signal.throwIfAborted();
      const result = settled.ok
        ? settled.value
        : { kind: "slack_error" as const, error: "post_ephemeral_failed" };
      sentEphemeral = result.kind === "ok";
    }

    if (!sentEphemeral) {
      const connectMessage = await postMessage(
        client,
        args.slackUserId,
        "You're connected!",
        { blocks },
      );
      signal.throwIfAborted();
      if (connectMessage.kind === "ok") {
        await postMessage(client, args.slackUserId, "Hi! I'm Zero.", {
          threadTs: connectMessage.ts,
          blocks: buildWelcomeMessage(agentName),
        });
        signal.throwIfAborted();

        if (args.pendingPrompt) {
          const safePrompt = `\`\`\`${args.pendingPrompt.replaceAll("`", "'")}\`\`\``;
          await postMessage(
            client,
            args.slackUserId,
            `By the way, would you like me to run this for you?\n\n${safePrompt}\n\nJust paste it in a message and I'll get started!`,
            { threadTs: connectMessage.ts },
          );
          signal.throwIfAborted();
        }

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
      }
    }

    await refreshSlackAppHome({
      db: writeDb,
      clerkClient: get(clerk$),
      client,
      installation: args.installation,
      slackUserId: args.slackUserId,
    });
    signal.throwIfAborted();
  },
);
