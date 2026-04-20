import { eq, and } from "drizzle-orm";
import {
  AGENT_NAME_REGEX,
  isSupportedFramework,
  type SupportedFramework,
} from "@vm0/core";
import type { AgentComposeYaml } from "../agent-compose/types";
import { uploadInstructionsServerSide } from "../storage/instruction-upload";
import { computeComposeVersionId } from "../agent-compose/content-hash";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../db/schema/agent-compose";
import { logger } from "../../shared/logger";

const log = logger("compose:server-side");

interface AgentConfig {
  agentName: string;
  normalizedName: string;
  framework: SupportedFramework;
  agent: Record<string, unknown>;
}

/**
 * Validate content and extract agent configuration.
 * Throws on invalid content (these are content errors, not fallback scenarios).
 */
function extractAgentConfig(content: Record<string, unknown>): AgentConfig {
  const agents = content.agents;
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) {
    throw new Error(
      "agents must be an object, not an array. Use format: agents: { agent-name: { ... } }",
    );
  }

  const agentKeys = Object.keys(agents as Record<string, unknown>);
  if (agentKeys.length !== 1) {
    throw new Error(
      agentKeys.length === 0
        ? "agents must have at least one agent defined"
        : "Multiple agents not supported yet. Only one agent allowed.",
    );
  }

  const agentName = agentKeys[0]!;
  if (!AGENT_NAME_REGEX.test(agentName)) {
    throw new Error(
      "Invalid agent name format. Must be 3-64 characters, letters, numbers, and hyphens only.",
    );
  }

  const agent = (agents as Record<string, Record<string, unknown>>)[agentName]!;
  const framework = agent.framework as string | undefined;
  if (!framework || !isSupportedFramework(framework)) {
    throw new Error(`Unsupported framework: "${framework}"`);
  }

  return {
    agentName,
    normalizedName: agentName.toLowerCase(),
    framework,
    agent,
  };
}

/**
 * Upsert compose and version records.
 * Returns the composeId.
 */
async function upsertComposeRecord(params: {
  userId: string;
  orgId: string;
  normalizedName: string;
  resolvedContent: AgentComposeYaml;
  versionId: string;
}): Promise<string> {
  const { userId, orgId, normalizedName, resolvedContent, versionId } = params;
  const db = globalThis.services.db;

  const [existingComposes, existingVersions] = await Promise.all([
    db
      .select()
      .from(agentComposes)
      .where(
        and(
          eq(agentComposes.orgId, orgId),
          eq(agentComposes.name, normalizedName),
        ),
      )
      .limit(1),
    db
      .select()
      .from(agentComposeVersions)
      .where(eq(agentComposeVersions.id, versionId))
      .limit(1),
  ]);

  let composeId: string;
  const existing = existingComposes[0];

  if (existing) {
    composeId = existing.id;
  } else {
    const [created] = await db
      .insert(agentComposes)
      .values({ userId, name: normalizedName, orgId })
      .returning({ id: agentComposes.id });

    if (!created) {
      throw new Error("Failed to create agent compose");
    }
    composeId = created.id;
  }

  if (existingVersions.length === 0) {
    await db.insert(agentComposeVersions).values({
      id: versionId,
      composeId,
      content: resolvedContent,
      createdBy: userId,
    });
  }

  await db
    .update(agentComposes)
    .set({ headVersionId: versionId, updatedAt: new Date() })
    .where(eq(agentComposes.id, composeId));

  return composeId;
}

/**
 * Attempt server-side compose for platform mode.
 *
 * Validates agent config, uploads instructions, and creates the compose
 * record — all server-side.
 *
 * @returns Compose result if successful, or `null` if the server-side path
 *          is not possible and the caller should fall back to the sandbox.
 */
export async function serverSideCompose(params: {
  userId: string;
  orgId: string;
  content: Record<string, unknown>;
  instructions?: string;
}): Promise<{
  composeId: string;
  composeName: string;
  versionId: string;
} | null> {
  const { userId, orgId, content, instructions } = params;

  // 1. Validate and extract agent config
  const { agentName, normalizedName, framework, agent } =
    extractAgentConfig(content);

  // 2. Use environment as-is (connector env vars already injected by buildComposeContent)
  const environment: Record<string, string> = {
    ...((agent.environment ?? {}) as Record<string, string>),
  };

  // 3. Build resolved content with normalized agent name
  const agentsCopy = content.agents as Record<string, Record<string, unknown>>;
  const agentDef = { ...agentsCopy[agentName]! };
  const resolvedContent = {
    ...content,
    version: content.version as string,
    agents: {
      [normalizedName]: {
        ...agentDef,
        environment,
      },
    },
  } as AgentComposeYaml;

  // 4. Upload instructions if provided
  if (instructions !== undefined) {
    await uploadInstructionsServerSide({
      orgId,
      agentName: normalizedName,
      content: instructions,
      framework,
    });
  }

  // 5. Create compose record
  const versionId = computeComposeVersionId(resolvedContent);
  const composeId = await upsertComposeRecord({
    userId,
    orgId,
    normalizedName,
    resolvedContent,
    versionId,
  });

  log.info(
    `Server-side compose completed: ${normalizedName} (${versionId.slice(0, 8)})`,
  );

  return { composeId, composeName: normalizedName, versionId };
}
