import { randomUUID } from "node:crypto";

import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { runBuiltInAdmissions } from "@vm0/db/schema/run-built-in-admission";
import { createStore } from "ccstate";
import { eq, like } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { writeDb$ } from "../../external/db";
import { now, nowDate } from "../../external/time";
import {
  completeRunBuiltInAdmission$,
  RUN_BUILT_IN_MAX_STARTED,
  startRunBuiltInAdmission$,
} from "../zero-run-built-in-admission.service";

const store = createStore();
const ORG_ID_PREFIX = "org_run_builtin_admission_";

async function seedRun(): Promise<string> {
  const db = store.set(writeDb$);
  const orgId = `${ORG_ID_PREFIX}${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  const composeId = randomUUID();
  const versionId = randomUUID();
  const sessionId = randomUUID();
  const runId = randomUUID();

  await db.insert(agentComposes).values({
    id: composeId,
    orgId,
    userId,
    name: `agent-${composeId.slice(0, 8)}`,
  });
  await db.insert(agentComposeVersions).values({
    id: versionId,
    composeId,
    content: { agents: {} },
    createdBy: userId,
  });
  await db
    .update(agentComposes)
    .set({ headVersionId: versionId })
    .where(eq(agentComposes.id, composeId));
  await db.insert(agentSessions).values({
    id: sessionId,
    orgId,
    userId,
    agentComposeId: composeId,
    artifacts: [],
  });
  await db.insert(agentRuns).values({
    id: runId,
    orgId,
    userId,
    sessionId,
    agentComposeVersionId: versionId,
    status: "running",
    prompt: "run built-in admission test",
  });

  return runId;
}

afterEach(async () => {
  const db = store.set(writeDb$);
  const runs = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(like(agentRuns.orgId, `${ORG_ID_PREFIX}%`));
  const runIds = runs.map((run) => {
    return run.id;
  });

  for (const runId of runIds) {
    await db
      .delete(runBuiltInAdmissions)
      .where(eq(runBuiltInAdmissions.runId, runId));
  }
  await db.delete(agentRuns).where(like(agentRuns.orgId, `${ORG_ID_PREFIX}%`));
  await db
    .delete(agentSessions)
    .where(like(agentSessions.orgId, `${ORG_ID_PREFIX}%`));
  await db
    .delete(agentComposes)
    .where(like(agentComposes.orgId, `${ORG_ID_PREFIX}%`));
});

describe("run built-in admission", () => {
  it("limits active built-in generations per run", async () => {
    const runId = await seedRun();
    const signal = new AbortController().signal;

    const first = await store.set(
      startRunBuiltInAdmission$,
      { runId, kind: "image" },
      signal,
    );
    const second = await store.set(
      startRunBuiltInAdmission$,
      { runId, kind: "voice" },
      signal,
    );
    const third = await store.set(
      startRunBuiltInAdmission$,
      { runId, kind: "image" },
      signal,
    );
    const fourth = await store.set(
      startRunBuiltInAdmission$,
      { runId, kind: "presentation" },
      signal,
    );

    expect(first).toStrictEqual({ id: expect.any(String) });
    expect(second).toStrictEqual({ id: expect.any(String) });
    expect(third).toStrictEqual({ id: expect.any(String) });
    expect(fourth).toMatchObject({
      status: 429,
      body: {
        error: {
          code: "BUILT_IN_RUN_CONCURRENCY_LIMIT",
        },
      },
    });

    if (first && !("status" in first)) {
      await store.set(completeRunBuiltInAdmission$, {
        admission: first,
        status: "completed",
      });
    }

    const afterCompletion = await store.set(
      startRunBuiltInAdmission$,
      { runId, kind: "presentation" },
      signal,
    );
    expect(afterCompletion).toStrictEqual({ id: expect.any(String) });
  });

  it("limits total built-in generations started by a run", async () => {
    const runId = await seedRun();
    const db = store.set(writeDb$);
    const completedAt = nowDate();
    const expiresAt = new Date(now() + 60_000);
    await db.insert(runBuiltInAdmissions).values(
      Array.from({ length: RUN_BUILT_IN_MAX_STARTED }, () => {
        return {
          runId,
          kind: "image",
          status: "completed",
          completedAt,
          expiresAt,
        };
      }),
    );

    const result = await store.set(
      startRunBuiltInAdmission$,
      { runId, kind: "image" },
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      status: 429,
      body: {
        error: {
          code: "BUILT_IN_RUN_USAGE_LIMIT",
        },
      },
    });
  });

  it("does not limit requests outside a run", async () => {
    const result = await store.set(
      startRunBuiltInAdmission$,
      { runId: undefined, kind: "image" },
      new AbortController().signal,
    );

    expect(result).toBeNull();
  });
});
