import { createHash } from "node:crypto";

import { agentComposeApiContentSchema } from "@okouai/api-contracts/contracts/composes";
import {
  agentComposes,
  agentComposeVersions,
} from "@okouai/db/schema/agent-compose";
import { zeroAgents } from "@okouai/db/schema/zero-agent";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";

import { db } from "../lib/db";
import { nowDate } from "../lib/time";

// Production Agent APIs intentionally do not expose internal Compose names,
// immutable version ids, or arbitrary legacy version content. Surviving tests
// use this fixture only when that historical state is the behavior under test;
// setup that only needs a current Agent must use POST /api/agents.

type HistoricalAgentComposeContent = z.infer<
  typeof agentComposeApiContentSchema
>;

interface HistoricalAgentComposeActor {
  readonly userId: string;
  readonly orgId: string;
}

function sortObjectKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }

  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = sortObjectKeys(record[key]);
  }
  return sorted;
}

function composeVersionId(content: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(sortObjectKeys(content)))
    .digest("hex");
}

function normalizeHistoricalContent(content: HistoricalAgentComposeContent): {
  readonly name: string;
  readonly content: HistoricalAgentComposeContent;
} {
  const agentNames = Object.keys(content.agents);
  if (agentNames.length !== 1) {
    throw new Error("Historical Compose fixtures require exactly one Agent");
  }
  const agentName = agentNames[0];
  if (!agentName) {
    throw new Error("Historical Compose fixtures require an Agent name");
  }
  const agent = content.agents[agentName];
  if (!agent) {
    throw new Error("Historical Compose fixtures require an Agent definition");
  }

  const name = agentName.toLowerCase();
  const { skills: _deprecatedSkills, ...agentWithoutSkills } = agent;
  return {
    name,
    content: {
      ...content,
      agents: { [name]: agentWithoutSkills },
    },
  };
}

export async function createHistoricalAgentComposeFixture(args: {
  readonly actor: HistoricalAgentComposeActor;
  readonly content: HistoricalAgentComposeContent;
  readonly canonicalAgent?: {
    readonly displayName?: string;
    readonly visibility: "private" | "public";
  };
  readonly signal: AbortSignal;
}): Promise<{
  readonly composeId: string;
  readonly name: string;
  readonly versionId: string;
}> {
  const normalized = normalizeHistoricalContent(args.content);
  const versionId = composeVersionId(normalized.content);

  const result = await db().transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: agentComposes.id })
      .from(agentComposes)
      .where(
        and(
          eq(agentComposes.orgId, args.actor.orgId),
          eq(agentComposes.name, normalized.name),
        ),
      )
      .limit(1);
    args.signal.throwIfAborted();

    let composeId = existing?.id;
    if (!composeId) {
      const [created] = await tx
        .insert(agentComposes)
        .values({
          userId: args.actor.userId,
          orgId: args.actor.orgId,
          name: normalized.name,
        })
        .returning({ id: agentComposes.id });
      args.signal.throwIfAborted();
      if (!created) {
        throw new Error("Failed to construct a historical Agent Compose");
      }
      composeId = created.id;
    }

    await tx
      .insert(agentComposeVersions)
      .values({
        id: versionId,
        composeId,
        content: normalized.content,
        createdBy: args.actor.userId,
      })
      .onConflictDoNothing();
    args.signal.throwIfAborted();

    await tx
      .update(agentComposes)
      .set({ headVersionId: versionId, updatedAt: nowDate() })
      .where(eq(agentComposes.id, composeId));
    args.signal.throwIfAborted();

    if (args.canonicalAgent) {
      await tx
        .insert(zeroAgents)
        .values({
          id: composeId,
          orgId: args.actor.orgId,
          owner: args.actor.userId,
          name: normalized.name,
          visibility: args.canonicalAgent.visibility,
          displayName: args.canonicalAgent.displayName,
        })
        .onConflictDoNothing();
      args.signal.throwIfAborted();
    }

    return { composeId, name: normalized.name, versionId };
  });
  args.signal.throwIfAborted();
  return result;
}

export async function readHistoricalAgentComposeHeadFixture(
  composeId: string,
): Promise<{
  readonly composeId: string;
  readonly name: string;
  readonly headVersionId: string | null;
  readonly content: HistoricalAgentComposeContent | null;
}> {
  const [row] = await db()
    .select({
      composeId: agentComposes.id,
      name: agentComposes.name,
      headVersionId: agentComposes.headVersionId,
      content: agentComposeVersions.content,
    })
    .from(agentComposes)
    .leftJoin(
      agentComposeVersions,
      eq(agentComposes.headVersionId, agentComposeVersions.id),
    )
    .where(eq(agentComposes.id, composeId))
    .limit(1);
  if (!row) {
    throw new Error("Expected a historical Agent Compose fixture");
  }
  return {
    ...row,
    content:
      row.content === null
        ? null
        : agentComposeApiContentSchema.parse(row.content),
  };
}

export async function replaceHistoricalAgentComposeHeadFixture(
  args: {
    readonly composeId: string;
    readonly userId: string;
    readonly content: Record<string, unknown>;
  },
  signal: AbortSignal,
): Promise<{ readonly versionId: string }> {
  const versionId = composeVersionId(args.content);
  await db().transaction(async (tx) => {
    await tx
      .insert(agentComposeVersions)
      .values({
        id: versionId,
        composeId: args.composeId,
        content: args.content,
        createdBy: args.userId,
      })
      .onConflictDoNothing();
    signal.throwIfAborted();

    await tx
      .update(agentComposes)
      .set({ headVersionId: versionId, updatedAt: nowDate() })
      .where(eq(agentComposes.id, args.composeId));
    signal.throwIfAborted();
  });
  signal.throwIfAborted();
  return { versionId };
}

export async function setHistoricalAgentComposeHeadFixture(
  composeId: string,
  headVersionId: string | null,
  signal: AbortSignal,
): Promise<void> {
  const [updated] = await db()
    .update(agentComposes)
    .set({ headVersionId, updatedAt: nowDate() })
    .where(eq(agentComposes.id, composeId))
    .returning({ id: agentComposes.id });
  signal.throwIfAborted();
  if (!updated) {
    throw new Error("Expected a historical Agent Compose fixture");
  }
}

export async function readRawHistoricalAgentComposeHeadFixture(
  composeId: string,
): Promise<{
  readonly headVersionId: string | null;
  readonly content: unknown;
}> {
  const [row] = await db()
    .select({
      headVersionId: agentComposes.headVersionId,
      content: agentComposeVersions.content,
    })
    .from(agentComposes)
    .leftJoin(
      agentComposeVersions,
      eq(agentComposes.headVersionId, agentComposeVersions.id),
    )
    .where(eq(agentComposes.id, composeId))
    .limit(1);
  if (!row) {
    throw new Error("Expected a raw historical Agent Compose fixture");
  }
  return row;
}
