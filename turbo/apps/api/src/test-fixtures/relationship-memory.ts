/**
 * In-process test fixtures for relationship-memory state that production
 * APIs cannot construct deterministically.
 *
 * - Runtime-injection memory rows: the injection window ranks rows by kind,
 *   confidence, and last-seen time. The Gmail extraction path only emits
 *   `key_fact`/`preference`/`open_loop` items with server-assigned
 *   timestamps, so `recent_context` rows and the exact confidence/recency
 *   matrix the window tests need are unreachable through product writes.
 * - Alias-race trigger: reproducing the mid-insert alias claim race through
 *   product APIs would be timing-dependent and flaky. A per-test database
 *   trigger claims the identity alias the moment the racing entity row is
 *   inserted, making the race deterministic. Callers must drop the trigger
 *   in `onTestFinished` — it is a global database object.
 */
import {
  memories,
  memoryEntities,
  type MemoryKind,
} from "@vm0/db/schema/memory-substrate";
import { createStore } from "ccstate";
import { sql } from "drizzle-orm";

import { writeDb$ } from "../signals/external/db";

interface RelationshipMemoryFixture {
  readonly orgId: string;
  readonly userId: string;
}

interface RelationshipAliasRaceTrigger {
  readonly displayName: string;
  readonly functionName: string;
  readonly identityKey: string;
  readonly triggerName: string;
}

interface RuntimeInjectionSeedRow {
  readonly kind: MemoryKind;
  readonly text: string;
  readonly confidence: number;
  readonly lastSeenAt: string;
}

async function insertRuntimeInjectionMemories(
  fixture: RelationshipMemoryFixture,
  seedRows: readonly RuntimeInjectionSeedRow[],
): Promise<void> {
  const db = createStore().set(writeDb$);
  const [entity] = await db
    .insert(memoryEntities)
    .values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      type: "person",
      displayName: "Alice Runtime",
    })
    .returning({ id: memoryEntities.id });
  if (!entity) {
    throw new Error("Expected runtime injection fixture entity");
  }

  await db.insert(memories).values(
    seedRows.map((row) => {
      return {
        orgId: fixture.orgId,
        userId: fixture.userId,
        entityId: entity.id,
        kind: row.kind,
        status: "active" as const,
        text: row.text,
        confidence: row.confidence,
        lastSeenAt: new Date(row.lastSeenAt),
      };
    }),
  );
}

export async function seedRuntimeInjectionMemories(
  fixture: RelationshipMemoryFixture,
): Promise<void> {
  await insertRuntimeInjectionMemories(fixture, [
    {
      kind: "preference",
      text: "The user prefers concise launch summaries.",
      confidence: 92,
      lastSeenAt: "2026-07-05T12:00:00.000Z",
    },
    {
      kind: "recent_context",
      text: "The current work is validating runtime memory injection.",
      confidence: 84,
      lastSeenAt: "2026-07-06T12:00:00.000Z",
    },
    {
      kind: "open_loop",
      text: "Follow up on the security review injection preview.",
      confidence: 88,
      lastSeenAt: "2026-07-07T12:00:00.000Z",
    },
  ]);
}

export async function seedRuntimeInjectionWindowMemories(
  fixture: RelationshipMemoryFixture,
): Promise<void> {
  // Mirrors supermemory's profile-vs-search split: the stable/recent profile
  // is a bounded window, while the "relevant memories" section is a
  // full-corpus search that surfaces prompt-relevant memories the bounded
  // window left out. The higher-ranked recent_context rows fill the dynamic
  // window, so the low-confidence, older query-relevant row is excluded from
  // the profile and can only reach the prompt via query recall (and is
  // therefore not deduped away against the profile).
  await insertRuntimeInjectionMemories(fixture, [
    // Stable profile.
    {
      kind: "preference",
      text: "The user prefers concise launch summaries.",
      confidence: 92,
      lastSeenAt: "2026-07-05T12:00:00.000Z",
    },
    // Current context (open loop + recent context inside the bounded window).
    {
      kind: "open_loop",
      text: "Follow up on the security review injection preview.",
      confidence: 88,
      lastSeenAt: "2026-07-07T12:00:00.000Z",
    },
    {
      kind: "recent_context",
      text: "The current work is validating runtime memory injection.",
      confidence: 84,
      lastSeenAt: "2026-07-06T12:00:00.000Z",
    },
    // Higher-ranked recent context that fills the bounded window and pushes
    // the query-relevant row below out of the profile sections.
    {
      kind: "recent_context",
      text: "Reviewing the Q3 roadmap draft.",
      confidence: 90,
      lastSeenAt: "2026-07-07T12:00:00.000Z",
    },
    {
      kind: "recent_context",
      text: "Preparing the weekly investor update.",
      confidence: 89,
      lastSeenAt: "2026-07-07T12:00:00.000Z",
    },
    {
      kind: "recent_context",
      text: "Coordinating the design system migration.",
      confidence: 87,
      lastSeenAt: "2026-07-06T12:00:00.000Z",
    },
    {
      kind: "recent_context",
      text: "Testing the new onboarding flow.",
      confidence: 86,
      lastSeenAt: "2026-07-06T12:00:00.000Z",
    },
    // Query-relevant memory that falls outside the bounded recent-context
    // window (lowest confidence, oldest) and is only surfaced by prompt
    // recall.
    {
      kind: "recent_context",
      text: "Capture findings from the security review injection preview session.",
      confidence: 55,
      lastSeenAt: "2026-06-20T12:00:00.000Z",
    },
  ]);
}

function quoteSqlIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export async function installAliasRaceTrigger(
  trigger: RelationshipAliasRaceTrigger,
): Promise<void> {
  const db = createStore().set(writeDb$);
  const functionName = quoteSqlIdentifier(trigger.functionName);
  const triggerName = quoteSqlIdentifier(trigger.triggerName);
  const displayName = quoteSqlString(trigger.displayName);
  const identityKey = quoteSqlString(trigger.identityKey);

  await db.execute(
    sql.raw(`
      CREATE FUNCTION ${functionName}()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        canonical_id uuid;
      BEGIN
        IF NEW.display_name <> ${displayName} THEN
          RETURN NEW;
        END IF;

        INSERT INTO "memory_entities" (
          "org_id",
          "user_id",
          "type",
          "display_name",
          "created_at",
          "updated_at"
        )
        VALUES (
          NEW.org_id,
          NEW.user_id,
          NEW.type,
          'Alias Race Winner',
          now(),
          now()
        )
        RETURNING "id" INTO canonical_id;

        INSERT INTO "memory_entity_aliases" (
          "org_id",
          "user_id",
          "entity_id",
          "provider",
          "alias_type",
          "alias_value",
          "created_at",
          "updated_at"
        )
        VALUES (
          NEW.org_id,
          NEW.user_id,
          canonical_id,
          NULL,
          'relationship_identity',
          ${identityKey},
          now(),
          now()
        );

        RETURN NEW;
      END
      $$;
    `),
  );
  await db.execute(
    sql.raw(`
      CREATE TRIGGER ${triggerName}
      AFTER INSERT ON "memory_entities"
      FOR EACH ROW
      EXECUTE FUNCTION ${functionName}();
    `),
  );
}

export async function dropAliasRaceTrigger(
  trigger: RelationshipAliasRaceTrigger,
): Promise<void> {
  const db = createStore().set(writeDb$);
  const functionName = quoteSqlIdentifier(trigger.functionName);
  const triggerName = quoteSqlIdentifier(trigger.triggerName);

  await db.execute(
    sql.raw(`DROP TRIGGER IF EXISTS ${triggerName} ON "memory_entities";`),
  );
  await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${functionName}();`));
}
