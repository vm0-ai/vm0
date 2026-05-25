import { describe, it, expect, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { testContext, uniqueId } from "../test-helpers";
import { initServices } from "../../lib/init-services";

const context = testContext();

async function seedComposeVersion(
  userId: string,
  orgId: string,
): Promise<string> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: raw row seeding
  const [compose] = await globalThis.services.db
    .insert(agentComposes)
    .values({ userId, orgId, name: uniqueId("compose") })
    .returning({ id: agentComposes.id });

  const versionId = uniqueId("version");
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: raw row seeding
  await globalThis.services.db.insert(agentComposeVersions).values({
    id: versionId,
    composeId: compose!.id,
    content: { name: "test-agent" },
    createdBy: userId,
  });

  return versionId;
}

async function seedSession(userId: string, orgId: string): Promise<string> {
  const versionId = await seedComposeVersion(userId, orgId);
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: raw row seeding
  const [compose] = await globalThis.services.db
    .select({ composeId: agentComposeVersions.composeId })
    .from(agentComposeVersions)
    .where(eq(agentComposeVersions.id, versionId))
    .limit(1);
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: raw row seeding
  const [session] = await globalThis.services.db
    .insert(agentSessions)
    .values({ userId, orgId, agentComposeId: compose!.composeId })
    .returning({ id: agentSessions.id });
  return session!.id;
}

function captureInsertError(
  promise: Promise<unknown>,
): Promise<{ code?: string }> {
  return promise.then(
    () => {
      return {};
    },
    (err: unknown) => {
      const cause = (err as { cause?: { code?: string } }).cause;
      return { code: cause?.code };
    },
  );
}

describe("migration 0292 agent_runs.session_id NOT NULL + FK", () => {
  beforeEach(() => {
    context.setupMocks();
    // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: needs services initialised to run raw SQL
    initServices();
  });

  it("rejects INSERT with NULL session_id (NOT NULL constraint)", async () => {
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const versionId = await seedComposeVersion(userId, orgId);

    const result = await captureInsertError(
      // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: exercises NOT NULL constraint directly
      globalThis.services.db.execute(sql`
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

    const result = await captureInsertError(
      // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: exercises FK constraint directly
      globalThis.services.db.insert(agentRuns).values({
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

    // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: happy-path insert
    const [run] = await globalThis.services.db
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

    // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: raw row seeding
    const [run] = await globalThis.services.db
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

    // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: triggers cascade delete
    await globalThis.services.db
      .delete(agentSessions)
      .where(eq(agentSessions.id, sessionId));

    // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: read-back assertion
    const rows = await globalThis.services.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));
    expect(rows).toHaveLength(0);
  });
});
