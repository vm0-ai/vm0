import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { testContext } from "../test-helpers";
import { initServices } from "../../lib/init-services";

/**
 * Integration test for migration 0301 body.
 *
 * The migration has already run against the shared test DB, so the dropped
 * `artifact_snapshot` / `memory_snapshot` columns are no longer on the real
 * `checkpoints` table. We therefore stage the pre-migration shape in a
 * regular shadow table with the same structure, execute the backfill UPDATE
 * verbatim, and assert the fold + idempotence semantics. Temp tables cannot
 * be used here because the pg pool routes each query to a different
 * connection, losing TEMP-scoped state between calls.
 *
 * The column-drop assertions run against the real `checkpoints` table via
 * `information_schema.columns`.
 */

const context = testContext();

async function createShadowTable(): Promise<void> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: shadow table mirrors pre-migration shape
  await globalThis.services.db.execute(sql`
    CREATE TABLE IF NOT EXISTS checkpoints_0301_shadow (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      artifact_snapshot jsonb,
      artifact_snapshots jsonb,
      memory_snapshot jsonb
    )
  `);
}

async function dropShadowTable(): Promise<void> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: cleanup shadow table
  await globalThis.services.db.execute(sql`
    DROP TABLE IF EXISTS checkpoints_0301_shadow
  `);
}

async function seedShadowRow(row: {
  artifactSnapshot: { artifactName: string; artifactVersion: string } | null;
  artifactSnapshots: Record<string, string> | null;
  memorySnapshot: Record<string, unknown> | null;
}): Promise<string> {
  const id = randomUUID();
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: seeds shadow temp table
  await globalThis.services.db.execute(sql`
    INSERT INTO checkpoints_0301_shadow (id, artifact_snapshot, artifact_snapshots, memory_snapshot)
    VALUES (
      ${id}::uuid,
      ${row.artifactSnapshot ? sql`${JSON.stringify(row.artifactSnapshot)}::jsonb` : sql`NULL`},
      ${row.artifactSnapshots ? sql`${JSON.stringify(row.artifactSnapshots)}::jsonb` : sql`NULL`},
      ${row.memorySnapshot ? sql`${JSON.stringify(row.memorySnapshot)}::jsonb` : sql`NULL`}
    )
  `);
  return id;
}

async function runBackfillOnShadow(): Promise<void> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: executes the verbatim backfill body
  await globalThis.services.db.execute(sql`
    UPDATE checkpoints_0301_shadow
    SET artifact_snapshots = jsonb_build_object(
      artifact_snapshot->>'artifactName',
      artifact_snapshot->>'artifactVersion'
    )
    WHERE artifact_snapshot IS NOT NULL
      AND (artifact_snapshots IS NULL OR artifact_snapshots = '{}'::jsonb)
  `);
}

async function readArtifactSnapshots(
  id: string,
): Promise<Record<string, string> | null> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: read-back assertion on shadow table
  const result = await globalThis.services.db.execute<{
    artifact_snapshots: Record<string, string> | null;
  }>(sql`
    SELECT artifact_snapshots FROM checkpoints_0301_shadow WHERE id = ${id}::uuid
  `);
  return result.rows[0]?.artifact_snapshots ?? null;
}

async function columnExists(column: string): Promise<boolean> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: information_schema check
  const result = await globalThis.services.db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'checkpoints'
        AND column_name = ${column}
    ) AS exists
  `);
  return result.rows[0]?.exists === true;
}

describe("migration 0301 drop memory and artifact snapshot", () => {
  beforeEach(async () => {
    context.setupMocks();
    // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: needs services initialised to run raw SQL
    initServices();
    await createShadowTable();
    // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: reset shadow table between cases
    await globalThis.services.db.execute(sql`TRUNCATE checkpoints_0301_shadow`);
  });

  afterAll(async () => {
    await dropShadowTable();
  });

  it("folds the legacy singleton into artifact_snapshots when the map is NULL", async () => {
    const id = await seedShadowRow({
      artifactSnapshot: {
        artifactName: "my-artifact",
        artifactVersion: "v1.2.3",
      },
      artifactSnapshots: null,
      memorySnapshot: { ignoredKey: "this gets discarded" },
    });

    await runBackfillOnShadow();

    const snapshots = await readArtifactSnapshots(id);
    expect(snapshots).toEqual({ "my-artifact": "v1.2.3" });
  });

  it("folds the legacy singleton into artifact_snapshots when the map is empty '{}'", async () => {
    const id = await seedShadowRow({
      artifactSnapshot: {
        artifactName: "empty-case",
        artifactVersion: "v0.0.1",
      },
      artifactSnapshots: {},
      memorySnapshot: null,
    });

    await runBackfillOnShadow();

    const snapshots = await readArtifactSnapshots(id);
    expect(snapshots).toEqual({ "empty-case": "v0.0.1" });
  });

  it("does not clobber artifact_snapshots when the map is already populated (idempotent on pre-backfilled rows)", async () => {
    const prePopulated = { "first-art": "v1", "second-art": "v2" };
    const id = await seedShadowRow({
      artifactSnapshot: {
        artifactName: "would-clobber",
        artifactVersion: "v99",
      },
      artifactSnapshots: prePopulated,
      memorySnapshot: null,
    });

    await runBackfillOnShadow();

    const snapshots = await readArtifactSnapshots(id);
    expect(snapshots).toEqual(prePopulated);
  });

  it("leaves rows with only artifact_snapshots populated unchanged (post-multi-mount row)", async () => {
    const prePopulated = { "already-migrated": "v42" };
    const id = await seedShadowRow({
      artifactSnapshot: null,
      artifactSnapshots: prePopulated,
      memorySnapshot: null,
    });

    await runBackfillOnShadow();

    const snapshots = await readArtifactSnapshots(id);
    expect(snapshots).toEqual(prePopulated);
  });

  it("is idempotent — re-running the backfill after a fold is a no-op", async () => {
    const id = await seedShadowRow({
      artifactSnapshot: {
        artifactName: "idem-art",
        artifactVersion: "v7",
      },
      artifactSnapshots: null,
      memorySnapshot: null,
    });

    await runBackfillOnShadow();
    await runBackfillOnShadow();

    const snapshots = await readArtifactSnapshots(id);
    expect(snapshots).toEqual({ "idem-art": "v7" });
  });

  it("drops the legacy artifact_snapshot column from checkpoints", async () => {
    expect(await columnExists("artifact_snapshot")).toBe(false);
  });

  it("drops the legacy memory_snapshot column from checkpoints", async () => {
    expect(await columnExists("memory_snapshot")).toBe(false);
  });

  it("keeps the artifact_snapshots map column on checkpoints", async () => {
    expect(await columnExists("artifact_snapshots")).toBe(true);
  });
});
