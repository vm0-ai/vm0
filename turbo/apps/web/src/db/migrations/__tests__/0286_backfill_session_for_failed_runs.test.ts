import { describe, it, expect, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { testContext, uniqueId } from "../../../__tests__/test-helpers";
import { initServices } from "../../../lib/init-services";
import { agentRuns } from "../../schema/agent-run";
import { agentSessions } from "../../schema/agent-session";
import {
  agentComposes,
  agentComposeVersions,
} from "../../schema/agent-compose";
import { conversations } from "../../schema/conversation";

const context = testContext();

async function runMigration(): Promise<void> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: executes the verbatim migration body
  await globalThis.services.db.execute(sql`
    DELETE FROM "agent_runs"
    WHERE "session_id" IS NULL
      AND "agent_compose_version_id" IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM "conversations" c WHERE c."run_id" = "agent_runs"."id"
      );
  `);
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: executes the verbatim migration body
  await globalThis.services.db.execute(sql`
    UPDATE "agent_runs"
    SET "session_id" = gen_random_uuid()
    WHERE "session_id" IS NULL
      AND "agent_compose_version_id" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "conversations" c WHERE c."run_id" = "agent_runs"."id"
      );
  `);
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: executes the verbatim migration body
  await globalThis.services.db.execute(sql`
    INSERT INTO "agent_sessions" ("id", "user_id", "agent_compose_id", "org_id", "created_at", "updated_at")
    SELECT r."session_id", r."user_id", v."compose_id", r."org_id", r."created_at", r."created_at"
    FROM "agent_runs" r
    JOIN "agent_compose_versions" v ON v."id" = r."agent_compose_version_id"
    WHERE r."session_id" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "agent_sessions" s WHERE s."id" = r."session_id");
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

async function seedRunWithNullSession(params: {
  userId: string;
  orgId: string;
  versionId: string | null;
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
      sessionId: null,
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

async function readSession(sessionId: string) {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: read-back assertion
  const [row] = await globalThis.services.db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  return row;
}

describe("migration 0286 backfill_session_for_failed_runs", () => {
  beforeEach(() => {
    context.setupMocks();
    // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: needs services initialised to run raw SQL
    initServices();
  });

  it("backfills a session for a failed run with a live agent", async () => {
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const { composeId, versionId } = await seedComposeWithVersion(
      userId,
      orgId,
    );
    const runId = await seedRunWithNullSession({
      userId,
      orgId,
      versionId,
      status: "failed",
    });

    await runMigration();

    const run = await readRun(runId);
    expect(run).toBeDefined();
    expect(run!.sessionId).not.toBeNull();

    const session = await readSession(run!.sessionId!);
    expect(session).toBeDefined();
    expect(session!.userId).toBe(userId);
    expect(session!.orgId).toBe(orgId);
    expect(session!.agentComposeId).toBe(composeId);
    expect(session!.conversationId).toBeNull();
  });

  it("deletes a failed run whose agent compose version was removed", async () => {
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const runId = await seedRunWithNullSession({
      userId,
      orgId,
      versionId: null,
      status: "failed",
    });

    await runMigration();

    const run = await readRun(runId);
    expect(run).toBeUndefined();
  });

  it("leaves runs with a conversation untouched (A2b bucket)", async () => {
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const { versionId } = await seedComposeWithVersion(userId, orgId);
    const runId = await seedRunWithNullSession({
      userId,
      orgId,
      versionId,
      status: "completed",
      withConversation: true,
    });

    await runMigration();

    const run = await readRun(runId);
    expect(run).toBeDefined();
    expect(run!.sessionId).toBeNull();
  });

  it("leaves runs that already have a session untouched", async () => {
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
    // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: raw row seeding
    const [run] = await globalThis.services.db
      .insert(agentRuns)
      .values({
        userId,
        orgId,
        agentComposeVersionId: versionId,
        status: "failed",
        prompt: "test prompt",
        sessionId: session!.id,
      })
      .returning({ id: agentRuns.id });

    await runMigration();

    const after = await readRun(run!.id);
    expect(after!.sessionId).toBe(session!.id);
  });

  it("is idempotent — re-running leaves the backfilled state intact", async () => {
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const { versionId } = await seedComposeWithVersion(userId, orgId);
    const runId = await seedRunWithNullSession({
      userId,
      orgId,
      versionId,
      status: "timeout",
    });

    await runMigration();
    const firstSessionId = (await readRun(runId))!.sessionId!;

    await runMigration();
    const secondSessionId = (await readRun(runId))!.sessionId!;

    expect(secondSessionId).toBe(firstSessionId);
  });
});
