import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { voiceChatTasks } from "../../../db/schema/voice-chat";
import { env } from "../../../env";
import { publishUserSignal } from "../../infra/realtime/client";
import { logger } from "../../shared/logger";

/**
 * Minimum length for a compacted result. Once a task's result shrinks to
 * this, we stop compacting it further — it already represents "a very short
 * summary".
 */
const MIN_RESULT_LEN = 300;

/**
 * Per-minute exponential shrink ratio. After `m` minutes the target length
 * is `currentLen * SHRINK_PER_MINUTE**m` (floored at MIN_RESULT_LEN).
 */
const SHRINK_PER_MINUTE = 0.9;

/**
 * Minimum elapsed time since the last write to result before we consider
 * compacting again. Matches the semantics of "once per minute".
 */
const COMPACT_INTERVAL_MS = 60_000;

/**
 * Skip compaction when the target length would only shrink the current by
 * less than this fraction — not worth an LLM round-trip.
 */
const MIN_SHRINK_FRACTION = 0.1;

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "anthropic/claude-sonnet-4.5";
const TIMEOUT_MS = 30_000;
const TEMPERATURE = 0.2;

const log = logger("zero:voice-chat:compact");

interface OpenRouterResponse {
  choices: Array<{ message: { content: string } }>;
}

function computeTargetLen(currentLen: number, elapsedMs: number): number {
  const minutes = elapsedMs / 60_000;
  const shrinkRatio = Math.pow(SHRINK_PER_MINUTE, minutes);
  return Math.max(MIN_RESULT_LEN, Math.floor(currentLen * shrinkRatio));
}

function buildCompactorPrompt(params: {
  prompt: string;
  currentResult: string;
  targetLen: number;
}): string {
  return [
    "You are compacting a past task result so it stays useful in a voice-chat assistant's long-running context.",
    `The user asked: ${params.prompt}`,
    `Current stored result (${String(params.currentResult.length)} chars):`,
    params.currentResult,
    `Compact this down to roughly ${String(params.targetLen)} characters. Keep only the facts, numbers, names, and conclusions most likely to be referenced later. Drop narrative, reasoning, and redundant detail. Plain text only — no markdown, no preamble, no meta-commentary. Output ONLY the compacted result.`,
  ].join("\n\n");
}

async function callCompactor(params: {
  prompt: string;
  currentResult: string;
  targetLen: number;
  apiKey: string;
}): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: buildCompactorPrompt(params) }],
        // Give the model a comfortable ceiling above the target length to
        // avoid mid-sentence cutoffs on the shorter end.
        max_tokens: Math.max(256, Math.ceil(params.targetLen / 2)),
        temperature: TEMPERATURE,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      log.warn("compactor fetch aborted (timeout)");
      return null;
    }
    if (err instanceof TypeError) {
      log.warn("compactor network error", err);
      return null;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text();
    log.warn(`compactor request failed: ${String(response.status)} ${text}`);
    return null;
  }

  const data = (await response.json()) as OpenRouterResponse;
  const content = data.choices[0]?.message.content?.trim();
  if (!content) {
    log.warn("compactor returned empty content");
    return null;
  }
  return content;
}

/**
 * For each done/failed task in the session whose `result` has drifted past
 * `COMPACT_INTERVAL_MS` since the last write, compact it further along an
 * exponential schedule until it approaches `MIN_RESULT_LEN`. Runs serially
 * per tick — long-tail cost shrinks on its own as results converge on the
 * floor. When at least one row is actually shrunk, fans out an Ably signal
 * to the given user so the Talker instruction can refresh; no-op publish
 * otherwise.
 */
export async function compactVoiceChatTaskResults(
  sessionId: string,
  userId: string,
): Promise<void> {
  const { OPENROUTER_API_KEY } = env();
  if (!OPENROUTER_API_KEY) return;

  const db = globalThis.services.db;
  const rows = await db
    .select()
    .from(voiceChatTasks)
    .where(
      and(
        eq(voiceChatTasks.sessionId, sessionId),
        inArray(voiceChatTasks.status, ["done", "failed"]),
      ),
    );

  const nowMs = Date.now();
  let compactedCount = 0;
  for (const row of rows) {
    // Bootstrap path: tasks completed before the `result` column was
    // populated (or any row where the compactor has never run) have
    // result=null but still carry the full stream in `assistantMessages`.
    // Treat the flattened stream as the "current result" and use
    // finishedAt (or createdAt as a last resort) as the effective
    // "resultUpdatedAt" so the schedule computes real age.
    const flattened = row.assistantMessages
      .map((e) => {
        return e.content;
      })
      .join("\n");
    const currentResult =
      row.result ?? (flattened.length > 0 ? flattened : null);
    const currentTimestamp =
      row.resultUpdatedAt ?? row.finishedAt ?? row.createdAt;
    if (!currentResult) continue;
    const currentLen = currentResult.length;
    if (currentLen <= MIN_RESULT_LEN) continue;

    const elapsedMs = nowMs - currentTimestamp.getTime();
    if (elapsedMs < COMPACT_INTERVAL_MS) continue;

    const targetLen = computeTargetLen(currentLen, elapsedMs);
    if ((currentLen - targetLen) / currentLen < MIN_SHRINK_FRACTION) continue;

    const compacted = await callCompactor({
      prompt: row.prompt,
      currentResult,
      targetLen,
      apiKey: OPENROUTER_API_KEY,
    });
    if (compacted === null) continue;

    await db
      .update(voiceChatTasks)
      .set({ result: compacted, resultUpdatedAt: new Date() })
      .where(eq(voiceChatTasks.id, row.id));
    compactedCount++;
  }

  if (compactedCount > 0) {
    await publishUserSignal([userId], `voice-chat:${sessionId}`);
    log.info(
      `compacted ${String(compactedCount)} task result(s) for session ${sessionId}`,
    );
  }
}
