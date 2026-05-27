import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../test-db";

/**
 * Integration test for migration 0307 body.
 *
 * The migration has already run against the shared test DB, so the dropped
 * `artifact_name` / `memory_name` columns are no longer on the real
 * `agent_sessions` table. We stage the pre-migration shape in a shadow table
 * with the same structure, execute the backfill UPDATE verbatim, and assert
 * the fold semantics. The column-drop and new-column assertions run against
 * the real `agent_sessions` table via `information_schema.columns`.
 */

async function createShadowTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS agent_sessions_0307_shadow (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      artifact_name varchar(255),
      artifact_names jsonb NOT NULL DEFAULT '[]'::jsonb
    )
  `);
}

async function dropShadowTable(): Promise<void> {
  await db.execute(sql`
    DROP TABLE IF EXISTS agent_sessions_0307_shadow
  `);
}

async function seedShadowRow(row: {
  artifactName: string | null;
}): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO agent_sessions_0307_shadow (id, artifact_name)
    VALUES (
      ${id}::uuid,
      ${row.artifactName}
    )
  `);
  return id;
}

async function runBackfillOnShadow(): Promise<void> {
  await db.execute(sql`
    UPDATE agent_sessions_0307_shadow
    SET artifact_names = CASE
      WHEN artifact_name IS NOT NULL THEN jsonb_build_array(artifact_name)
      ELSE '[]'::jsonb
    END
  `);
}

async function readArtifactNames(id: string): Promise<string[] | null> {
  const result = await db.execute<{
    artifact_names: string[] | null;
  }>(sql`
    SELECT artifact_names FROM agent_sessions_0307_shadow WHERE id = ${id}::uuid
  `);
  return result.rows[0]?.artifact_names ?? null;
}

async function columnExists(column: string): Promise<boolean> {
  const result = await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'agent_sessions'
        AND column_name = ${column}
    ) AS exists
  `);
  return result.rows[0]?.exists === true;
}

async function indexExists(index: string): Promise<boolean> {
  const result = await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'agent_sessions'
        AND indexname = ${index}
    ) AS exists
  `);
  return result.rows[0]?.exists === true;
}

describe("migration 0307 flatten artifact scalars", () => {
  beforeEach(async () => {
    await createShadowTable();
    await db.execute(sql`TRUNCATE agent_sessions_0307_shadow`);
  });

  afterAll(async () => {
    await dropShadowTable();
  });

  it("backfills a single-element array when artifact_name is non-null", async () => {
    const id = await seedShadowRow({ artifactName: "my-artifact" });

    await runBackfillOnShadow();

    const names = await readArtifactNames(id);
    expect(names).toEqual(["my-artifact"]);
  });

  it("backfills an empty array when artifact_name is null", async () => {
    const id = await seedShadowRow({ artifactName: null });

    await runBackfillOnShadow();

    const names = await readArtifactNames(id);
    expect(names).toEqual([]);
  });

  it("drops the legacy artifact_name column from agent_sessions", async () => {
    expect(await columnExists("artifact_name")).toBe(false);
  });

  it("drops the legacy memory_name column from agent_sessions", async () => {
    expect(await columnExists("memory_name")).toBe(false);
  });

  it("drops the old idx_agent_sessions_user_compose_artifact index", async () => {
    expect(await indexExists("idx_agent_sessions_user_compose_artifact")).toBe(
      false,
    );
  });

  it("creates the new idx_agent_sessions_user_compose index", async () => {
    expect(await indexExists("idx_agent_sessions_user_compose")).toBe(true);
  });
});
