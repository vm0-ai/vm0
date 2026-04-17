import { eq, and, gt, lt, desc, isNull } from "drizzle-orm";
import { voiceChatPreparations } from "../../../db/schema/voice-chat";
import { createZeroRun, type CreateZeroRunResult } from "../zero-run-service";
import {
  buildVoiceChatPrepareOnlyPrompt,
  buildVoiceChatMeetingPreparePrompt,
} from "../integration-prompt";
import { generateCallbackSecret, getApiUrl } from "../../infra/callback";
import type { VoiceChatPrepareCallbackPayload } from "../../infra/callback/callback-payloads";
import { logger } from "../../shared/logger";

const log = logger("zero:voice-chat:preparation");

const PREPARATION_FRESHNESS_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function findFreshPreparation(
  orgId: string,
  userId: string,
  agentId: string,
  mode: string,
  prompt?: string,
): Promise<{ id: string; directiveContent: string } | null> {
  const db = globalThis.services.db;
  const threshold = new Date(Date.now() - PREPARATION_FRESHNESS_MS);

  const conditions = [
    eq(voiceChatPreparations.orgId, orgId),
    eq(voiceChatPreparations.userId, userId),
    eq(voiceChatPreparations.agentId, agentId),
    eq(voiceChatPreparations.mode, mode),
    eq(voiceChatPreparations.status, "ready"),
    gt(voiceChatPreparations.createdAt, threshold),
  ];

  if (prompt) {
    conditions.push(eq(voiceChatPreparations.prompt, prompt));
  } else {
    conditions.push(isNull(voiceChatPreparations.prompt));
  }

  const [result] = await db
    .select({
      id: voiceChatPreparations.id,
      directiveContent: voiceChatPreparations.directiveContent,
    })
    .from(voiceChatPreparations)
    .where(and(...conditions))
    .orderBy(desc(voiceChatPreparations.createdAt))
    .limit(1);

  if (!result?.directiveContent) return null;
  return { id: result.id, directiveContent: result.directiveContent };
}

export async function listFreshPreparations(
  orgId: string,
  userId: string,
): Promise<
  {
    id: string;
    mode: string;
    prompt: string | null;
    agentId: string | null;
    createdAt: Date;
  }[]
> {
  const db = globalThis.services.db;
  const threshold = new Date(Date.now() - PREPARATION_FRESHNESS_MS);

  return db
    .select({
      id: voiceChatPreparations.id,
      mode: voiceChatPreparations.mode,
      prompt: voiceChatPreparations.prompt,
      agentId: voiceChatPreparations.agentId,
      createdAt: voiceChatPreparations.createdAt,
    })
    .from(voiceChatPreparations)
    .where(
      and(
        eq(voiceChatPreparations.orgId, orgId),
        eq(voiceChatPreparations.userId, userId),
        eq(voiceChatPreparations.status, "ready"),
        eq(voiceChatPreparations.mode, "meeting"),
        gt(voiceChatPreparations.createdAt, threshold),
      ),
    )
    .orderBy(desc(voiceChatPreparations.createdAt))
    .limit(5);
}

// ---------------------------------------------------------------------------
// CRUD Operations
// ---------------------------------------------------------------------------

export async function createPreparation(
  orgId: string,
  userId: string,
  agentId: string,
  mode: string,
  prompt?: string,
) {
  const db = globalThis.services.db;
  const [row] = await db
    .insert(voiceChatPreparations)
    .values({
      orgId,
      userId,
      agentId,
      mode,
      prompt: prompt ?? null,
      status: "preparing",
    })
    .returning();
  return row!;
}

export async function updatePreparationStatus(
  id: string,
  status: string,
  directiveContent?: string,
) {
  const db = globalThis.services.db;
  const updates: Record<string, unknown> = { status };
  if (directiveContent !== undefined) {
    updates.directiveContent = directiveContent;
  }
  const [row] = await db
    .update(voiceChatPreparations)
    .set(updates)
    .where(eq(voiceChatPreparations.id, id))
    .returning();
  return row ?? null;
}

export async function findInFlightPreparation(
  orgId: string,
  userId: string,
  agentId: string,
  mode: string,
) {
  const db = globalThis.services.db;
  const [row] = await db
    .select()
    .from(voiceChatPreparations)
    .where(
      and(
        eq(voiceChatPreparations.orgId, orgId),
        eq(voiceChatPreparations.userId, userId),
        eq(voiceChatPreparations.agentId, agentId),
        eq(voiceChatPreparations.mode, mode),
        eq(voiceChatPreparations.status, "preparing"),
      ),
    )
    .orderBy(desc(voiceChatPreparations.createdAt))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function dispatchPreparationRun(
  preparationId: string,
  userId: string,
  agentId: string,
  options?: { mode?: "chat" | "meeting"; prompt?: string },
): Promise<CreateZeroRunResult> {
  const db = globalThis.services.db;
  const meetingPrompt =
    options?.mode === "meeting" ? options.prompt : undefined;

  const appendSystemPrompt = meetingPrompt
    ? buildVoiceChatMeetingPreparePrompt(meetingPrompt)
    : buildVoiceChatPrepareOnlyPrompt();

  const prompt = meetingPrompt
    ? "You are Zero preparing for a voice meeting. Research the meeting topic and prepare a comprehensive briefing."
    : "You are Zero preparing for a voice chat. Review the agent configuration and user context, then output an initial directive.";

  const callbackPayload: VoiceChatPrepareCallbackPayload = { preparationId };

  const result = await createZeroRun({
    userId,
    agentId,
    prompt,
    appendSystemPrompt,
    triggerSource: "voice-chat",
    callbacks: [
      {
        url: `${getApiUrl()}/api/internal/callbacks/voice-chat-prepare`,
        secret: generateCallbackSecret(),
        payload: callbackPayload,
      },
    ],
  });

  await db
    .update(voiceChatPreparations)
    .set({ runId: result.runId })
    .where(eq(voiceChatPreparations.id, preparationId));

  return result;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export async function deleteExpiredPreparations(ttlMs: number) {
  const db = globalThis.services.db;
  const threshold = new Date(Date.now() - ttlMs);

  const deleted = await db
    .delete(voiceChatPreparations)
    .where(lt(voiceChatPreparations.createdAt, threshold))
    .returning({ id: voiceChatPreparations.id });

  if (deleted.length > 0) {
    log.info("Expired preparations cleaned up", { cleaned: deleted.length });
  }

  return deleted;
}
