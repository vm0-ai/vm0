import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { formatRunErrorForExternalSurface } from "@vm0/api-contracts/contracts/errors";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { feishuOrgConnections } from "@vm0/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@vm0/db/schema/feishu-org-installation";
import { feishuOrgThreadSessions } from "@vm0/db/schema/feishu-org-thread-session";

import { replyToFeishuMessage } from "../external/feishu-client";
import { nowDate } from "../external/time";
import { writeDb$, type Db } from "../external/db";
import { feishuConfig } from "./feishu-config";
import {
  feishuOrgCallbackPayloadSchema,
  type FeishuOrgCallbackPayload,
} from "./feishu-org-callback-payload";
import type {
  InternalRunCallbackDispatchResult,
  InternalRunCallbackEnvelope,
} from "./internal-run-callback";
import { getRunOutputText } from "./run-output.service";
import { saveRunSummary } from "./run-summary.service";

interface RunContext {
  readonly orgId: string;
  readonly prompt: string;
  readonly sessionId: string | null;
  readonly lastEventSequence: number | null;
}

async function loadRun(db: Db, runId: string): Promise<RunContext | undefined> {
  const [run] = await db
    .select({
      orgId: agentRuns.orgId,
      prompt: agentRuns.prompt,
      sessionId: agentRuns.sessionId,
      lastEventSequence: agentRuns.lastEventSequence,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  return run;
}

async function saveSession(args: {
  readonly db: Db;
  readonly payload: FeishuOrgCallbackPayload;
  readonly sessionId: string | null;
}): Promise<void> {
  if (!args.sessionId) {
    return;
  }
  await args.db
    .insert(feishuOrgThreadSessions)
    .values({
      connectionId: args.payload.connectionId,
      feishuChatId: args.payload.chatId,
      agentSessionId: args.sessionId,
    })
    .onConflictDoUpdate({
      target: [
        feishuOrgThreadSessions.connectionId,
        feishuOrgThreadSessions.feishuChatId,
      ],
      set: { agentSessionId: args.sessionId, updatedAt: nowDate() },
    });
}

async function handleFeishuCallback(args: {
  readonly db: Db;
  readonly callback: InternalRunCallbackEnvelope;
  readonly signal: AbortSignal;
}): Promise<InternalRunCallbackDispatchResult> {
  if (args.callback.status === "progress") {
    return { success: true, skipped: true };
  }
  const parsed = feishuOrgCallbackPayloadSchema.safeParse(
    args.callback.payload,
  );
  if (!parsed.success) {
    return { success: false, error: "Invalid Feishu callback payload" };
  }
  const config = feishuConfig();
  if (!config) {
    return { success: false, error: "Feishu integration is not configured" };
  }
  const run = await loadRun(args.db, args.callback.runId);
  args.signal.throwIfAborted();
  if (!run) {
    return { success: false, error: "Agent run not found" };
  }
  const [installation] = await args.db
    .select({ orgId: feishuOrgInstallations.orgId })
    .from(feishuOrgInstallations)
    .where(
      and(
        eq(feishuOrgInstallations.feishuTenantKey, parsed.data.tenantKey),
        eq(feishuOrgInstallations.orgId, run.orgId),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();
  if (!installation) {
    return { success: false, error: "Feishu installation not found" };
  }
  const [connection] = await args.db
    .select({ id: feishuOrgConnections.id })
    .from(feishuOrgConnections)
    .where(
      and(
        eq(feishuOrgConnections.id, parsed.data.connectionId),
        eq(feishuOrgConnections.feishuTenantKey, parsed.data.tenantKey),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();
  if (!connection) {
    return { success: true, skipped: true };
  }

  const output = await getRunOutputText(args.callback.runId, {
    knownLastEventSequence: run.lastEventSequence,
    signal: args.signal,
  });
  const responseText =
    args.callback.status === "failed"
      ? formatRunErrorForExternalSurface({
          code: "INTERNAL_SERVER_ERROR",
          message: args.callback.error ?? "Agent execution failed.",
        })
      : (output ?? "Task completed successfully.");
  await saveSession({
    db: args.db,
    payload: parsed.data,
    sessionId: run.sessionId,
  });
  args.signal.throwIfAborted();
  await replyToFeishuMessage({
    db: args.db,
    config,
    tenantKey: parsed.data.tenantKey,
    messageId: parsed.data.messageId,
    text: responseText,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  await saveRunSummary(
    args.db,
    {
      runId: args.callback.runId,
      triggerSource: "feishu",
      prompt: run.prompt,
      resultText: output ?? "",
    },
    args.signal,
  );
  return { success: true };
}

export const handleFeishuOrgInternalCallback$ = command(
  async (
    { set },
    callback: InternalRunCallbackEnvelope,
    signal: AbortSignal,
  ) => {
    return await handleFeishuCallback({
      db: set(writeDb$),
      callback,
      signal,
    });
  },
);

export async function handleFeishuOrgInternalCallbackWithoutCcstate(
  db: Db,
  callback: InternalRunCallbackEnvelope,
  signal = new AbortController().signal,
): Promise<InternalRunCallbackDispatchResult> {
  return await handleFeishuCallback({ db, callback, signal });
}
