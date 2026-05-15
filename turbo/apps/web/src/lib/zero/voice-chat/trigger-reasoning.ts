import "server-only";
import { after } from "next/server";
import { and, eq } from "drizzle-orm";
import { voiceChatSessions } from "@vm0/db/schema/voice-chat";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { appendVoiceChatItem, readVoiceChatItems } from "./item-service";
import { createVoiceChatTask, listSessionTasks } from "./task-service";
import { callReasoner } from "./reasoner";
import { compactVoiceChatTaskResults } from "./compact-task-results";
import { buildSlowBrainAppendSystemPrompt } from "./build-slow-brain-prompt";
import { adaptVoiceChatTaskTrigger } from "./adapt-task-trigger";
import { createZeroRun } from "../zero-run-service";
import { publishUserSignal } from "../../infra/realtime/client";
import { isBadRequest } from "@vm0/api-services/errors";
import { logger } from "../../shared/logger";

const log = logger("zero:voice-chat:trigger-reasoning");

interface AssistantInterruptedNote {
  type: "assistant_interrupted";
  assistantRealtimeItemId: string;
  heardText: string;
  audioEndMs?: number;
}

export async function triggerReasoning(sessionId: string): Promise<void> {
  const db = globalThis.services.db;

  // Step 0 — load session and bail early on unknown sessions. Sessions
  // themselves are stateless; there's no "ended" concept to gate on.
  const [session] = await db
    .select()
    .from(voiceChatSessions)
    .where(eq(voiceChatSessions.id, sessionId))
    .limit(1);
  if (!session) return;

  // Step 1 — CAS acquire. Only the tick that flips idle→running owns the
  // lock. A losing racer sets reasoning_pending=true and exits; whichever
  // tick releases the lock will observe and drain the pending flag. We also
  // stamp lastReasoningStartedAt here so that releaseLock below can compute
  // the tick duration on any exit path.
  const startedAt = new Date();
  const acquired = await db
    .update(voiceChatSessions)
    .set({
      reasoningStatus: "running",
      lastReasoningStartedAt: startedAt,
      lastReasoningDurationMs: null,
    })
    .where(
      and(
        eq(voiceChatSessions.id, sessionId),
        eq(voiceChatSessions.reasoningStatus, "idle"),
      ),
    )
    .returning({ id: voiceChatSessions.id });

  if (acquired.length === 0) {
    // Losing racer: flag that work is pending and report back the current
    // status. If the holder already flipped status→idle and ran drainPending
    // before we set the flag, our signal would be lost — schedule a re-tick
    // ourselves in that case.
    const [row] = await db
      .update(voiceChatSessions)
      .set({ reasoningPending: true })
      .where(eq(voiceChatSessions.id, sessionId))
      .returning({ status: voiceChatSessions.reasoningStatus });
    if (row?.status === "idle") {
      after(() => {
        return triggerReasoning(sessionId);
      });
    }
    return;
  }

  // Step 1b — re-read the session after winning the CAS lock. The snapshot
  // from step 0 may be stale if another tick completed between step 0 and the
  // CAS acquisition. Using the stale summarySeq / summaryVersion would cause
  // a spurious reasoner call and a guaranteed version-contention drop on the
  // write, wasting an LLM round-trip.
  const [freshSession] = await db
    .select()
    .from(voiceChatSessions)
    .where(eq(voiceChatSessions.id, sessionId))
    .limit(1);
  if (!freshSession) {
    await db
      .update(voiceChatSessions)
      .set({
        reasoningStatus: "idle",
        lastReasoningDurationMs: Date.now() - startedAt.getTime(),
      })
      .where(eq(voiceChatSessions.id, sessionId));
    return;
  }
  const currentSession = freshSession;

  // Step 2 — snapshot full transcript + all tasks. The Reasoner compacts
  // everything itself, so we give it the full state each tick rather than
  // deltas. If nothing has happened since the last tick, skip the LLM call.
  const transcript = await readVoiceChatItems(sessionId);
  const effectiveTranscript = buildReasonerTranscript(transcript);
  const tasks = await listSessionTasks(sessionId);

  const maxSeq =
    transcript.length > 0
      ? Math.max(
          ...transcript.map((i) => {
            return i.seq;
          }),
        )
      : currentSession.summarySeq;

  // Debounce bail-out: no new items since the last summary AND no in-flight
  // tasks that might warrant a re-summarization. The loser of a concurrent
  // trigger race lands here after the winner completes, avoiding a redundant
  // LLM round-trip.
  const hasInFlightTask = tasks.some((t) => {
    return (
      t.status === "pending" || t.status === "queued" || t.status === "running"
    );
  });
  if (maxSeq === currentSession.summarySeq && !hasInFlightTask) {
    // Even when reasoner has nothing to do, old finished-task results may
    // have drifted past the compaction interval — run the compactor before
    // releasing the lock. The compactor itself fans out an Ably signal when
    // it actually shrinks a row, so we don't publish here.
    await compactVoiceChatTaskResults(sessionId, currentSession.userId);
    await releaseAndDrain(sessionId, startedAt);
    return;
  }

  // Step 3 — resolve the agent "system prompt". AgentComposeYaml has no
  // dedicated systemPrompt field, so we use the first agent's description
  // as the closest available semantic slot; empty string otherwise.
  const agentSystemPrompt = await resolveAgentSystemPrompt(
    currentSession.agentId,
  );

  // Step 4 — call the Reasoner. Returns null on any failure path.
  const result = await callReasoner({
    agentSystemPrompt,
    priorConversationSummary: currentSession.conversationSummary,
    transcript: effectiveTranscript.map((i) => {
      return {
        seq: i.seq,
        role: i.role,
        content: i.content,
        createdAt: i.createdAt.toISOString(),
      };
    }),
    tasks: tasks.map((t) => {
      return {
        id: t.id,
        status: t.status,
        prompt: t.prompt,
        resultText: t.result ?? flattenTaskResult(t.assistantMessages),
        error: t.error,
        createdAt: t.createdAt.toISOString(),
        startedAt: t.startedAt?.toISOString() ?? null,
        finishedAt: t.finishedAt?.toISOString() ?? null,
      };
    }),
  });

  if (result !== null) {
    // Step 5a — optimistic summary_version write. If another tick wrote
    // ahead of us, the update affects 0 rows and we silently drop — the
    // next trigger cycle will reconcile.
    // Reasoner now only produces conversationSummary. The working/finished
    // summary columns still exist in the schema but are unused — the Talker's
    // Task board reads live state from the tasks table.
    const updated = await db
      .update(voiceChatSessions)
      .set({
        conversationSummary: result.conversationSummary,
        summarySeq: maxSeq,
        summaryVersion: currentSession.summaryVersion + 1,
        lastSummaryAt: new Date(),
        reasoningStatus: "idle",
        lastReasoningDurationMs: Date.now() - startedAt.getTime(),
      })
      .where(
        and(
          eq(voiceChatSessions.id, sessionId),
          eq(voiceChatSessions.summaryVersion, currentSession.summaryVersion),
        ),
      )
      .returning({ id: voiceChatSessions.id });

    if (updated.length > 0) {
      await publishUserSignal(
        [currentSession.userId],
        `voice-chat:${sessionId}`,
      );
    } else {
      log.info(`reasoner version contention for ${sessionId}, dropping tick`);
      await db
        .update(voiceChatSessions)
        .set({
          reasoningStatus: "idle",
          lastReasoningDurationMs: Date.now() - startedAt.getTime(),
        })
        .where(eq(voiceChatSessions.id, sessionId));
    }
  } else {
    // Step 5b — reasoner returned null (missing key / HTTP error / empty /
    // timeout / network). Record a system_note so the session transcript
    // carries the failure signal, then release the lock. If the session
    // ended between acquire and now, append throws badRequest — swallow
    // only that specific case so the lock still gets released.
    try {
      await appendVoiceChatItem({
        sessionId,
        role: "system_note",
        content: "Reasoner tick failed",
        realtimeItemId: null,
      });
    } catch (err) {
      if (!isBadRequest(err)) throw err;
    }
    await db
      .update(voiceChatSessions)
      .set({
        reasoningStatus: "idle",
        lastSummaryAt: new Date(),
        lastReasoningDurationMs: Date.now() - startedAt.getTime(),
      })
      .where(eq(voiceChatSessions.id, sessionId));
  }

  // Step 5c — if the Reasoner detected tasks the Talker promised but never
  // dispatched, create them now. This runs after the lock is released so
  // slow spawnRun calls do not block concurrent ticks.
  if (
    result !== null &&
    result.missingTasks.length > 0 &&
    currentSession.agentId
  ) {
    const agentId = currentSession.agentId;
    const apiStartTime = Date.now();
    const appendSystemPrompt = buildSlowBrainAppendSystemPrompt({
      agentSystemPrompt,
      items: transcript,
      sessionTasks: tasks,
    });

    for (let i = 0; i < result.missingTasks.length; i++) {
      const prompt = result.missingTasks[i];
      if (!prompt) continue;
      await createVoiceChatTask({
        sessionId,
        callId: `reasoner-auto-${apiStartTime}-${String(i)}`,
        prompt,
        spawnRun: (taskId) => {
          const runParams = adaptVoiceChatTaskTrigger({
            userId: currentSession.userId,
            agentId,
            taskId,
            prompt,
            appendSystemPrompt,
            apiStartTime,
          });
          return createZeroRun(runParams);
        },
      });
      await appendVoiceChatItem({
        sessionId,
        role: "system_note",
        content: `Reasoner auto-created task: ${prompt}`,
        realtimeItemId: null,
      });
    }

    await publishUserSignal([currentSession.userId], `voice-chat:${sessionId}`);
  }

  // Step 6 — compact old finished-task results along the exponential
  // schedule. Cheap no-op when nothing is due. The compactor itself fans
  // out an Ably signal when it actually shrinks a row, so the browser
  // picks up post-compact task results even if the reasoner write above
  // lost to version contention.
  await compactVoiceChatTaskResults(sessionId, currentSession.userId);

  // Step 7 — drain pending flag. If another trigger arrived while we were
  // running, the flag was set; clear it and schedule a re-tick so the new
  // items are picked up.
  await drainPending(sessionId);
}

function buildReasonerTranscript(
  items: Awaited<ReturnType<typeof readVoiceChatItems>>,
): Array<{
  seq: number;
  role: string;
  content: string | null;
  createdAt: Date;
}> {
  const interrupted = new Map<
    string,
    { heardText: string; seq: number; createdAt: Date; consumed: boolean }
  >();

  for (const item of items) {
    if (item.role !== "system_note" || !item.content) {
      continue;
    }
    const note = parseAssistantInterruptedNote(item.content);
    if (!note) {
      continue;
    }
    interrupted.set(note.assistantRealtimeItemId, {
      heardText: note.heardText,
      seq: item.seq,
      createdAt: item.createdAt,
      consumed: false,
    });
  }

  const transcript: Array<{
    seq: number;
    role: string;
    content: string | null;
    createdAt: Date;
  }> = [];

  for (const item of items) {
    if (item.role === "system_note") {
      if (item.content && parseAssistantInterruptedNote(item.content)) {
        continue;
      }
      transcript.push(item);
      continue;
    }

    if (
      item.role === "assistant" &&
      item.realtimeItemId &&
      interrupted.has(item.realtimeItemId)
    ) {
      const replacement = interrupted.get(item.realtimeItemId)!;
      replacement.consumed = true;
      if (replacement.heardText.trim()) {
        transcript.push({
          ...item,
          content: replacement.heardText,
        });
      }
      continue;
    }

    transcript.push(item);
  }

  for (const [, replacement] of interrupted) {
    if (!replacement.consumed && replacement.heardText.trim()) {
      transcript.push({
        seq: replacement.seq,
        role: "assistant",
        content: replacement.heardText,
        createdAt: replacement.createdAt,
      });
    }
  }

  transcript.sort((a, b) => {
    return a.seq - b.seq;
  });
  return transcript;
}

function parseAssistantInterruptedNote(
  content: string,
): AssistantInterruptedNote | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    log.warn(`failed to parse assistant interrupted note: ${content}`);
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const note = parsed as Partial<AssistantInterruptedNote>;
  if (
    note.type !== "assistant_interrupted" ||
    typeof note.assistantRealtimeItemId !== "string" ||
    typeof note.heardText !== "string"
  ) {
    return null;
  }
  return {
    type: "assistant_interrupted",
    assistantRealtimeItemId: note.assistantRealtimeItemId,
    heardText: note.heardText,
    audioEndMs: note.audioEndMs,
  };
}

function flattenTaskResult(
  result: Array<{ type: "assistant"; content: string; at: string }>,
): string | null {
  if (result.length === 0) return null;
  return result
    .map((entry) => {
      return entry.content;
    })
    .join("\n");
}

async function releaseAndDrain(
  sessionId: string,
  startedAt: Date,
): Promise<void> {
  const db = globalThis.services.db;
  await db
    .update(voiceChatSessions)
    .set({
      reasoningStatus: "idle",
      lastReasoningDurationMs: Date.now() - startedAt.getTime(),
    })
    .where(eq(voiceChatSessions.id, sessionId));
  await drainPending(sessionId);
}

async function drainPending(sessionId: string): Promise<void> {
  const db = globalThis.services.db;
  const drained = await db
    .update(voiceChatSessions)
    .set({ reasoningPending: false })
    .where(
      and(
        eq(voiceChatSessions.id, sessionId),
        eq(voiceChatSessions.reasoningPending, true),
      ),
    )
    .returning({ id: voiceChatSessions.id });

  if (drained.length > 0) {
    after(() => {
      return triggerReasoning(sessionId);
    });
  }
}

async function resolveAgentSystemPrompt(
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
