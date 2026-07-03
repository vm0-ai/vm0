import { createHash } from "node:crypto";

import { command } from "ccstate";
import {
  AGENT_NAME_REGEX,
  agentComposeApiContentSchema,
} from "@vm0/api-contracts/contracts/composes";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";

import { badRequestMessage } from "../../lib/error";
import { writeDb$ } from "../external/db";
import { nowDate } from "../external/time";

type AgentComposeApiContent = z.infer<typeof agentComposeApiContentSchema>;

interface CreateAgentComposeArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly content: AgentComposeApiContent;
}

interface CreateAgentComposeBody {
  readonly composeId: string;
  readonly name: string;
  readonly versionId: string;
  readonly action: "created" | "existing";
  readonly updatedAt: string;
}

type CreateAgentComposeResult =
  | ReturnType<typeof badRequestMessage>
  | {
      readonly status: 200 | 201;
      readonly body: CreateAgentComposeBody;
    };

function sortObjectKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }

  const sorted: Record<string, unknown> = {};
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  for (const key of keys) {
    sorted[key] = sortObjectKeys(record[key]);
  }
  return sorted;
}

function computeComposeVersionId(content: unknown): string {
  const canonical = JSON.stringify(sortObjectKeys(content));
  return createHash("sha256").update(canonical).digest("hex");
}

export const createAgentCompose$ = command(
  async (
    { set },
    args: CreateAgentComposeArgs,
    signal: AbortSignal,
  ): Promise<CreateAgentComposeResult> => {
    if (Array.isArray(args.content.agents)) {
      return badRequestMessage(
        "agents must be an object, not an array. Use format: agents: { agent-name: { ... } }",
      );
    }

    const agentKeys = Object.keys(args.content.agents);
    if (agentKeys.length === 0) {
      return badRequestMessage("agents must have at least one agent defined");
    }

    if (agentKeys.length > 1) {
      return badRequestMessage(
        "Multiple agents not supported yet. Only one agent allowed.",
      );
    }

    const agentName = agentKeys[0];
    if (!agentName) {
      return badRequestMessage("agents must have at least one agent defined");
    }

    if (!AGENT_NAME_REGEX.test(agentName)) {
      return badRequestMessage(
        "Invalid agent name format. Must be 3-64 characters, letters, numbers, and hyphens only. Must start and end with letter or number.",
      );
    }

    const agent = args.content.agents[agentName];
    if (!agent) {
      return badRequestMessage("agents must have at least one agent defined");
    }

    const normalizedAgentName = agentName.toLowerCase();
    const { skills: _deprecatedSkills, ...agentWithoutSkills } = agent;
    const resolvedContent = {
      ...args.content,
      agents: {
        [normalizedAgentName]: agentWithoutSkills,
      },
    };
    const versionId = computeComposeVersionId(resolvedContent);
    const db = set(writeDb$);

    const [existingComposes, existingVersions] = await Promise.all([
      db
        .select()
        .from(agentComposes)
        .where(
          and(
            eq(agentComposes.orgId, args.orgId),
            eq(agentComposes.name, normalizedAgentName),
          ),
        )
        .limit(1),
      db
        .select()
        .from(agentComposeVersions)
        .where(eq(agentComposeVersions.id, versionId))
        .limit(1),
    ]);
    signal.throwIfAborted();

    const existing = existingComposes[0];
    let composeId = existing?.id;
    const isNewCompose = !composeId;

    if (!composeId) {
      const [created] = await db
        .insert(agentComposes)
        .values({
          userId: args.userId,
          name: normalizedAgentName,
          orgId: args.orgId,
        })
        .returning({ id: agentComposes.id });
      signal.throwIfAborted();

      if (!created) {
        throw new Error("Failed to create agent compose");
      }

      composeId = created.id;
    }

    let action: "created" | "existing";
    if (existingVersions.length > 0) {
      action = "existing";
    } else {
      await db.insert(agentComposeVersions).values({
        id: versionId,
        composeId,
        content: resolvedContent,
        createdBy: args.userId,
      });
      signal.throwIfAborted();
      action = "created";
    }

    const updatedAt = nowDate();
    await db
      .update(agentComposes)
      .set({
        headVersionId: versionId,
        updatedAt,
      })
      .where(eq(agentComposes.id, composeId));
    signal.throwIfAborted();

    return {
      status: isNewCompose ? 201 : 200,
      body: {
        composeId,
        name: normalizedAgentName,
        versionId,
        action,
        updatedAt: updatedAt.toISOString(),
      },
    };
  },
);
