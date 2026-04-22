import { describe, it, expect, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { testContext, uniqueId } from "../../../__tests__/test-helpers";
import { initServices } from "../../../lib/init-services";
import { agentRuns } from "../../schema/agent-run";
import {
  agentComposes,
  agentComposeVersions,
} from "../../schema/agent-compose";
import { agentSessions } from "../../schema/agent-session";
import { conversations } from "../../schema/conversation";

const context = testContext();

async function runMigration(): Promise<void> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: executes the verbatim migration body
  await globalThis.services.db.execute(sql`
    DELETE FROM "agent_runs"
    WHERE "session_id" IS NULL
      AND "agent_compose_version_id" IS NULL;
  `);
}

async function seedComposeWithVersion(
  userId: string,
  orgId: string,
): Promise<{ composeId: string; versionId: string }> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: raw row seeding
  const [compose] = await globalThis.services.db
    .insert(agentComposes)
    .values({
      userId,
      orgId,
      name: uniqueId("compose"),
    })
    .returning({ id: agentComposes.id });
  const composeId = compose!.id;

  const versionId = uniqueId("version");
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: raw row seeding
  await globalThis.services.db.insert(agentComposeVersions).values({
    id: versionId,
    composeId,
    content: { name: "test-agent" },
    createdBy: userId,
  });

  return { composeId, versionId };
}

async function seedRun(params: {
  userId: string;
  orgId: string;
  versionId: string | null;
  sessionId: string | null;
  status: string;
  withConversation?: boolean;
}): Promise<string> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: raw row seeding
  const [run] = await globalThis.services.db
    .insert(agentRuns)
    .values({
      userId: params.userId,
      orgId: params.orgId,
      agentComposeVersionId: params.versionId,
      status: params.status,
      prompt: "test prompt",
      sessionId: params.sessionId,
    })
    .returning({ id: agentRuns.id });
  const runId = run!.id;

  if (params.withConversation) {
    // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: raw row seeding
    await globalThis.services.db.insert(conversations).values({
      runId,
      cliAgentType: "claude-code",
      cliAgentSessionId: uniqueId("cli-sess"),
    });
  }

  return runId;
}

async function readRun(runId: string) {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: read-back assertion
  const [row] = await globalThis.services.db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  return row;
}

async function readConversationByRunId(runId: string) {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: read-back assertion
  const [row] = await globalThis.services.db
    .select()
    .from(conversations)
    .where(eq(conversations.runId, runId))
    .limit(1);
  return row;
}

describe("migration 0287 delete_compose_gone_runs", () => {
  beforeEach(() => {
    context.setupMocks();
    // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: needs services initialised to run raw SQL
    initServices();
  });

  it("deletes an A2b run (null session, null compose version, has conversation) and CASCADE-deletes its conversation", async () => {
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const runId = await seedRun({
      userId,
      orgId,
      versionId: null,
      sessionId: null,
      status: "completed",
      withConversation: true,
    });

    const before = await readConversationByRunId(runId);
    expect(before).toBeDefined();

    await runMigration();

    const run = await readRun(runId);
    expect(run).toBeUndefined();

    const conversation = await readConversationByRunId(runId);
    expect(conversation).toBeUndefined();
  });

  it("leaves a run with a live session untouched", async () => {
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const { composeId, versionId } = await seedComposeWithVersion(
      userId,
      orgId,
    );
    // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: raw row seeding
    const [session] = await globalThis.services.db
      .insert(agentSessions)
      .values({ userId, orgId, agentComposeId: composeId })
      .returning({ id: agentSessions.id });
    const runId = await seedRun({
      userId,
      orgId,
      versionId,
      sessionId: session!.id,
      status: "completed",
    });

    await runMigration();

    const run = await readRun(runId);
    expect(run).toBeDefined();
    expect(run!.sessionId).toBe(session!.id);
    expect(run!.agentComposeVersionId).toBe(versionId);
  });

  it("leaves a run with a live compose version but null session untouched", async () => {
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const { versionId } = await seedComposeWithVersion(userId, orgId);
    const runId = await seedRun({
      userId,
      orgId,
      versionId,
      sessionId: null,
      status: "failed",
    });

    await runMigration();

    const run = await readRun(runId);
    expect(run).toBeDefined();
    expect(run!.agentComposeVersionId).toBe(versionId);
    expect(run!.sessionId).toBeNull();
  });

  it("is idempotent — re-running after deletion is a no-op", async () => {
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const runId = await seedRun({
      userId,
      orgId,
      versionId: null,
      sessionId: null,
      status: "completed",
      withConversation: true,
    });

    await runMigration();
    const afterFirst = await readRun(runId);
    expect(afterFirst).toBeUndefined();

    await runMigration();
    const afterSecond = await readRun(runId);
    expect(afterSecond).toBeUndefined();
  });
});
