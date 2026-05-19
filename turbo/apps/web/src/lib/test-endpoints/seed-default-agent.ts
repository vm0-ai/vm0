import { createHash } from "crypto";
import { and, eq, isNull } from "drizzle-orm";
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
 * Seed the minimum state required for a Slack/Telegram event dispatch to succeed:
 * an agent compose with a head version, a matching zero_agents row, and
 * an org_metadata entry pointing `default_agent_id` at it.
 *
 * Idempotent per (orgId, name) — re-running reuses the existing compose.
 * Used by the legacy `/api/test/telegram-state` web route so BATS e2e tests
 * can drive the full mention/DM dispatch path without going through the compose
 * API.
 */
export async function seedDefaultAgent(
  services: Services,
  input: SeedDefaultAgentInput,
): Promise<{ composeId: string; versionId: string; agentId: string }> {
  const { db } = services;

  const compose = await getOrInsertCompose(db, input);
  const composeId = compose.id;
  const versionId = await ensureComposeVersion(
    db,
    composeId,
    input.userId,
    input.name,
    compose.headVersionId,
  );

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

async function getOrInsertCompose(
  db: typeof globalThis.services.db,
  input: SeedDefaultAgentInput,
): Promise<{ id: string; headVersionId: string | null }> {
  const [inserted] = await db
    .insert(agentComposes)
    .values({
      userId: input.userId,
      orgId: input.orgId,
      name: input.name,
    })
    .onConflictDoNothing({
      target: [agentComposes.orgId, agentComposes.name],
    })
    .returning({
      id: agentComposes.id,
      headVersionId: agentComposes.headVersionId,
    });

  if (inserted) return inserted;

  const [existing] = await db
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

  if (!existing) {
    throw new Error("Failed to resolve agent compose after conflict");
  }
  return existing;
}

async function ensureComposeVersion(
  db: typeof globalThis.services.db,
  composeId: string,
  userId: string,
  name: string,
  headVersionId: string | null,
): Promise<string> {
  if (headVersionId) return headVersionId;

  const content = defaultAgentContent(name);
  const versionId = createHash("sha256")
    .update(JSON.stringify(content) + composeId)
    .digest("hex");
  await db
    .insert(agentComposeVersions)
    .values({
      id: versionId,
      composeId,
      content,
      createdBy: userId,
    })
    .onConflictDoNothing();

  const [updated] = await db
    .update(agentComposes)
    .set({ headVersionId: versionId, updatedAt: new Date() })
    .where(
      and(eq(agentComposes.id, composeId), isNull(agentComposes.headVersionId)),
    )
    .returning({ headVersionId: agentComposes.headVersionId });
  if (updated?.headVersionId) return updated.headVersionId;

  const [compose] = await db
    .select({ headVersionId: agentComposes.headVersionId })
    .from(agentComposes)
    .where(eq(agentComposes.id, composeId))
    .limit(1);
  if (compose?.headVersionId) return compose.headVersionId;

  throw new Error("Failed to resolve agent compose head version");
}

function defaultAgentContent(name: string) {
  return {
    version: "1.0",
    agents: {
      [name]: {
        framework: "claude-code",
        // Explicit model-provider env var so validateComposeRequirements
        // skips model policy materialization (e2e previews don't have one
        // configured). Value is a placeholder — USE_MOCK_CLAUDE on preview
        // short-circuits actual Claude calls anyway.
        environment: {
          ANTHROPIC_API_KEY: "fake-e2e-anthropic-key",
        },
      },
    },
  };
}
