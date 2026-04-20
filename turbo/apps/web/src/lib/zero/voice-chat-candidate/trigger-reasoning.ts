import "server-only";
import { after } from "next/server";
import { and, eq } from "drizzle-orm";
import { featureCandidateVoiceChatSessions } from "../../../db/schema/voice-chat-candidate";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../db/schema/agent-compose";
import {
  appendVoiceChatCandidateItem,
  readVoiceChatCandidateItems,
} from "./item-service";
import { listPendingVoiceChatCandidateTasks } from "./task-service";
import { callReasoner } from "./reasoner";
import { publishUserSignal } from "../../infra/realtime/client";
import { isBadRequest } from "../../shared/errors";
import { logger } from "../../shared/logger";

const log = logger("zero:voice-chat-candidate:trigger-reasoning");

export async function triggerReasoning(sessionId: string): Promise<void> {
  const db = globalThis.services.db;

  // Step 0 — load session and bail early on unknown/ended sessions.
  const [session] = await db
    .select()
    .from(featureCandidateVoiceChatSessions)
    .where(eq(featureCandidateVoiceChatSessions.id, sessionId))
    .limit(1);
  if (!session) return;
  if (session.status !== "active") return;

  // Step 1 — CAS acquire. Only the tick that flips idle→running owns the
  // lock. A losing racer sets reasoning_pending=true and exits; whichever
  // tick releases the lock will observe and drain the pending flag.
  const acquired = await db
    .update(featureCandidateVoiceChatSessions)
    .set({ reasoningStatus: "running" })
    .where(
      and(
        eq(featureCandidateVoiceChatSessions.id, sessionId),
        eq(featureCandidateVoiceChatSessions.reasoningStatus, "idle"),
      ),
    )
    .returning({ id: featureCandidateVoiceChatSessions.id });

  if (acquired.length === 0) {
    // Losing racer: flag that work is pending and report back the current
    // status. If the holder already flipped status→idle and ran drainPending
    // before we set the flag, our signal would be lost — schedule a re-tick
    // ourselves in that case.
    const [row] = await db
      .update(featureCandidateVoiceChatSessions)
      .set({ reasoningPending: true })
      .where(eq(featureCandidateVoiceChatSessions.id, sessionId))
      .returning({ status: featureCandidateVoiceChatSessions.reasoningStatus });
    if (row?.status === "idle") {
      after(() => {
        return triggerReasoning(sessionId);
      });
    }
    return;
  }

  // Step 2 — snapshot new items + pending tasks. If neither has anything to
  // reason about, skip the LLM call entirely and just release the lock.
  const newItems = await readVoiceChatCandidateItems(
    sessionId,
    session.contextSeq,
  );
  const pendingTasks = await listPendingVoiceChatCandidateTasks(sessionId);

  if (newItems.length === 0 && pendingTasks.length === 0) {
    await releaseAndDrain(sessionId);
    return;
  }

  // Step 3 — resolve the agent "system prompt". AgentComposeYaml has no
  // dedicated systemPrompt field, so we use the first agent's description
  // as the closest available semantic slot; empty string otherwise.
  const agentSystemPrompt = await resolveAgentSystemPrompt(session.agentId);

  // Step 4 — determine the highest seq we are about to snapshot against,
  // which becomes the session's new contextSeq on a successful write.
  const newMaxSeq =
    newItems.length > 0
      ? Math.max(
          ...newItems.map((i) => {
            return i.seq;
          }),
        )
      : session.contextSeq;

  // Step 5 — call the Reasoner. Returns null on any failure path.
  const newContext = await callReasoner({
    agentSystemPrompt,
    currentContext: session.context,
    newItems: newItems.map((i) => {
      return {
        seq: i.seq,
        role: i.role,
        content: i.content,
      };
    }),
    pendingTasks: pendingTasks.map((t) => {
      return {
        id: t.id,
        status: t.status,
        prompt: t.prompt,
      };
    }),
  });

  if (newContext !== null) {
    // Step 6a — optimistic context_version write. If another tick wrote
    // ahead of us, the update affects 0 rows and we silently drop — the
    // next trigger cycle will reconcile.
    const updated = await db
      .update(featureCandidateVoiceChatSessions)
      .set({
        context: newContext,
        contextSeq: newMaxSeq,
        contextVersion: session.contextVersion + 1,
        lastReasoningAt: new Date(),
        reasoningStatus: "idle",
      })
      .where(
        and(
          eq(featureCandidateVoiceChatSessions.id, sessionId),
          eq(
            featureCandidateVoiceChatSessions.contextVersion,
            session.contextVersion,
          ),
        ),
      )
      .returning({ id: featureCandidateVoiceChatSessions.id });

    if (updated.length > 0) {
      await publishUserSignal(
        [session.userId],
        `voice-chat-candidate:${sessionId}`,
      );
    } else {
      log.info(`reasoner version contention for ${sessionId}, dropping tick`);
      await db
        .update(featureCandidateVoiceChatSessions)
        .set({ reasoningStatus: "idle" })
        .where(eq(featureCandidateVoiceChatSessions.id, sessionId));
    }
  } else {
    // Step 6b — reasoner returned null (missing key / HTTP error / empty /
    // timeout / network). Record a system_note so the session transcript
    // carries the failure signal, then release the lock. If the session
    // ended between acquire and now, append throws badRequest — swallow
    // only that specific case so the lock still gets released.
    try {
      await appendVoiceChatCandidateItem({
        sessionId,
        role: "system_note",
        content: "Reasoner tick failed",
        realtimeItemId: null,
      });
    } catch (err) {
      if (!isBadRequest(err)) throw err;
    }
    await db
      .update(featureCandidateVoiceChatSessions)
      .set({ reasoningStatus: "idle", lastReasoningAt: new Date() })
      .where(eq(featureCandidateVoiceChatSessions.id, sessionId));
  }

  // Step 7 — drain pending flag. If another trigger arrived while we were
  // running, the flag was set; clear it and schedule a re-tick so the new
  // items are picked up.
  await drainPending(sessionId);
}

async function releaseAndDrain(sessionId: string): Promise<void> {
  const db = globalThis.services.db;
  await db
    .update(featureCandidateVoiceChatSessions)
    .set({ reasoningStatus: "idle" })
    .where(eq(featureCandidateVoiceChatSessions.id, sessionId));
  await drainPending(sessionId);
}

async function drainPending(sessionId: string): Promise<void> {
  const db = globalThis.services.db;
  const drained = await db
    .update(featureCandidateVoiceChatSessions)
    .set({ reasoningPending: false })
    .where(
      and(
        eq(featureCandidateVoiceChatSessions.id, sessionId),
        eq(featureCandidateVoiceChatSessions.reasoningPending, true),
      ),
    )
    .returning({ id: featureCandidateVoiceChatSessions.id });

  if (drained.length > 0) {
    after(() => {
      return triggerReasoning(sessionId);
    });
  }
}

export async function resolveAgentSystemPrompt(
  agentId: string | null,
): Promise<string> {
  if (!agentId) return "";
  const db = globalThis.services.db;
  const [row] = await db
    .select({ content: agentComposeVersions.content })
    .from(agentComposes)
    .leftJoin(
      agentComposeVersions,
      eq(agentComposeVersions.id, agentComposes.headVersionId),
    )
    .where(eq(agentComposes.id, agentId))
    .limit(1);
  if (!row?.content || typeof row.content !== "object") return "";
  const content = row.content as {
    agents?: Record<string, { description?: string }>;
  };
  const firstAgent = content.agents
    ? Object.values(content.agents)[0]
    : undefined;
  return firstAgent?.description ?? "";
}
