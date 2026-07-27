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
import { teamsOrgConnections } from "@vm0/db/schema/teams-org-connection";
import { teamsOrgInstallations } from "@vm0/db/schema/teams-org-installation";
import { teamsOrgThreadSessions } from "@vm0/db/schema/teams-org-thread-session";
import { zeroRuns } from "@vm0/db/schema/zero-run";

import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { teamsOrgCallbackPayloadSchema } from "./teams-org-callback-payload";
import { appendChatThreadEvent } from "./zero-chat-thread-event.service";
import {
  computerUseHostIsOnline,
  listComputerUseHosts$,
} from "./zero-computer-use.service";

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
      readonly source: "teams";
      readonly teamsConnectionId: string;
      readonly teamsConversationId: string;
      readonly teamsThreadId: string;
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
      readonly computerUseHostId: string | null;
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

function requiredChatThreadId(request: AuthorizationRequestRow): string {
  if (!request.chatThreadId) {
    throw new Error(
      `Chat authorization request ${request.id} is missing its thread ID`,
    );
  }
  return request.chatThreadId;
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

async function loadTeamsScope(args: {
  readonly db: Db;
  readonly runId: string;
}): Promise<AuthorizationRequestScope | null> {
  const [callback] = await args.db
    .select({ payload: agentRunCallbacks.payload })
    .from(agentRunCallbacks)
    .where(
      and(
        eq(agentRunCallbacks.runId, args.runId),
        eq(agentRunCallbacks.internalKind, "teams:org"),
      ),
    )
    .limit(1);

  const payload = teamsOrgCallbackPayloadSchema.safeParse(callback?.payload);
  if (!payload.success) {
    return null;
  }

  return {
    source: "teams",
    teamsConnectionId: payload.data.connectionId,
    teamsConversationId: payload.data.conversationId,
    teamsThreadId: payload.data.threadId,
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

  if (run.chatThreadId) {
    return { source: "chat", chatThreadId: run.chatThreadId };
  }

  if (run.triggerSource === "teams") {
    return (
      (await loadTeamsScope({ db: args.db, runId: args.runId })) ??
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

async function onlineHostExists(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly hostId: string;
  readonly now: Date;
}): Promise<boolean> {
  const [host] = await args.db
    .select({
      lastSeenAt: computerUseHosts.lastSeenAt,
      revokedAt: computerUseHosts.revokedAt,
      status: computerUseHosts.status,
    })
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
  return host !== undefined && computerUseHostIsOnline(host, args.now);
}

async function loadAuthorizedComputerUseHostId(args: {
  readonly db: Db;
  readonly request: AuthorizationRequestRow;
  readonly userId: string;
}): Promise<string | null> {
  if (!args.request.completedAt) {
    return null;
  }

  if (args.request.source === "chat") {
    const [thread] = await args.db
      .select({ computerUseHostId: chatThreads.computerUseHostId })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, requiredChatThreadId(args.request)),
          eq(chatThreads.userId, args.userId),
        ),
      )
      .limit(1);
    return thread?.computerUseHostId ?? null;
  }

  if (
    args.request.source === "teams" &&
    args.request.teamsConnectionId &&
    args.request.teamsConversationId &&
    args.request.teamsThreadId
  ) {
    const [threadSession] = await args.db
      .select({ computerUseHostId: teamsOrgThreadSessions.computerUseHostId })
      .from(teamsOrgThreadSessions)
      .where(
        and(
          eq(
            teamsOrgThreadSessions.connectionId,
            args.request.teamsConnectionId,
          ),
          eq(
            teamsOrgThreadSessions.teamsConversationId,
            args.request.teamsConversationId,
          ),
          eq(teamsOrgThreadSessions.teamsThreadId, args.request.teamsThreadId),
        ),
      )
      .limit(1);
    return threadSession?.computerUseHostId ?? null;
  }

  return null;
}

async function teamsScopeExists(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connectionId: string;
}): Promise<boolean> {
  const [connection] = await args.db
    .select({ id: teamsOrgConnections.id })
    .from(teamsOrgConnections)
    .innerJoin(
      teamsOrgInstallations,
      eq(
        teamsOrgInstallations.teamsTenantId,
        teamsOrgConnections.teamsTenantId,
      ),
    )
    .where(
      and(
        eq(teamsOrgConnections.id, args.connectionId),
        eq(teamsOrgConnections.vm0UserId, args.userId),
        eq(teamsOrgInstallations.orgId, args.orgId),
      ),
    )
    .limit(1);
  return connection !== undefined;
}

async function applyChatAuthorizationScope(args: {
  readonly db: Db;
  readonly request: AuthorizationRequestRow;
  readonly orgId: string;
  readonly userId: string;
  readonly computerUseHostId: string;
  readonly now: Date;
}): Promise<boolean> {
  return await args.db.transaction(async (tx) => {
    const [thread] = await tx
      .update(chatThreads)
      .set({
        computerUseHostId: args.computerUseHostId,
        cloudBrowserEnabled: false,
        updatedAt: args.now,
      })
      .where(
        and(
          eq(chatThreads.id, requiredChatThreadId(args.request)),
          eq(chatThreads.userId, args.userId),
        ),
      )
      .returning({
        id: chatThreads.id,
        agentComposeId: chatThreads.agentComposeId,
      });
    if (!thread) {
      return false;
    }
    await appendChatThreadEvent(tx, {
      kind: "computer_use_host_updated",
      userId: args.userId,
      orgId: args.orgId,
      chatThreadId: thread.id,
      agentComposeId: thread.agentComposeId,
      computerUseHostId: args.computerUseHostId,
      cloudBrowserEnabled: false,
      createdAt: args.now,
    });
    return true;
  });
}

async function applyTeamsAuthorizationScope(args: {
  readonly db: Db;
  readonly request: AuthorizationRequestRow;
  readonly orgId: string;
  readonly userId: string;
  readonly computerUseHostId: string;
  readonly now: Date;
}): Promise<boolean> {
  const connectionId = args.request.teamsConnectionId;
  if (
    !connectionId ||
    !args.request.teamsConversationId ||
    !args.request.teamsThreadId ||
    !(await teamsScopeExists({
      db: args.db,
      orgId: args.orgId,
      userId: args.userId,
      connectionId,
    }))
  ) {
    return false;
  }

  await args.db
    .insert(teamsOrgThreadSessions)
    .values({
      connectionId,
      teamsConversationId: args.request.teamsConversationId,
      teamsThreadId: args.request.teamsThreadId,
      computerUseHostId: args.computerUseHostId,
      updatedAt: args.now,
    })
    .onConflictDoUpdate({
      target: [
        teamsOrgThreadSessions.connectionId,
        teamsOrgThreadSessions.teamsConversationId,
        teamsOrgThreadSessions.teamsThreadId,
      ],
      set: {
        computerUseHostId: args.computerUseHostId,
        updatedAt: args.now,
      },
    });

  return true;
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
      teamsConnectionId:
        scope.source === "teams" ? scope.teamsConnectionId : null,
      teamsConversationId:
        scope.source === "teams" ? scope.teamsConversationId : null,
      teamsThreadId: scope.source === "teams" ? scope.teamsThreadId : null,
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

    const computerUseHostId = await loadAuthorizedComputerUseHostId({
      db,
      request: loaded.request,
      userId: args.userId,
    });
    signal.throwIfAborted();

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
      computerUseHostId,
      hosts: hosts.hosts.filter((host) => {
        return host.status === "online";
      }),
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
      !(await onlineHostExists({
        db,
        orgId: args.orgId,
        userId: args.userId,
        hostId: args.computerUseHostId,
        now,
      }))
    ) {
      return { status: "host_not_found" };
    }
    signal.throwIfAborted();

    const request = loaded.request;
    const applied =
      request.source === "chat"
        ? await applyChatAuthorizationScope({
            db,
            request,
            orgId: args.orgId,
            userId: args.userId,
            computerUseHostId: args.computerUseHostId,
            now,
          })
        : request.source === "teams"
          ? await applyTeamsAuthorizationScope({
              db,
              request,
              orgId: args.orgId,
              userId: args.userId,
              computerUseHostId: args.computerUseHostId,
              now,
            })
          : false;
    signal.throwIfAborted();

    if (!applied) {
      return { status: "scope_not_found" };
    }

    await db
      .update(computerUseAuthorizationRequests)
      .set({ completedAt: now, updatedAt: now })
      .where(eq(computerUseAuthorizationRequests.id, request.id));
    signal.throwIfAborted();

    if (request.source === "chat") {
      await publishThreadListChanged(args.userId);
      signal.throwIfAborted();
    }

    return {
      status: "applied",
      source: request.source as ComputerUseAuthorizationSource,
      computerUseHostId: args.computerUseHostId,
    };
  },
);
