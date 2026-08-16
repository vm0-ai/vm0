import {
  agentComposes,
  agentComposeVersions,
} from "@okouai/db/schema/agent-compose";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { checkpoints } from "@okouai/db/schema/checkpoint";
import { count, eq } from "drizzle-orm";

import { db } from "../lib/db";
import { createDeferredPromise } from "../signals/utils";

// These fixtures construct and inspect historical cross-Agent provenance
// states that no product route can create. Lifecycle behavior continues to be
// exercised through the real Clerk, Agent, Run, and checkpoint routes.

export interface AgentComposeVersionProvenanceFixture {
  readonly id: string;
  readonly composeId: string | null;
  readonly createdBy: string | null;
  readonly content: unknown;
}

export async function readAgentHeadVersionIdFixture(
  agentId: string,
): Promise<string> {
  const [agent] = await db()
    .select({ headVersionId: agentComposes.headVersionId })
    .from(agentComposes)
    .where(eq(agentComposes.id, agentId))
    .limit(1);
  if (!agent?.headVersionId) {
    throw new Error("Expected an Agent head version");
  }
  return agent.headVersionId;
}

export async function readAgentComposeVersionProvenanceFixture(
  versionId: string,
): Promise<AgentComposeVersionProvenanceFixture> {
  const [version] = await db()
    .select({
      id: agentComposeVersions.id,
      composeId: agentComposeVersions.composeId,
      createdBy: agentComposeVersions.createdBy,
      content: agentComposeVersions.content,
    })
    .from(agentComposeVersions)
    .where(eq(agentComposeVersions.id, versionId))
    .limit(1);
  if (!version) {
    throw new Error("Expected an Agent Compose version");
  }
  return version;
}

export async function setAgentComposeVersionCreatorFixture(args: {
  readonly versionId: string;
  readonly createdBy: string;
}): Promise<void> {
  const rows = await db()
    .update(agentComposeVersions)
    .set({ createdBy: args.createdBy })
    .where(eq(agentComposeVersions.id, args.versionId))
    .returning({ id: agentComposeVersions.id });
  if (rows.length !== 1) {
    throw new Error("Expected one Agent Compose version creator to change");
  }
}

export async function readAgentComposeVersionReferenceCountsFixture(
  versionId: string,
): Promise<{ readonly agentHeads: number; readonly runs: number }> {
  const [agentHeads] = await db()
    .select({ value: count() })
    .from(agentComposes)
    .where(eq(agentComposes.headVersionId, versionId));
  const [runs] = await db()
    .select({ value: count() })
    .from(agentRuns)
    .where(eq(agentRuns.agentComposeVersionId, versionId));
  return {
    agentHeads: agentHeads?.value ?? 0,
    runs: runs?.value ?? 0,
  };
}

export async function readCheckpointAgentComposeVersionIdFixture(
  runId: string,
): Promise<string> {
  const [checkpoint] = await db()
    .select({ snapshot: checkpoints.agentComposeSnapshot })
    .from(checkpoints)
    .where(eq(checkpoints.runId, runId))
    .limit(1);
  const snapshot = checkpoint?.snapshot;
  const versionId =
    typeof snapshot === "object" && snapshot !== null
      ? Reflect.get(snapshot, "agentComposeVersionId")
      : undefined;
  if (typeof versionId !== "string") {
    throw new Error("Expected a checkpoint Agent Compose version");
  }
  return versionId;
}

export async function holdAgentComposeVersionRowFixture(args: {
  readonly versionId: string;
  readonly signal: AbortSignal;
}): Promise<{ readonly release: () => void; readonly done: Promise<void> }> {
  const acquired = createDeferredPromise<void>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const rows = await tx
      .select({ id: agentComposeVersions.id })
      .from(agentComposeVersions)
      .where(eq(agentComposeVersions.id, args.versionId))
      .for("update");
    if (rows.length !== 1) {
      throw new Error("Expected one Agent Compose version row to lock");
    }
    acquired.resolve(undefined);
    await released.promise;
  });
  await acquired.promise;
  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
  };
}
