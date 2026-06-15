import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { capturePgError, db, uniqueId } from "../test-db";

async function seedComposeVersion(
  userId: string,
  orgId: string,
): Promise<string> {
  const [compose] = await db
    .insert(agentComposes)
    .values({ userId, orgId, name: uniqueId("compose") })
    .returning({ id: agentComposes.id });

  const versionId = uniqueId("version");
  await db.insert(agentComposeVersions).values({
    id: versionId,
    composeId: compose!.id,
    content: { name: "test-agent" },
    createdBy: userId,
  });

  return versionId;
}

async function seedSession(userId: string, orgId: string): Promise<string> {
  const versionId = await seedComposeVersion(userId, orgId);
  const [compose] = await db
    .select({ composeId: agentComposeVersions.composeId })
    .from(agentComposeVersions)
    .where(eq(agentComposeVersions.id, versionId))
    .limit(1);
  const [session] = await db
    .insert(agentSessions)
    .values({ userId, orgId, agentComposeId: compose!.composeId })
    .returning({ id: agentSessions.id });
  return session!.id;
}

describe("migration 0292 agent_runs.session_id NOT NULL + FK", () => {
  it("rejects INSERT with NULL session_id (NOT NULL constraint)", async () => {
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const versionId = await seedComposeVersion(userId, orgId);

    const result = await capturePgError(
      db.execute(sql`
        INSERT INTO "agent_runs"
          ("user_id", "org_id", "agent_compose_version_id", "status", "prompt", "session_id")
        VALUES
          (${userId}, ${orgId}, ${versionId}, 'completed', 'test', NULL)
      `),
    );

    expect(result.code).toBe("23502");
  });

  it("rejects INSERT with non-existent session_id (FK constraint)", async () => {
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const versionId = await seedComposeVersion(userId, orgId);
    const bogusSessionId = "00000000-0000-0000-0000-000000000000";

    const result = await capturePgError(
      db.insert(agentRuns).values({
        userId,
        orgId,
        agentComposeVersionId: versionId,
        status: "completed",
        prompt: "test",
        sessionId: bogusSessionId,
      }),
    );

    expect(result.code).toBe("23503");
  });

  it("accepts INSERT with a valid session_id", async () => {
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const versionId = await seedComposeVersion(userId, orgId);
    const sessionId = await seedSession(userId, orgId);
    const [run] = await db
      .insert(agentRuns)
      .values({
        userId,
        orgId,
        agentComposeVersionId: versionId,
        status: "completed",
        prompt: "test",
        sessionId,
      })
      .returning({ id: agentRuns.id, sessionId: agentRuns.sessionId });

    expect(run!.sessionId).toBe(sessionId);
  });

  it("cascades DELETE on agent_sessions to agent_runs", async () => {
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const versionId = await seedComposeVersion(userId, orgId);
    const sessionId = await seedSession(userId, orgId);
    const [run] = await db
      .insert(agentRuns)
      .values({
        userId,
        orgId,
        agentComposeVersionId: versionId,
        status: "completed",
        prompt: "test",
        sessionId,
      })
      .returning({ id: agentRuns.id });
    const runId = run!.id;
    await db.delete(agentSessions).where(eq(agentSessions.id, sessionId));
    const rows = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));
    expect(rows).toHaveLength(0);
  });
});
