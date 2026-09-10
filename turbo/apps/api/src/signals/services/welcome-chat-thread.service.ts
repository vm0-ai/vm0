import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { orgMetadata } from "@okouai/db/schema/org-metadata";

import { env } from "../../lib/env";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { welcomeThreadContent } from "../../lib/welcome-thread-content";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { visibleJoinedAgentCondition } from "./agent-data.service";
import { insertChatEvent } from "./chat-event.service";
import { readCurrentChatEventHistory } from "./chat-event-history.service";
import { createChatThreadInTransaction } from "./chat-thread.service";
import { loadNewChatThreadMediaModels } from "./chat-thread-media-model.service";
import { chatThreadModelPinColumns } from "./chat-thread-model.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { resolveDefaultModelFirstPin } from "./model-selection.service";
import { userPreferences } from "./user-data.service";

// Permanent server namespace, independent of template versions. Only welcome
// creation writes a runless output.message with this identity as the first row.
const WELCOME_SEED_NAMESPACE = "6544eaa2-1b91-4b5b-9cb2-d67818de47a7";

interface WelcomeThreadAction {
  readonly userId: string;
  readonly orgId: string;
  readonly clientThreadId: string;
}

function welcomeCreated(id: string) {
  return { status: 201 as const, body: { id } };
}

const replayWelcomeThread$ = command(
  async ({ get, set }, args: WelcomeThreadAction, signal: AbortSignal) => {
    const db = set(writeDb$);
    const [thread] = await db
      .select({
        id: chatThreads.id,
        userId: chatThreads.userId,
        orgId: agents.orgId,
        owner: agents.owner,
        visibility: agents.visibility,
      })
      .from(chatThreads)
      .innerJoin(agents, eq(agents.id, chatThreads.agentId))
      .where(eq(chatThreads.id, args.clientThreadId))
      .limit(1);
    signal.throwIfAborted();
    if (!thread) {
      return null;
    }
    if (
      thread.userId !== args.userId ||
      thread.orgId !== args.orgId ||
      (thread.visibility === "private" && thread.owner !== args.userId)
    ) {
      return notFound("Chat thread not found");
    }

    // The standard repeatable-read history combines the immutable snapshot
    // with its PostgreSQL tail, even after hot-row retention. Do not infer
    // welcome provenance from an arbitrary owned thread or current copy.
    const history = await get(
      readCurrentChatEventHistory(
        { db, bucket: env("R2_USER_STORAGES_BUCKET_NAME") },
        thread.id,
        signal,
      ),
    );
    signal.throwIfAborted();
    const seedId = uuidv5(thread.id, WELCOME_SEED_NAMESPACE);
    const seeded = history.some((event) => {
      return (
        event.id === seedId &&
        event.seqId === 1 &&
        event.runId === null &&
        event.eventType === "output.message"
      );
    });
    return seeded
      ? welcomeCreated(thread.id)
      : conflict("This clientThreadId already belongs to a non-welcome thread");
  },
);

export const createWelcomeChatThread$ = command(
  async ({ get, set }, args: WelcomeThreadAction, signal: AbortSignal) => {
    const db = set(writeDb$);
    const switches = await loadUserFeatureSwitchContext(
      db,
      args.orgId,
      args.userId,
    );
    signal.throwIfAborted();
    if (!isFeatureEnabled(FeatureSwitchKey.WelcomeThread, switches)) {
      return {
        status: 403 as const,
        body: {
          error: {
            code: "FORBIDDEN",
            message: "Welcome thread is not enabled",
          },
        },
      };
    }

    // Replays authorize the stored thread before resolving today's default
    // agent, model or locale, so changed preferences cannot rewrite the result.
    const existing = await set(replayWelcomeThread$, args, signal);
    signal.throwIfAborted();
    if (existing) {
      return existing;
    }

    const [agent] = await db
      .select({ id: agents.id })
      .from(orgMetadata)
      .innerJoin(
        agents,
        and(
          eq(agents.id, orgMetadata.defaultAgentId),
          eq(agents.orgId, orgMetadata.orgId),
          visibleJoinedAgentCondition(args.userId),
        ),
      )
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);
    signal.throwIfAborted();
    if (!agent) {
      return {
        status: 409 as const,
        body: {
          error: {
            code: "DEFAULT_AGENT_NOT_READY" as const,
            message:
              "The workspace default agent is unavailable. Ask a workspace admin to configure it, then retry.",
          },
        },
      };
    }

    const pin = await resolveDefaultModelFirstPin(db, args.orgId, args.userId);
    signal.throwIfAborted();
    const media = await loadNewChatThreadMediaModels(db, args);
    signal.throwIfAborted();
    const preferences = await get(userPreferences(args));
    signal.throwIfAborted();
    const content = welcomeThreadContent({
      locale: preferences.locale ?? "en-US",
      appUrl: env("APP_URL"),
    });

    const result = await db.transaction(async (tx) => {
      const thread = await createChatThreadInTransaction(
        tx,
        {
          ...args,
          agentId: agent.id,
          title: content.title,
          eventId: undefined,
          ...chatThreadModelPinColumns(pin),
          codexServiceTier: pin.serviceTier === "priority" ? "fast" : null,
          ...media,
        },
        "id",
      );
      signal.throwIfAborted();
      if (thread.kind === "created") {
        await insertChatEvent(tx, {
          id: uuidv5(thread.id, WELCOME_SEED_NAMESPACE),
          chatThreadId: thread.id,
          eventType: "output.message",
          content: content.content,
          createdAt: nowDate(),
        });
        signal.throwIfAborted();
      }
      return thread;
    });
    signal.throwIfAborted();
    if (result.kind === "invalid_connector_selection") {
      return badRequestMessage(result.message);
    }
    if (result.kind === "client_thread_conflict") {
      // ON CONFLICT waits for the winning transaction to commit. Verify its
      // complete provenance after releasing our transaction/connection.
      return (
        (await set(replayWelcomeThread$, args, signal)) ??
        notFound("Chat thread not found")
      );
    }
    return welcomeCreated(result.id);
  },
);
