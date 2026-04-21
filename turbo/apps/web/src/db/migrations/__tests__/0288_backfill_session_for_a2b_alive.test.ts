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
    UPDATE "agent_runs" r
    SET "session_id" = sibling."session_id"
    FROM (
      SELECT DISTINCT ON (t.id)
        t.id AS run_id,
        o."session_id"
      FROM "agent_runs" t
      JOIN "conversations" tc ON tc."run_id" = t.id
      JOIN "agent_compose_versions" tv ON tv."id" = t."agent_compose_version_id"
      JOIN "agent_runs" o
        ON o."user_id" = t."user_id"
        AND o."session_id" IS NOT NULL
      JOIN "conversations" oc
        ON oc."run_id" = o."id"
        AND oc."cli_agent_session_id" = tc."cli_agent_session_id"
      JOIN "agent_compose_versions" ov
        ON ov."id" = o."agent_compose_version_id"
        AND ov."compose_id" = tv."compose_id"
      WHERE t."session_id" IS NULL
      ORDER BY t.id, o."created_at" ASC
    ) sibling
    WHERE r."id" = sibling.run_id;
  `);
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: executes the verbatim migration body
  await globalThis.services.db.execute(sql`
    WITH orphan_groups AS MATERIALIZED (
      SELECT
        r."user_id",
        v."compose_id",
        c."cli_agent_session_id",
        gen_random_uuid() AS new_session_id
      FROM "agent_runs" r
      JOIN "conversations" c ON c."run_id" = r."id"
      JOIN "agent_compose_versions" v ON v."id" = r."agent_compose_version_id"
      WHERE r."session_id" IS NULL
      GROUP BY r."user_id", v."compose_id", c."cli_agent_session_id"
    )
    UPDATE "agent_runs" r
    SET "session_id" = g.new_session_id
    FROM orphan_groups g, "conversations" c, "agent_compose_versions" v
    WHERE c."run_id" = r."id"
      AND v."id" = r."agent_compose_version_id"
      AND r."session_id" IS NULL
      AND r."user_id" = g."user_id"
      AND v."compose_id" = g."compose_id"
      AND c."cli_agent_session_id" = g."cli_agent_session_id";
  `);
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: executes the verbatim migration body
  await globalThis.services.db.execute(sql`
    INSERT INTO "agent_sessions" ("id", "user_id", "agent_compose_id", "org_id", "created_at", "updated_at")
    SELECT DISTINCT ON (r."session_id")
      r."session_id",
      r."user_id",
      v."compose_id",
      r."org_id",
      r."created_at",
      r."created_at"
    FROM "agent_runs" r
    JOIN "agent_compose_versions" v ON v."id" = r."agent_compose_version_id"
    WHERE r."session_id" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "agent_sessions" s WHERE s."id" = r."session_id"
      )
    ORDER BY r."session_id", r."created_at" ASC;
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

async function seedRunWithConversation(params: {
  userId: string;
  orgId: string;
  versionId: string;
  sessionId: string | null;
  cliAgentSessionId: string;
  status?: string;
}): Promise<string> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: raw row seeding
  const [run] = await globalThis.services.db
    .insert(agentRuns)
    .values({
      userId: params.userId,
      orgId: params.orgId,
      agentComposeVersionId: params.versionId,
      status: params.status ?? "completed",
      prompt: "test prompt",
      sessionId: params.sessionId,
    })
    .returning({ id: agentRuns.id });
  const runId = run!.id;

  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: raw row seeding
  await globalThis.services.db.insert(conversations).values({
    runId,
    cliAgentType: "claude-code",
    cliAgentSessionId: params.cliAgentSessionId,
  });

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

describe("migration 0287 backfill_session_for_a2b_alive", () => {
  beforeEach(() => {
    context.setupMocks();
    // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: needs services initialised to run raw SQL
    initServices();
  });

  it("sibling recovery: orphan inherits sibling session_id, no new agent_sessions row", async () => {
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const { composeId, versionId } = await seedComposeWithVersion(
      userId,
      orgId,
    );
    const cliSessionId = uniqueId("cli-sess");

    // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: raw row seeding
    const [siblingSession] = await globalThis.services.db
      .insert(agentSessions)
      .values({ userId, orgId, agentComposeId: composeId })
      .returning({ id: agentSessions.id });
    const siblingSessionId = siblingSession!.id;

    await seedRunWithConversation({
      userId,
      orgId,
      versionId,
      sessionId: siblingSessionId,
      cliAgentSessionId: cliSessionId,
    });
    const orphanRunId = await seedRunWithConversation({
      userId,
      orgId,
      versionId,
      sessionId: null,
      cliAgentSessionId: cliSessionId,
    });

    // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: read-back assertion
    const sessionsBefore = await globalThis.services.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.userId, userId));

    await runMigration();

    const orphanRun = await readRun(orphanRunId);
    expect(orphanRun!.sessionId).toBe(siblingSessionId);

    // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: read-back assertion
    const sessionsAfter = await globalThis.services.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.userId, userId));
    expect(sessionsAfter.length).toBe(sessionsBefore.length);
  });

  it("orphan singleton: new session minted, matching agent_sessions row inserted", async () => {
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const { composeId, versionId } = await seedComposeWithVersion(
      userId,
      orgId,
    );
    const runId = await seedRunWithConversation({
      userId,
      orgId,
      versionId,
      sessionId: null,
      cliAgentSessionId: uniqueId("cli-sess"),
    });

    await runMigration();

    const run = await readRun(runId);
    expect(run!.sessionId).not.toBeNull();

    const session = await readSession(run!.sessionId!);
    expect(session).toBeDefined();
    expect(session!.userId).toBe(userId);
    expect(session!.orgId).toBe(orgId);
    expect(session!.agentComposeId).toBe(composeId);
    expect(session!.conversationId).toBeNull();
  });

  it("orphan group: runs sharing (user, compose, cli_session_id) share one new session, one agent_sessions row", async () => {
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const { versionId } = await seedComposeWithVersion(userId, orgId);
    const cliSessionId = uniqueId("cli-sess");

    const run1 = await seedRunWithConversation({
      userId,
      orgId,
      versionId,
      sessionId: null,
      cliAgentSessionId: cliSessionId,
    });
    const run2 = await seedRunWithConversation({
      userId,
      orgId,
      versionId,
      sessionId: null,
      cliAgentSessionId: cliSessionId,
    });
    const run3 = await seedRunWithConversation({
      userId,
      orgId,
      versionId,
      sessionId: null,
      cliAgentSessionId: cliSessionId,
    });

    await runMigration();

    const r1 = await readRun(run1);
    const r2 = await readRun(run2);
    const r3 = await readRun(run3);
    expect(r1!.sessionId).not.toBeNull();
    expect(r2!.sessionId).toBe(r1!.sessionId);
    expect(r3!.sessionId).toBe(r1!.sessionId);

    // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: read-back assertion
    const sessions = await globalThis.services.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, r1!.sessionId!));
    expect(sessions).toHaveLength(1);
  });

  it("leaves runs with an existing session_id untouched", async () => {
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
    const runId = await seedRunWithConversation({
      userId,
      orgId,
      versionId,
      sessionId: session!.id,
      cliAgentSessionId: uniqueId("cli-sess"),
    });

    await runMigration();

    const run = await readRun(runId);
    expect(run!.sessionId).toBe(session!.id);
  });

  it("is idempotent — re-running does not change assigned session_ids", async () => {
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const { versionId } = await seedComposeWithVersion(userId, orgId);
    const runId = await seedRunWithConversation({
      userId,
      orgId,
      versionId,
      sessionId: null,
      cliAgentSessionId: uniqueId("cli-sess"),
    });

    await runMigration();
    const firstSessionId = (await readRun(runId))!.sessionId!;

    await runMigration();
    const secondSessionId = (await readRun(runId))!.sessionId!;

    expect(secondSessionId).toBe(firstSessionId);
  });

  it("mixed group: orphans in a sibling-bearing triple inherit, no new session minted", async () => {
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const { composeId, versionId } = await seedComposeWithVersion(
      userId,
      orgId,
    );
    const cliSessionId = uniqueId("cli-sess");
    // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: raw row seeding
    const [siblingSession] = await globalThis.services.db
      .insert(agentSessions)
      .values({ userId, orgId, agentComposeId: composeId })
      .returning({ id: agentSessions.id });
    const siblingSessionId = siblingSession!.id;

    await seedRunWithConversation({
      userId,
      orgId,
      versionId,
      sessionId: siblingSessionId,
      cliAgentSessionId: cliSessionId,
    });
    await seedRunWithConversation({
      userId,
      orgId,
      versionId,
      sessionId: siblingSessionId,
      cliAgentSessionId: cliSessionId,
    });
    const orphan1 = await seedRunWithConversation({
      userId,
      orgId,
      versionId,
      sessionId: null,
      cliAgentSessionId: cliSessionId,
    });
    const orphan2 = await seedRunWithConversation({
      userId,
      orgId,
      versionId,
      sessionId: null,
      cliAgentSessionId: cliSessionId,
    });

    // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: read-back assertion
    const sessionsBefore = await globalThis.services.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.userId, userId));

    await runMigration();

    expect((await readRun(orphan1))!.sessionId).toBe(siblingSessionId);
    expect((await readRun(orphan2))!.sessionId).toBe(siblingSessionId);

    // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: read-back assertion
    const sessionsAfter = await globalThis.services.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.userId, userId));
    expect(sessionsAfter.length).toBe(sessionsBefore.length);
  });

  it("cross-user isolation: orphan does not inherit another user's session", async () => {
    const userA = uniqueId("user-a");
    const userB = uniqueId("user-b");
    const orgA = uniqueId("org-a");
    const orgB = uniqueId("org-b");
    // Same cli_agent_session_id, but different users and different composes —
    // even if cli_agent_session_id collides, the user_id + compose_id
    // discriminators must prevent cross-user inheritance.
    const cliSessionId = uniqueId("cli-sess");
    const { composeId: composeA, versionId: versionA } =
      await seedComposeWithVersion(userA, orgA);
    const { versionId: versionB } = await seedComposeWithVersion(userB, orgB);

    // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: raw row seeding
    const [userASession] = await globalThis.services.db
      .insert(agentSessions)
      .values({ userId: userA, orgId: orgA, agentComposeId: composeA })
      .returning({ id: agentSessions.id });

    await seedRunWithConversation({
      userId: userA,
      orgId: orgA,
      versionId: versionA,
      sessionId: userASession!.id,
      cliAgentSessionId: cliSessionId,
    });
    const orphanBRunId = await seedRunWithConversation({
      userId: userB,
      orgId: orgB,
      versionId: versionB,
      sessionId: null,
      cliAgentSessionId: cliSessionId,
    });

    await runMigration();

    const orphanB = await readRun(orphanBRunId);
    expect(orphanB!.sessionId).not.toBeNull();
    expect(orphanB!.sessionId).not.toBe(userASession!.id);
    const mintedSession = await readSession(orphanB!.sessionId!);
    expect(mintedSession!.userId).toBe(userB);
  });
});
