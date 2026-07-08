import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { writeDb$, type Db } from "../external/db";
import { upsertGraphRelationshipEntity } from "./memory-graph.service";

interface CleanupTarget {
  readonly functionName: string;
  readonly orgId: string;
  readonly triggerName: string;
  readonly userId: string;
}

interface AliasRaceFixture extends CleanupTarget {
  readonly displayName: string;
  readonly email: string;
  readonly identityKey: string;
}

interface EntityRow extends Record<string, unknown> {
  readonly displayName: string;
  readonly id: string;
  readonly type: "person" | "organization";
}

interface AliasRow extends Record<string, unknown> {
  readonly aliasType: string;
  readonly aliasValue: string;
  readonly entityId: string;
}

function createAliasRaceFixture(): AliasRaceFixture {
  const orgId = randomUUID();
  const userId = randomUUID();
  const suffix = randomUUID().replaceAll("-", "_");
  const email = `alias-race-${suffix}@example.test`;
  return {
    orgId,
    userId,
    email,
    identityKey: `person:${email}`,
    displayName: `Alias Race ${suffix}`,
    functionName: `vm0_test_claim_alias_${suffix}`,
    triggerName: `vm0_test_claim_alias_${suffix}`,
  };
}

async function createAliasRaceTrigger(
  db: Db,
  fixture: AliasRaceFixture,
): Promise<void> {
  await db.execute(
    sql.raw(`
      CREATE FUNCTION "${fixture.functionName}"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        canonical_id uuid;
      BEGIN
        IF NEW.display_name <> '${fixture.displayName}' THEN
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
          'Alias Race Winner ${fixture.functionName}',
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
          '${fixture.identityKey}',
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
      CREATE TRIGGER "${fixture.triggerName}"
      AFTER INSERT ON "memory_entities"
      FOR EACH ROW
      EXECUTE FUNCTION "${fixture.functionName}"();
    `),
  );
}

async function loadScopedEntities(
  db: Db,
  fixture: AliasRaceFixture,
): Promise<readonly EntityRow[]> {
  const entities = await db.execute<EntityRow>(sql`
    SELECT
      "id" AS "id",
      "type" AS "type",
      "display_name" AS "displayName"
    FROM "memory_entities"
    WHERE "org_id" = ${fixture.orgId}
      AND "user_id" = ${fixture.userId}
    ORDER BY "display_name"
  `);
  return entities.rows;
}

async function loadScopedAliases(
  db: Db,
  fixture: AliasRaceFixture,
): Promise<readonly AliasRow[]> {
  const aliases = await db.execute<AliasRow>(sql`
    SELECT
      "entity_id" AS "entityId",
      "alias_type" AS "aliasType",
      "alias_value" AS "aliasValue"
    FROM "memory_entity_aliases"
    WHERE "org_id" = ${fixture.orgId}
      AND "user_id" = ${fixture.userId}
      AND "alias_value" IN (${fixture.identityKey}, ${fixture.email})
    ORDER BY "alias_type"
  `);
  return aliases.rows;
}

describe("memory graph service", () => {
  const store = createStore();
  let cleanupTarget: CleanupTarget | null = null;

  afterEach(async () => {
    const target = cleanupTarget;
    cleanupTarget = null;
    if (!target) {
      return;
    }

    const db = store.set(writeDb$);
    await db.execute(
      sql.raw(
        `DROP TRIGGER IF EXISTS "${target.triggerName}" ON "memory_entities";`,
      ),
    );
    await db.execute(
      sql.raw(`DROP FUNCTION IF EXISTS "${target.functionName}"();`),
    );
    await db.execute(sql`
      DELETE FROM "memory_entities"
      WHERE "org_id" = ${target.orgId}
        AND "user_id" = ${target.userId}
    `);
  });

  it("returns the relationship identity alias winner when a duplicate entity races insertion", async () => {
    const db = store.set(writeDb$);
    const fixture = createAliasRaceFixture();
    cleanupTarget = fixture;
    await createAliasRaceTrigger(db, fixture);

    const entityId = await upsertGraphRelationshipEntity({
      db,
      orgId: fixture.orgId,
      userId: fixture.userId,
      target: {
        type: "person",
        identityKey: fixture.identityKey,
        displayName: fixture.displayName,
        primaryEmail: fixture.email,
        domain: "example.test",
      },
    });

    expect(await loadScopedEntities(db, fixture)).toStrictEqual([
      {
        id: entityId,
        type: "person",
        displayName: fixture.displayName,
      },
    ]);

    const aliases = await loadScopedAliases(db, fixture);
    expect(aliases).toHaveLength(2);
    expect(aliases).toStrictEqual(
      expect.arrayContaining([
        {
          entityId,
          aliasType: "relationship_identity",
          aliasValue: fixture.identityKey,
        },
        {
          entityId,
          aliasType: "email",
          aliasValue: fixture.email,
        },
      ]),
    );
  });
});
