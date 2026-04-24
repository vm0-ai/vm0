import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { testContext } from "../../../__tests__/test-helpers";
import { initServices } from "../../../lib/init-services";

/**
 * Integration test for migration 0308 body.
 *
 * The migration has already run against the shared test DB, so the dropped
 * `artifact_names` column is no longer on the real `agent_sessions` table and
 * `checkpoints.artifact_snapshots` has already been normalised. We stage the
 * pre-migration shapes in shadow tables with the same structure, execute the
 * backfill bodies verbatim, and assert the projection semantics. Schema-drift
 * enforcement (dropped/added columns) is handled by CI `test-migrate` which
 * diffs the Drizzle schema TS against migration SQL.
 */

const AUTO_MEMORY_MOUNT_PATH =
  "/home/user/.claude/projects/-home-user-workspace/memory";
const WORKING_DIR = "/home/user/workspace";

const context = testContext();

async function createShadowTables(): Promise<void> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: shadow tables mirror pre-migration shape
  await globalThis.services.db.execute(sql`
    CREATE TABLE IF NOT EXISTS checkpoints_0308_shadow (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      artifact_snapshots jsonb
    )
  `);
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: shadow tables mirror pre-migration shape
  await globalThis.services.db.execute(sql`
    CREATE TABLE IF NOT EXISTS agent_sessions_0308_shadow (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      artifact_names jsonb NOT NULL DEFAULT '[]'::jsonb,
      artifacts jsonb NOT NULL DEFAULT '[]'::jsonb
    )
  `);
}

async function dropShadowTables(): Promise<void> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: cleanup shadow tables
  await globalThis.services.db.execute(
    sql`DROP TABLE IF EXISTS checkpoints_0308_shadow`,
  );
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: cleanup shadow tables
  await globalThis.services.db.execute(
    sql`DROP TABLE IF EXISTS agent_sessions_0308_shadow`,
  );
}

async function seedCheckpointRow(snapshots: unknown): Promise<string> {
  const id = randomUUID();
  const payload = snapshots === null ? null : JSON.stringify(snapshots);
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: seeds shadow table
  await globalThis.services.db.execute(sql`
    INSERT INTO checkpoints_0308_shadow (id, artifact_snapshots)
    VALUES (${id}::uuid, ${payload}::jsonb)
  `);
  return id;
}

async function seedSessionRow(names: string[]): Promise<string> {
  const id = randomUUID();
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: seeds shadow table
  await globalThis.services.db.execute(sql`
    INSERT INTO agent_sessions_0308_shadow (id, artifact_names)
    VALUES (${id}::uuid, ${JSON.stringify(names)}::jsonb)
  `);
  return id;
}

async function runCheckpointBackfill(): Promise<void> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: verbatim backfill body
  await globalThis.services.db.execute(sql`
    UPDATE checkpoints_0308_shadow
    SET artifact_snapshots = (
      SELECT jsonb_agg(
        jsonb_build_object(
          'name', kv.key,
          'version', kv.value,
          'mountPath', CASE
            WHEN kv.key = 'memory'
              THEN '/home/user/.claude/projects/-home-user-workspace/memory'
            ELSE '/home/user/workspace'
          END
        )
      )
      FROM jsonb_each_text(artifact_snapshots) kv
    )
    WHERE jsonb_typeof(artifact_snapshots) = 'object'
  `);
}

async function runSessionBackfill(): Promise<void> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: verbatim backfill body
  await globalThis.services.db.execute(sql`
    UPDATE agent_sessions_0308_shadow
    SET artifacts = COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'name', n.value,
          'version', 'latest',
          'mountPath', CASE
            WHEN n.value = 'memory'
              THEN '/home/user/.claude/projects/-home-user-workspace/memory'
            ELSE '/home/user/workspace'
          END
        )
      )
      FROM jsonb_array_elements_text(artifact_names) n(value)
    ), '[]'::jsonb)
  `);
}

async function readCheckpointSnapshots(id: string): Promise<unknown> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: read-back assertion
  const result = await globalThis.services.db.execute<{
    artifact_snapshots: unknown;
  }>(sql`
    SELECT artifact_snapshots FROM checkpoints_0308_shadow WHERE id = ${id}::uuid
  `);
  return result.rows[0]?.artifact_snapshots ?? null;
}

async function readSessionArtifacts(id: string): Promise<unknown> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: read-back assertion
  const result = await globalThis.services.db.execute<{
    artifacts: unknown;
  }>(sql`
    SELECT artifacts FROM agent_sessions_0308_shadow WHERE id = ${id}::uuid
  `);
  return result.rows[0]?.artifacts ?? null;
}

describe("migration 0308 unify artifact shape", () => {
  beforeEach(async () => {
    context.setupMocks();
    // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: needs services initialised to run raw SQL
    initServices();
    await createShadowTables();
    // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: reset shadow tables between cases
    await globalThis.services.db.execute(
      sql`TRUNCATE checkpoints_0308_shadow`,
    );
    // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: reset shadow tables between cases
    await globalThis.services.db.execute(
      sql`TRUNCATE agent_sessions_0308_shadow`,
    );
  });

  afterAll(async () => {
    await dropShadowTables();
  });

  describe("checkpoints.artifact_snapshots backfill", () => {
    it("converts legacy Record with memory name to array with AUTO_MEMORY_MOUNT_PATH", async () => {
      const id = await seedCheckpointRow({ memory: "v1" });

      await runCheckpointBackfill();

      expect(await readCheckpointSnapshots(id)).toEqual([
        { name: "memory", version: "v1", mountPath: AUTO_MEMORY_MOUNT_PATH },
      ]);
    });

    it("converts legacy Record with non-memory name to array with /home/user/workspace", async () => {
      const id = await seedCheckpointRow({ ctx: "v2" });

      await runCheckpointBackfill();

      expect(await readCheckpointSnapshots(id)).toEqual([
        { name: "ctx", version: "v2", mountPath: WORKING_DIR },
      ]);
    });

    it("leaves array-shape rows untouched via jsonb_typeof guard", async () => {
      const canonical = [
        { name: "foo", version: "v3", mountPath: "/mnt/foo" },
      ];
      const id = await seedCheckpointRow(canonical);

      await runCheckpointBackfill();

      expect(await readCheckpointSnapshots(id)).toEqual(canonical);
    });

    it("leaves null rows untouched", async () => {
      const id = await seedCheckpointRow(null);

      await runCheckpointBackfill();

      expect(await readCheckpointSnapshots(id)).toBeNull();
    });
  });

  describe("agent_sessions.artifacts backfill", () => {
    it("converts string[] with memory name to array with AUTO_MEMORY_MOUNT_PATH", async () => {
      const id = await seedSessionRow(["memory"]);

      await runSessionBackfill();

      expect(await readSessionArtifacts(id)).toEqual([
        {
          name: "memory",
          version: "latest",
          mountPath: AUTO_MEMORY_MOUNT_PATH,
        },
      ]);
    });

    it("converts string[] with non-memory name to array with /home/user/workspace", async () => {
      const id = await seedSessionRow(["ctx"]);

      await runSessionBackfill();

      expect(await readSessionArtifacts(id)).toEqual([
        { name: "ctx", version: "latest", mountPath: WORKING_DIR },
      ]);
    });

    it("converts empty string[] to empty array via COALESCE fallback", async () => {
      const id = await seedSessionRow([]);

      await runSessionBackfill();

      expect(await readSessionArtifacts(id)).toEqual([]);
    });
  });

});
