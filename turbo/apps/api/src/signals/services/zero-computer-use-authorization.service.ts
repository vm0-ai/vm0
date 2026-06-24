import { createHash, randomBytes } from "node:crypto";

import { command } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";
import type {
  ComputerUseAuthorizationSource,
  ComputerUseHostListResponse,
} from "@vm0/api-contracts/contracts/zero-computer-use";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import {
  computerUseAuthorizationRequests,
  computerUseHosts,
} from "@vm0/db/schema/computer-use-host";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { slackOrgThreadSessions } from "@vm0/db/schema/slack-org-thread-session";
import { zeroRuns } from "@vm0/db/schema/zero-run";

import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { slackOrgCallbackPayloadSchema } from "./slack-org-callback-payload";
import { listComputerUseHosts$ } from "./zero-computer-use.service";

const COMPUTER_USE_AUTHORIZATION_REQUEST_TTL_MS = 60 * 60 * 1000;
const COMPUTER_USE_AUTHORIZATION_URL_PREFIX =
  "vm0_computer_use_authorization_request";

type AuthorizationRequestRow =
  typeof computerUseAuthorizationRequests.$inferSelect;

type AuthorizationRequestScope =
  | {
      readonly source: "chat";
      readonly chatThreadId: string;
    }
  | {
      readonly source: "slack";
      readonly slackConnectionId: string;
      readonly slackChannelId: string;
      readonly slackThreadTs: string;
    };

type CreateComputerUseAuthorizationRequestResult =
  | {
      readonly status: "created";
      readonly authorizationUrl: string;
      readonly source: ComputerUseAuthorizationSource;
      readonly expiresAt: string;
    }
  | { readonly status: "run_not_found" }
  | { readonly status: "unsupported_context" };

type ReadComputerUseAuthorizationRequestResult =
  | {
      readonly status: "found";
      readonly source: ComputerUseAuthorizationSource;
      readonly expiresAt: string;
      readonly completedAt: string | null;
      readonly hosts: ComputerUseHostListResponse["hosts"];
    }
  | { readonly status: "not_found" }
  | { readonly status: "expired" };

type ApplyComputerUseAuthorizationRequestResult =
  | {
      readonly status: "applied";
      readonly source: ComputerUseAuthorizationSource;
      readonly computerUseHostId: string;
    }
  | { readonly status: "not_found" }
  | { readonly status: "expired" }
  | { readonly status: "host_not_found" }
  | { readonly status: "scope_not_found" };

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function generateOpaqueToken(): string {
  return `${COMPUTER_USE_AUTHORIZATION_URL_PREFIX}_${randomBytes(32).toString("base64url")}`;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function authorizationUrl(requestToken: string): string {
  return `${env("APP_URL")}/computer-use/authorize/${encodeURIComponent(
    requestToken,
  )}`;
}

async function loadSlackScope(args: {
  readonly db: Db;
  readonly runId: string;
}): Promise<AuthorizationRequestScope | null> {
  const [callback] = await args.db
    .select({ payload: agentRunCallbacks.payload })
    .from(agentRunCallbacks)
    .where(
      and(
        eq(agentRunCallbacks.runId, args.runId),
        eq(agentRunCallbacks.internalKind, "slack:org"),
      ),
    )
    .limit(1);

  const payload = slackOrgCallbackPayloadSchema.safeParse(callback?.payload);
  if (!payload.success) {
    return null;
  }

  return {
    source: "slack",
    slackConnectionId: payload.data.connectionId,
    slackChannelId: payload.data.channelId,
    slackThreadTs: payload.data.threadTs,
  };
}

async function resolveRequestScope(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
}): Promise<
  AuthorizationRequestScope | "run_not_found" | "unsupported_context"
> {
  if (!isUuid(args.runId)) {
    return "run_not_found";
  }

  const [run] = await args.db
    .select({
      triggerSource: zeroRuns.triggerSource,
      chatThreadId: zeroRuns.chatThreadId,
    })
    .from(agentRuns)
    .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
    .where(
      and(
        eq(agentRuns.id, args.runId),
        eq(agentRuns.orgId, args.orgId),
        eq(agentRuns.userId, args.userId),
      ),
    )
    .limit(1);

  if (!run) {
    return "run_not_found";
  }

  if (run.triggerSource === "web" && run.chatThreadId) {
    return { source: "chat", chatThreadId: run.chatThreadId };
  }

  if (run.triggerSource === "slack") {
    return (
      (await loadSlackScope({ db: args.db, runId: args.runId })) ??
      "unsupported_context"
    );
  }

  return "unsupported_context";
}

async function loadRequestByToken(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly requestToken: string;
  readonly now: Date;
}): Promise<
  | { readonly status: "found"; readonly request: AuthorizationRequestRow }
  | { readonly status: "not_found" }
  | { readonly status: "expired" }
> {
  const [request] = await args.db
    .select()
    .from(computerUseAuthorizationRequests)
    .where(
      and(
        eq(
          computerUseAuthorizationRequests.requestTokenHash,
          hashSecret(args.requestToken),
        ),
        eq(computerUseAuthorizationRequests.orgId, args.orgId),
        eq(computerUseAuthorizationRequests.userId, args.userId),
      ),
    )
    .limit(1);

  if (!request) {
    return { status: "not_found" };
  }
  if (request.expiresAt.getTime() <= args.now.getTime()) {
    return { status: "expired" };
  }
  return { status: "found", request };
}

async function hostExists(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly hostId: string;
}): Promise<boolean> {
  const [host] = await args.db
    .select({ id: computerUseHosts.id })
    .from(computerUseHosts)
    .where(
      and(
        eq(computerUseHosts.id, args.hostId),
        eq(computerUseHosts.orgId, args.orgId),
        eq(computerUseHosts.userId, args.userId),
        isNull(computerUseHosts.revokedAt),
      ),
    )
    .limit(1);
  return host !== undefined;
}

async function slackScopeExists(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connectionId: string;
}): Promise<boolean> {
  const [connection] = await args.db
    .select({ id: slackOrgConnections.id })
    .from(slackOrgConnections)
    .innerJoin(
      slackOrgInstallations,
      eq(
        slackOrgInstallations.slackWorkspaceId,
        slackOrgConnections.slackWorkspaceId,
      ),
    )
    .where(
      and(
        eq(slackOrgConnections.id, args.connectionId),
        eq(slackOrgConnections.vm0UserId, args.userId),
        eq(slackOrgInstallations.orgId, args.orgId),
      ),
    )
    .limit(1);
  return connection !== undefined;
}

export const createComputerUseAuthorizationRequest$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly runId: string;
    },
    signal: AbortSignal,
  ): Promise<CreateComputerUseAuthorizationRequestResult> => {
    const db = set(writeDb$);
    const scope = await resolveRequestScope({ db, ...args });
    signal.throwIfAborted();

    if (scope === "run_not_found") {
      return { status: "run_not_found" };
    }
    if (scope === "unsupported_context") {
      return { status: "unsupported_context" };
    }

    const requestToken = generateOpaqueToken();
    const now = nowDate();
    const expiresAt = new Date(
      now.getTime() + COMPUTER_USE_AUTHORIZATION_REQUEST_TTL_MS,
    );

    await db.insert(computerUseAuthorizationRequests).values({
      requestTokenHash: hashSecret(requestToken),
      orgId: args.orgId,
      userId: args.userId,
      runId: args.runId,
      source: scope.source,
      chatThreadId: scope.source === "chat" ? scope.chatThreadId : null,
      slackConnectionId:
        scope.source === "slack" ? scope.slackConnectionId : null,
      slackChannelId: scope.source === "slack" ? scope.slackChannelId : null,
      slackThreadTs: scope.source === "slack" ? scope.slackThreadTs : null,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });
    signal.throwIfAborted();

    return {
      status: "created",
      authorizationUrl: authorizationUrl(requestToken),
      source: scope.source,
      expiresAt: expiresAt.toISOString(),
    };
  },
);

export const readComputerUseAuthorizationRequest$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly requestToken: string;
    },
    signal: AbortSignal,
  ): Promise<ReadComputerUseAuthorizationRequestResult> => {
    const db = set(writeDb$);
    const loaded = await loadRequestByToken({
      db,
      orgId: args.orgId,
      userId: args.userId,
      requestToken: args.requestToken,
      now: nowDate(),
    });
    signal.throwIfAborted();

    if (loaded.status !== "found") {
      return loaded;
    }

    const hosts = await set(
      listComputerUseHosts$,
      { orgId: args.orgId, userId: args.userId },
      signal,
    );
    signal.throwIfAborted();

    return {
      status: "found",
      source: loaded.request.source as ComputerUseAuthorizationSource,
      expiresAt: loaded.request.expiresAt.toISOString(),
      completedAt: loaded.request.completedAt?.toISOString() ?? null,
      hosts: hosts.hosts,
    };
  },
);

export const applyComputerUseAuthorizationRequest$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly requestToken: string;
      readonly computerUseHostId: string;
    },
    signal: AbortSignal,
  ): Promise<ApplyComputerUseAuthorizationRequestResult> => {
    const db = set(writeDb$);
    const now = nowDate();
    const loaded = await loadRequestByToken({
      db,
      orgId: args.orgId,
      userId: args.userId,
      requestToken: args.requestToken,
      now,
    });
    signal.throwIfAborted();

    if (loaded.status !== "found") {
      return loaded;
    }

    if (
      !(await hostExists({
        db,
        orgId: args.orgId,
        userId: args.userId,
        hostId: args.computerUseHostId,
      }))
    ) {
      return { status: "host_not_found" };
    }
    signal.throwIfAborted();

    const request = loaded.request;
    if (request.source === "chat") {
      const updated = await db
        .update(chatThreads)
        .set({
          computerUseHostId: args.computerUseHostId,
          updatedAt: now,
        })
        .where(
          and(
            eq(chatThreads.id, request.chatThreadId ?? ""),
            eq(chatThreads.userId, args.userId),
          ),
        )
        .returning({ id: chatThreads.id });
      signal.throwIfAborted();

      if (updated.length === 0) {
        return { status: "scope_not_found" };
      }
    } else if (request.source === "slack") {
      const connectionId = request.slackConnectionId;
      if (
        !connectionId ||
        !request.slackChannelId ||
        !request.slackThreadTs ||
        !(await slackScopeExists({
          db,
          orgId: args.orgId,
          userId: args.userId,
          connectionId,
        }))
      ) {
        return { status: "scope_not_found" };
      }
      signal.throwIfAborted();

      await db
        .insert(slackOrgThreadSessions)
        .values({
          connectionId,
          slackChannelId: request.slackChannelId,
          slackThreadTs: request.slackThreadTs,
          computerUseHostId: args.computerUseHostId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            slackOrgThreadSessions.connectionId,
            slackOrgThreadSessions.slackChannelId,
            slackOrgThreadSessions.slackThreadTs,
          ],
          set: {
            computerUseHostId: args.computerUseHostId,
            updatedAt: now,
          },
        });
      signal.throwIfAborted();
    } else {
      return { status: "scope_not_found" };
    }

    await db
      .update(computerUseAuthorizationRequests)
      .set({ completedAt: now, updatedAt: now })
      .where(eq(computerUseAuthorizationRequests.id, request.id));
    signal.throwIfAborted();

    return {
      status: "applied",
      source: request.source as ComputerUseAuthorizationSource,
      computerUseHostId: args.computerUseHostId,
    };
  },
);
