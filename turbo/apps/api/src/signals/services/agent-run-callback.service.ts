import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import type { FeatureSwitchContext } from "@vm0/core/feature-switch";
import { and, eq, or } from "drizzle-orm";

import { env, optionalEnv } from "../../lib/env";
import { computeHmacSignature } from "../../lib/event-consumer/hmac";
import { logger } from "../../lib/log";
import type { Db } from "../external/db";
import { now, nowDate } from "../external/time";
import { settle } from "../utils";
import { decryptPersistentSecretValue } from "./crypto.utils";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";

const L = logger("AgentRunCallback");

interface CallbackRecord {
  readonly id: string;
  readonly url: string;
  readonly encryptedSecret: string;
  readonly payload: unknown;
}

interface DispatchResult {
  readonly callbackId: string;
  readonly success: boolean;
  readonly error?: string;
}

type TerminalCallbackStatus = "completed" | "failed";

interface DispatchSingleCallbackInput {
  readonly db: Db;
  readonly callback: CallbackRecord;
  readonly runId: string;
  readonly status: TerminalCallbackStatus;
  readonly result?: Record<string, unknown>;
  readonly error?: string;
  readonly featureSwitchContext: FeatureSwitchContext;
}

function resolveCallbackUrl(url: string): string {
  return env("ENV") === "development" && url.startsWith("https://tunnel-")
    ? url.replace(/^https:\/\/tunnel-[^/]+/, "http://localhost:3000")
    : url;
}

export async function dispatchRunCallbacks(
  db: Db,
  runId: string,
  status: TerminalCallbackStatus,
  result?: Record<string, unknown>,
  error?: string,
): Promise<DispatchResult[]> {
  const [run] = await db
    .select({
      orgId: agentRuns.orgId,
      userId: agentRuns.userId,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  if (!run) {
    return [];
  }
  const featureSwitchContext = await loadUserFeatureSwitchContext(
    db,
    run.orgId,
    run.userId,
  );
  const callbacks = await db
    .select({
      id: agentRunCallbacks.id,
      url: agentRunCallbacks.url,
      encryptedSecret: agentRunCallbacks.encryptedSecret,
      payload: agentRunCallbacks.payload,
    })
    .from(agentRunCallbacks)
    .where(
      and(
        eq(agentRunCallbacks.runId, runId),
        or(
          eq(agentRunCallbacks.status, "pending"),
          eq(agentRunCallbacks.status, "failed"),
        ),
      ),
    );

  const results: DispatchResult[] = [];
  for (const callback of callbacks) {
    const dispatchResult = await dispatchSingleCallback({
      db,
      callback,
      runId,
      status,
      result,
      error,
      featureSwitchContext,
    });
    results.push(dispatchResult);
  }
  return results;
}

async function dispatchSingleCallback(
  input: DispatchSingleCallbackInput,
): Promise<DispatchResult> {
  const { db, callback, runId, status, result, error } = input;
  const secret = await decryptPersistentSecretValue(
    callback.encryptedSecret,
    input.featureSwitchContext,
  );
  const body = JSON.stringify({
    callbackId: callback.id,
    runId,
    status,
    result,
    error,
    payload: callback.payload,
  });
  const timestamp = Math.floor(now() / 1000);
  const signature = computeHmacSignature(body, secret, timestamp);

  await db
    .update(agentRunCallbacks)
    .set({
      attempts: 1,
      lastAttemptAt: nowDate(),
    })
    .where(eq(agentRunCallbacks.id, callback.id));

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-VM0-Signature": signature,
    "X-VM0-Timestamp": timestamp.toString(),
  };
  const bypass = optionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET");
  if (bypass) {
    headers["x-vercel-protection-bypass"] = bypass;
  }

  const responseResult = await settle(
    fetch(resolveCallbackUrl(callback.url), {
      method: "POST",
      headers,
      body,
    }),
  );

  if (!responseResult.ok) {
    const errorMessage =
      responseResult.error instanceof Error
        ? responseResult.error.message
        : "Unknown error";
    await markCallbackFailed(db, callback.id, errorMessage);
    L.error("Callback dispatch threw", {
      callbackId: callback.id,
      runId,
      error: responseResult.error,
    });
    return { callbackId: callback.id, success: false, error: errorMessage };
  }

  const response = responseResult.value;
  if (response.ok) {
    await db
      .update(agentRunCallbacks)
      .set({
        status: "delivered",
        deliveredAt: nowDate(),
      })
      .where(eq(agentRunCallbacks.id, callback.id));
    return { callbackId: callback.id, success: true };
  }

  const errorMessage = `HTTP ${response.status}: ${response.statusText}`;
  await markCallbackFailed(db, callback.id, errorMessage);
  L.warn("Callback dispatch failed", {
    callbackId: callback.id,
    runId,
    error: errorMessage,
  });
  return { callbackId: callback.id, success: false, error: errorMessage };
}

async function markCallbackFailed(
  db: Db,
  callbackId: string,
  error: string,
): Promise<void> {
  await db
    .update(agentRunCallbacks)
    .set({
      status: "failed",
      lastError: error,
    })
    .where(eq(agentRunCallbacks.id, callbackId));
}
