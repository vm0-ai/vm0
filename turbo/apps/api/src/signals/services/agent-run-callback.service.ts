import { command } from "ccstate";
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
import { handleAgentInternalCallback$ } from "./internal-agent-run-callback.service";
import {
  legacyInternalRunCallbackKind,
  type InternalRunCallbackEnvelope,
  type InternalRunCallbackKind,
} from "./internal-run-callback";

const L = logger("AgentRunCallback");

interface CallbackRecord {
  readonly id: string;
  readonly url: string | null;
  readonly internalKind: string | null;
  readonly encryptedSecret: string;
  readonly payload: unknown;
}

interface DispatchResult {
  readonly callbackId: string;
  readonly success: boolean;
  readonly error?: string;
}

type TerminalCallbackStatus = "completed" | "failed";

interface DispatchRunCallbacksInput {
  readonly db: Db;
  readonly runId: string;
  readonly status: TerminalCallbackStatus;
  readonly result?: Record<string, unknown>;
  readonly error?: string;
}

interface DispatchSingleCallbackInput {
  readonly db: Db;
  readonly callback: CallbackRecord;
  readonly runId: string;
  readonly status: TerminalCallbackStatus;
  readonly result?: Record<string, unknown>;
  readonly error?: string;
  readonly featureSwitchContext: FeatureSwitchContext;
}

interface DispatchInternalRunCallbackInput {
  readonly db: Db;
  readonly callback: CallbackRecord;
  readonly runId: string;
  readonly status: TerminalCallbackStatus;
  readonly result?: Record<string, unknown>;
  readonly error?: string;
  readonly kind: InternalRunCallbackKind;
}

interface DispatchInternalCallbackInput {
  readonly kind: InternalRunCallbackKind;
  readonly envelope: InternalRunCallbackEnvelope;
}

function resolveCallbackUrl(url: string): string {
  return env("ENV") === "development" && url.startsWith("https://tunnel-")
    ? url.replace(/^https:\/\/tunnel-[^/]+/, "http://localhost:3000")
    : url;
}

function internalCallbackKindForRecord(
  callback: CallbackRecord,
): InternalRunCallbackKind | null {
  if (callback.internalKind === "agent") {
    return callback.internalKind;
  }
  return legacyInternalRunCallbackKind(callback.url);
}

const dispatchInternalCallback$ = command(
  async (
    { set },
    input: DispatchInternalCallbackInput,
    signal: AbortSignal,
  ): Promise<void> => {
    switch (input.kind) {
      case "agent": {
        await set(handleAgentInternalCallback$, input.envelope, signal);
        break;
      }
    }
  },
);

const dispatchSingleInternalCallback$ = command(
  async (
    { set },
    input: DispatchInternalRunCallbackInput,
    signal: AbortSignal,
  ): Promise<DispatchResult> => {
    await markCallbackAttemptStarted(input.db, input.callback.id);
    signal.throwIfAborted();
    const callbackId = input.callback.id;
    const responseResult = await settle(
      set(
        dispatchInternalCallback$,
        {
          kind: input.kind,
          envelope: callbackEnvelope(input),
        },
        signal,
      ),
    );
    signal.throwIfAborted();

    if (!responseResult.ok) {
      const errorMessage =
        responseResult.error instanceof Error
          ? responseResult.error.message
          : "Unknown error";
      await markCallbackFailed(input.db, callbackId, errorMessage);
      signal.throwIfAborted();
      L.error("Internal callback dispatch threw", {
        callbackId,
        runId: input.runId,
        error: responseResult.error,
      });
      return { callbackId, success: false, error: errorMessage };
    }

    await markCallbackDelivered(input.db, callbackId);
    signal.throwIfAborted();
    return { callbackId, success: true };
  },
);

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
      internalKind: agentRunCallbacks.internalKind,
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

export const dispatchRunCallbacks$ = command(
  async (
    { set },
    input: DispatchRunCallbacksInput,
    signal: AbortSignal,
  ): Promise<DispatchResult[]> => {
    const { db, runId, status, result, error } = input;
    const [run] = await db
      .select({
        orgId: agentRuns.orgId,
        userId: agentRuns.userId,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);
    signal.throwIfAborted();
    if (!run) {
      return [];
    }
    const featureSwitchContext = await loadUserFeatureSwitchContext(
      db,
      run.orgId,
      run.userId,
    );
    signal.throwIfAborted();
    const callbacks = await db
      .select({
        id: agentRunCallbacks.id,
        url: agentRunCallbacks.url,
        internalKind: agentRunCallbacks.internalKind,
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
    signal.throwIfAborted();

    const results: DispatchResult[] = [];
    for (const callback of callbacks) {
      const internalKind = internalCallbackKindForRecord(callback);
      const dispatchResult = internalKind
        ? await set(
            dispatchSingleInternalCallback$,
            {
              db,
              callback,
              runId,
              status,
              result,
              error,
              kind: internalKind,
            },
            signal,
          )
        : await dispatchHttpCallback({
            db,
            callback,
            runId,
            status,
            result,
            error,
            featureSwitchContext,
          });
      signal.throwIfAborted();
      results.push(dispatchResult);
    }
    return results;
  },
);

async function dispatchSingleCallback(
  input: DispatchSingleCallbackInput,
): Promise<DispatchResult> {
  const internalKind = internalCallbackKindForRecord(input.callback);
  if (internalKind) {
    return await dispatchInternalCallback(input);
  }
  return await dispatchHttpCallback(input);
}

async function dispatchInternalCallback(
  input: DispatchSingleCallbackInput,
): Promise<DispatchResult> {
  await markCallbackAttemptStarted(input.db, input.callback.id);
  const callbackId = input.callback.id;
  await markCallbackDelivered(input.db, callbackId);
  return { callbackId, success: true };
}

function callbackEnvelope(
  input: DispatchInternalRunCallbackInput | DispatchSingleCallbackInput,
): InternalRunCallbackEnvelope {
  return {
    callbackId: input.callback.id,
    runId: input.runId,
    status: input.status,
    result: input.result,
    error: input.error,
    payload: input.callback.payload,
  };
}

async function dispatchHttpCallback(
  input: DispatchSingleCallbackInput,
): Promise<DispatchResult> {
  const { db, callback, runId, status, result, error } = input;
  if (!callback.url) {
    const errorMessage = "Callback URL is missing";
    await markCallbackFailed(db, callback.id, errorMessage);
    return { callbackId: callback.id, success: false, error: errorMessage };
  }
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

  await markCallbackAttemptStarted(db, callback.id);

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
    await markCallbackDelivered(db, callback.id);
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

async function markCallbackAttemptStarted(
  db: Db,
  callbackId: string,
): Promise<void> {
  await db
    .update(agentRunCallbacks)
    .set({
      attempts: 1,
      lastAttemptAt: nowDate(),
    })
    .where(eq(agentRunCallbacks.id, callbackId));
}

async function markCallbackDelivered(
  db: Db,
  callbackId: string,
): Promise<void> {
  await db
    .update(agentRunCallbacks)
    .set({
      status: "delivered",
      deliveredAt: nowDate(),
    })
    .where(eq(agentRunCallbacks.id, callbackId));
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
