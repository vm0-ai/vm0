import { randomBytes } from "crypto";
import { and, eq } from "drizzle-orm";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { ensureStarterCreditGrant } from "../zero/credit/starter-grant-service";

interface Services {
  db: typeof globalThis.services.db;
}

interface SeedDefaultAgentInput {
  orgId: string;
  userId: string;
  name: string;
}

/**
 * Seed the minimum state required for a Slack event dispatch to succeed:
 * an agent compose with a head version, a matching zero_agents row, and
 * an org_metadata entry pointing `default_agent_id` at it.
 *
 * Idempotent per (orgId, name) — re-running reuses the existing compose.
 * Used by `/api/test/slack-state` so BATS e2e tests can drive the full
 * mention/DM dispatch path without going through the compose API.
 */
export async function seedDefaultAgent(
  services: Services,
  input: SeedDefaultAgentInput,
): Promise<{ composeId: string; versionId: string; agentId: string }> {
  const { db } = services;

  const [existingCompose] = await db
    .select({
      id: agentComposes.id,
      headVersionId: agentComposes.headVersionId,
    })
    .from(agentComposes)
    .where(
      and(
        eq(agentComposes.orgId, input.orgId),
        eq(agentComposes.name, input.name),
      ),
    )
    .limit(1);

  let composeId: string;
  let versionId: string;

  if (existingCompose) {
    composeId = existingCompose.id;
    versionId =
      existingCompose.headVersionId ??
      (await insertComposeVersion(db, composeId, input.userId));
  } else {
    const [row] = await db
      .insert(agentComposes)
      .values({
        userId: input.userId,
        orgId: input.orgId,
        name: input.name,
      })
      .returning({ id: agentComposes.id });
    if (!row) throw new Error("Failed to insert agent compose");
    composeId = row.id;
    versionId = await insertComposeVersion(db, composeId, input.userId);
  }

  await db
    .insert(zeroAgents)
    .values({
      id: composeId,
      orgId: input.orgId,
      owner: input.userId,
      name: input.name,
    })
    .onConflictDoNothing();

  // Starter grant must land alongside the default-agent row — BATS Slack
  // dispatch tests exercise credit checks on this path.
  await db.transaction(async (tx) => {
    await ensureStarterCreditGrant(tx, input.orgId);
    await tx
      .insert(orgMetadata)
      .values({ orgId: input.orgId, defaultAgentId: composeId })
      .onConflictDoUpdate({
        target: orgMetadata.orgId,
        set: { defaultAgentId: composeId, updatedAt: new Date() },
      });
  });

  return { composeId, versionId, agentId: composeId };
}

async function insertComposeVersion(
  db: typeof globalThis.services.db,
  composeId: string,
  userId: string,
): Promise<string> {
  // agent_compose_versions.id is varchar(64) (content-addressed SHA-256).
  // For the seed we use a random 64-char hex string — good enough for test
  // isolation and never clashes with a real content hash.
  const versionId = randomBytes(32).toString("hex");
  await db.insert(agentComposeVersions).values({
    id: versionId,
    composeId,
    content: {
      version: "1.0",
      agents: {
        "e2e-slack-agent": {
          framework: "claude-code",
          // Explicit model-provider env var so validateComposeRequirements
          // skips the org-default provider lookup (e2e previews don't have
          // one configured). Value is a placeholder — USE_MOCK_CLAUDE on
          // preview short-circuits actual Claude calls anyway.
          environment: {
            ANTHROPIC_API_KEY: "fake-e2e-anthropic-key",
          },
        },
      },
    },
    createdBy: userId,
  });
  await db
    .update(agentComposes)
    .set({ headVersionId: versionId })
    .where(eq(agentComposes.id, composeId));
  return versionId;
}
