import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agents } from "@okouai/db/schema/agent";
import { orgMetadata } from "@okouai/db/schema/org-metadata";

import { env } from "../../lib/env";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { welcomeThreadContent } from "../../lib/welcome-thread-content";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { visibleJoinedAgentCondition } from "./agent-data.service";
import { insertChatEvent } from "./chat-event.service";
import { createChatThreadInTransaction } from "./chat-thread.service";
import { loadNewChatThreadMediaModels } from "./chat-thread-media-model.service";
import { chatThreadModelPinColumns } from "./chat-thread-model.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { resolveDefaultModelFirstPin } from "./model-selection.service";
import { userPreferences } from "./user-data.service";

interface WelcomeThreadAction {
  readonly userId: string;
  readonly orgId: string;
  readonly clientThreadId: string;
}

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
      return conflict(
        "The workspace default agent is unavailable. Ask a workspace admin to configure it, then retry.",
      );
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
      const thread = await createChatThreadInTransaction(tx, {
        ...args,
        agentId: agent.id,
        title: content.title,
        eventId: undefined,
        ...chatThreadModelPinColumns(pin),
        codexServiceTier: pin.serviceTier === "priority" ? "fast" : null,
        ...media,
      });
      signal.throwIfAborted();
      if (thread.kind === "created") {
        await insertChatEvent(tx, {
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
    // The id already belongs to another thread. Answer exactly like a thread
    // that does not exist so a collision discloses no ownership.
    if (result.kind === "client_thread_conflict") {
      return notFound("Chat thread not found");
    }
    return { status: 201 as const, body: { id: result.id } };
  },
);
