import { chatThreads } from "@vm0/db/schema/chat-thread";
import { githubChatThreadRoutes } from "@vm0/db/schema/github-chat-thread-route";
import { and, eq } from "drizzle-orm";

import type { Db } from "../external/db";
import { appendChatThreadEvent } from "./zero-chat-thread-event.service";

interface GitHubChatThreadRouteKey {
  readonly installationId: string;
  readonly repo: string;
  readonly subjectNumber: number;
  readonly userId: string;
}

export interface GitHubChatThreadRouteBinding extends GitHubChatThreadRouteKey {
  readonly id: string;
  readonly chatThreadId: string;
  readonly lastCommentId: string | null;
}

interface LoadedGitHubChatThreadRoute extends GitHubChatThreadRouteBinding {
  readonly agentComposeId: string;
  readonly selectedModel: string | null;
  readonly computerUseHostId: string | null;
}

type GitHubChatThreadTransaction = Parameters<
  Parameters<Db["transaction"]>[0]
>[0];

function routeWhere(key: GitHubChatThreadRouteKey) {
  return and(
    eq(githubChatThreadRoutes.installationId, key.installationId),
    eq(githubChatThreadRoutes.repo, key.repo),
    eq(githubChatThreadRoutes.subjectNumber, key.subjectNumber),
    eq(githubChatThreadRoutes.userId, key.userId),
  );
}

async function loadRoute(
  db: Pick<Db, "select">,
  key: GitHubChatThreadRouteKey,
): Promise<LoadedGitHubChatThreadRoute | undefined> {
  const [route] = await db
    .select({
      id: githubChatThreadRoutes.id,
      installationId: githubChatThreadRoutes.installationId,
      repo: githubChatThreadRoutes.repo,
      subjectNumber: githubChatThreadRoutes.subjectNumber,
      userId: githubChatThreadRoutes.userId,
      chatThreadId: githubChatThreadRoutes.chatThreadId,
      lastCommentId: githubChatThreadRoutes.lastCommentId,
      agentComposeId: chatThreads.agentComposeId,
      selectedModel: chatThreads.selectedModel,
      computerUseHostId: chatThreads.computerUseHostId,
    })
    .from(githubChatThreadRoutes)
    .innerJoin(
      chatThreads,
      eq(chatThreads.id, githubChatThreadRoutes.chatThreadId),
    )
    .where(routeWhere(key))
    .limit(1)
    .for("update");
  return route;
}

async function createCanonicalGitHubChatThread(
  tx: GitHubChatThreadTransaction,
  args: GitHubChatThreadRouteKey & {
    readonly orgId: string;
    readonly agentComposeId: string;
    readonly selectedModel: string | null;
    readonly currentTime: Date;
  },
  computerUseHostId: string | null = null,
) {
  const [thread] = await tx
    .insert(chatThreads)
    .values({
      userId: args.userId,
      agentComposeId: args.agentComposeId,
      computerUseHostId,
      selectedModel: args.selectedModel,
      title: null,
      lastReadAt: args.currentTime,
      lastMessageAt: args.currentTime,
      createdAt: args.currentTime,
      updatedAt: args.currentTime,
    })
    .returning({ id: chatThreads.id, createdAt: chatThreads.createdAt });
  if (!thread) {
    throw new Error("Failed to create canonical GitHub chat thread");
  }
  return thread;
}

async function appendCreatedEvent(
  tx: GitHubChatThreadTransaction,
  args: GitHubChatThreadRouteKey & {
    readonly orgId: string;
    readonly agentComposeId: string;
    readonly selectedModel: string | null;
  },
  thread: { readonly id: string; readonly createdAt: Date },
  computerUseHostId: string | null | undefined,
): Promise<void> {
  await appendChatThreadEvent(tx, {
    kind: "created",
    userId: args.userId,
    orgId: args.orgId,
    chatThreadId: thread.id,
    agentComposeId: args.agentComposeId,
    title: null,
    selectedModel: args.selectedModel,
    computerUseHostId,
    createdAt: thread.createdAt,
  });
}

async function reconcileExistingRoute(
  tx: GitHubChatThreadTransaction,
  args: GitHubChatThreadRouteKey & {
    readonly orgId: string;
    readonly agentComposeId: string;
    readonly selectedModel: string | null;
    readonly currentTime: Date;
  },
  existing: LoadedGitHubChatThreadRoute,
): Promise<GitHubChatThreadRouteBinding> {
  if (existing.agentComposeId !== args.agentComposeId) {
    const thread = await createCanonicalGitHubChatThread(
      tx,
      args,
      existing.computerUseHostId,
    );
    const [route] = await tx
      .update(githubChatThreadRoutes)
      .set({ chatThreadId: thread.id, updatedAt: args.currentTime })
      .where(
        and(
          eq(githubChatThreadRoutes.id, existing.id),
          eq(githubChatThreadRoutes.chatThreadId, existing.chatThreadId),
        ),
      )
      .returning();
    if (!route) {
      throw new Error("Failed to rebind GitHub chat thread route");
    }
    await appendCreatedEvent(tx, args, thread, existing.computerUseHostId);
    return route;
  }

  if (existing.selectedModel !== args.selectedModel) {
    const [thread] = await tx
      .update(chatThreads)
      .set({
        modelProviderId: null,
        modelProviderType: null,
        modelProviderCredentialScope: null,
        selectedModel: args.selectedModel,
        updatedAt: args.currentTime,
      })
      .where(eq(chatThreads.id, existing.chatThreadId))
      .returning({ id: chatThreads.id });
    if (!thread) {
      throw new Error("Failed to update canonical GitHub chat thread model");
    }
    await appendChatThreadEvent(tx, {
      kind: "model_selection_updated",
      userId: args.userId,
      orgId: args.orgId,
      chatThreadId: existing.chatThreadId,
      agentComposeId: existing.agentComposeId,
      selectedModel: args.selectedModel,
      createdAt: args.currentTime,
    });
  }
  return existing;
}

export async function ensureGitHubChatThreadRoute(
  db: Db,
  args: GitHubChatThreadRouteKey & {
    readonly orgId: string;
    readonly agentComposeId: string;
    readonly selectedModel: string | null;
    readonly currentTime: Date;
  },
): Promise<GitHubChatThreadRouteBinding> {
  return await db.transaction(async (tx) => {
    const existing = await loadRoute(tx, args);
    if (existing) {
      return await reconcileExistingRoute(tx, args, existing);
    }

    const thread = await createCanonicalGitHubChatThread(tx, args);
    const [route] = await tx
      .insert(githubChatThreadRoutes)
      .values({
        installationId: args.installationId,
        repo: args.repo,
        subjectNumber: args.subjectNumber,
        userId: args.userId,
        chatThreadId: thread.id,
        createdAt: args.currentTime,
        updatedAt: args.currentTime,
      })
      .onConflictDoNothing({
        target: [
          githubChatThreadRoutes.installationId,
          githubChatThreadRoutes.repo,
          githubChatThreadRoutes.subjectNumber,
          githubChatThreadRoutes.userId,
        ],
      })
      .returning();

    if (!route) {
      await tx.delete(chatThreads).where(eq(chatThreads.id, thread.id));
      const conflicted = await loadRoute(tx, args);
      if (!conflicted) {
        throw new Error(
          "Failed to resolve GitHub chat thread route after conflict",
        );
      }
      return await reconcileExistingRoute(tx, args, conflicted);
    }

    await appendCreatedEvent(tx, args, thread, null);
    return route;
  });
}
