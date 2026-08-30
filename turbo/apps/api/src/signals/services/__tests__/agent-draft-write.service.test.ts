import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type {
  AgentDraftAttachments,
  AgentDraftUserMessage,
} from "@okouai/db/jsonb-contracts/agent-draft";
import { agentDrafts } from "@okouai/db/schema/agent-draft";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, test } from "vitest";

import type { ApiDb } from "../../../lib/db-types";
import { env } from "../../../lib/env";
import {
  type AgentDraftWrite,
  persistAgentDraft,
} from "../agent-draft-write.service";

// Production API callers cannot select whether the mapped relation is a table
// or a compatibility view. This focused rollout exception crosses the endpoint
// boundary only to prove the exact writer against both PostgreSQL targets;
// route behavior remains covered through the real Agent Draft endpoints.
type RelationTarget = "physical" | "view";

interface RelationHarness {
  readonly db: ApiDb;
  readonly destroy: () => Promise<void>;
}

function qualifiedName(schemaName: string, relationName: string) {
  return sql`${sql.identifier(schemaName)}.${sql.identifier(relationName)}`;
}

async function createRelationHarness(
  target: RelationTarget,
): Promise<RelationHarness> {
  const adminPool = new Pool({
    allowExitOnIdle: true,
    connectionString: env("DATABASE_URL"),
    max: 1,
  });
  const adminDb = drizzle(adminPool);
  const schemaName = `agent_draft_${target}_${randomUUID().replaceAll("-", "")}`;
  const draftRelation = qualifiedName(schemaName, "agent_drafts");

  await adminDb.execute(sql`CREATE SCHEMA ${sql.identifier(schemaName)}`);
  if (target === "physical") {
    await adminDb.execute(sql`
      CREATE TABLE ${draftRelation}
      (LIKE "public"."agent_drafts" INCLUDING ALL)
    `);
  } else {
    const backingRelation = qualifiedName(schemaName, "agent_drafts_backing");
    await adminDb.execute(sql`
      CREATE TABLE ${backingRelation}
      (LIKE "public"."agent_drafts" INCLUDING ALL)
    `);
    await adminDb.execute(sql`
      CREATE VIEW ${draftRelation} AS
      SELECT
        "user_id",
        "org_id",
        "agent_id",
        "draft_user_message",
        "draft_attachments",
        "created_at",
        "updated_at"
      FROM ${backingRelation}
    `);
  }

  const pool = new Pool({
    allowExitOnIdle: true,
    connectionString: env("DATABASE_URL"),
    max: 8,
    options: `-c search_path=${schemaName},public`,
  });
  return {
    db: drizzle(pool),
    destroy: async () => {
      await pool.end();
      await adminDb.execute(
        sql`DROP SCHEMA ${sql.identifier(schemaName)} CASCADE`,
      );
      await adminPool.end();
    },
  };
}

function draftUserMessage(text: string): AgentDraftUserMessage {
  return {
    version: 1,
    parts: [{ type: "text", text }],
  };
}

function draftWrite(
  key: Pick<AgentDraftWrite, "userId" | "orgId" | "agentId">,
  text: string,
  updatedAt: Date,
): AgentDraftWrite {
  return {
    ...key,
    draftUserMessage: draftUserMessage(text),
    draftAttachments: null,
    updatedAt,
  };
}

function selectDraft(
  db: ApiDb,
  key: Pick<AgentDraftWrite, "userId" | "orgId" | "agentId">,
) {
  return db
    .select()
    .from(agentDrafts)
    .where(
      and(
        eq(agentDrafts.userId, key.userId),
        eq(agentDrafts.orgId, key.orgId),
        eq(agentDrafts.agentId, key.agentId),
      ),
    );
}

test("keeps Agent Draft runtime writes free of relation-specific conflict SQL", async () => {
  const runtimeSources = await Promise.all([
    readFile(
      new URL("../agent-draft-write.service.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../../routes/agent-draft.ts", import.meta.url), "utf8"),
  ]);
  const runtimeSource = runtimeSources.join("\n");

  expect(runtimeSource).not.toMatch(
    /\bonConflict(?:DoNothing|DoUpdate)\b|\bON\s+CONFLICT\b|\bMERGE\b/i,
  );
  expect(runtimeSource).not.toMatch(/\b(?:zero_agent_drafts|agent_drafts)\b/);
});

describe.each([
  { label: "physical relation", target: "physical" as const },
  { label: "simple auto-updatable view", target: "view" as const },
])("Agent Draft writes through a $label", ({ target }) => {
  let harness: RelationHarness;

  beforeEach(async () => {
    harness = await createRelationHarness(target);
  });

  afterEach(async () => {
    await harness.destroy();
  });

  it("creates with the database timestamp default and updates in place", async () => {
    const key = {
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      agentId: randomUUID(),
    };
    const firstUpdatedAt = new Date("2026-08-25T10:00:00.000Z");
    const firstWrite = draftWrite(key, "first draft", firstUpdatedAt);

    await persistAgentDraft(harness.db, firstWrite);

    const [created] = await selectDraft(harness.db, firstWrite);
    expect(created).toMatchObject({
      ...key,
      draftUserMessage: draftUserMessage("first draft"),
      draftAttachments: null,
      updatedAt: firstUpdatedAt,
    });
    expect(created?.createdAt).toBeInstanceOf(Date);

    const secondUpdatedAt = new Date("2026-08-25T10:05:00.000Z");
    const secondWrite = draftWrite(key, "updated draft", secondUpdatedAt);
    await persistAgentDraft(harness.db, secondWrite);

    const [updated] = await selectDraft(harness.db, secondWrite);
    expect(updated).toMatchObject({
      ...key,
      draftUserMessage: draftUserMessage("updated draft"),
      draftAttachments: null,
      createdAt: created?.createdAt,
      updatedAt: secondUpdatedAt,
    });

    await persistAgentDraft(harness.db, {
      ...key,
      draftUserMessage: null,
      draftAttachments: null,
      updatedAt: new Date("2026-08-25T10:10:00.000Z"),
    });
    await expect(selectDraft(harness.db, secondWrite)).resolves.toHaveLength(0);
  });

  it("converges concurrent first writes to one valid row", async () => {
    const key = {
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      agentId: randomUUID(),
    };
    const writes = Array.from({ length: 8 }, (_, index) => {
      return draftWrite(
        key,
        `concurrent draft ${index}`,
        new Date(`2026-08-25T10:00:0${index}.000Z`),
      );
    });

    await Promise.all(
      writes.map(async (write) => {
        await persistAgentDraft(harness.db, write);
      }),
    );

    const rows = await selectDraft(harness.db, key);
    expect(rows).toHaveLength(1);
    expect(writes).toContainEqual(
      expect.objectContaining({
        draftUserMessage: rows[0]?.draftUserMessage,
        updatedAt: rows[0]?.updatedAt,
      }),
    );
  });

  it("propagates non-unique constraint failures", async () => {
    const attachments: AgentDraftAttachments = [
      {
        id: randomUUID(),
        url: "https://cdn.example.com/draft-file.txt",
        filename: "draft-file.txt",
        contentType: "text/plain",
        size: 123,
      },
    ];
    const invalidWrite: AgentDraftWrite = {
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      agentId: randomUUID(),
      draftUserMessage: null,
      draftAttachments: attachments,
      updatedAt: new Date("2026-08-25T10:10:00.000Z"),
    };

    await expect(
      persistAgentDraft(harness.db, invalidWrite),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(selectDraft(harness.db, invalidWrite)).resolves.toHaveLength(
      0,
    );
  });
});
