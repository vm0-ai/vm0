/**
 * Compose service for creating agent composes from YAML content
 */
import { isSupportedFramework, SUPPORTED_FRAMEWORKS } from "@vm0/core";
import type { AgentComposeYaml } from "../../types/agent-compose";
import {
  resolveFrameworkImage,
  resolveFrameworkWorkingDir,
} from "../framework/framework-config";
import {
  agentComposes,
  agentComposeVersions,
} from "../../db/schema/agent-compose";
import { eq, and } from "drizzle-orm";
import { computeComposeVersionId } from "../agent-compose/content-hash";
import { getUserScopeByClerkId } from "../scope/scope-service";

interface CreateComposeResult {
  composeId: string;
  composeName: string;
  versionId: string;
  warnings?: string[];
}

/**
 * Create or update an agent compose from parsed YAML content
 *
 * @param userId - Clerk user ID
 * @param content - Parsed YAML content
 * @param overwrite - Whether to overwrite existing compose (not used yet)
 * @returns Compose creation result
 */
export async function createComposeFromYaml(
  userId: string,
  content: Record<string, unknown>,
  _overwrite: boolean,
): Promise<CreateComposeResult> {
  void _overwrite; // Reserved for future overwrite behavior

  // Validate basic structure
  const typedContent = content as unknown as AgentComposeYaml;

  if (!typedContent.agents || typeof typedContent.agents !== "object") {
    throw new Error("Invalid compose: 'agents' field is required");
  }

  // Validate agents is not array
  if (Array.isArray(typedContent.agents)) {
    throw new Error(
      "agents must be an object, not an array. Use format: agents: { agent-name: { ... } }",
    );
  }

  const agentKeys = Object.keys(typedContent.agents);
  if (agentKeys.length === 0) {
    throw new Error("agents must have at least one agent defined");
  }

  if (agentKeys.length > 1) {
    throw new Error(
      "Multiple agents not supported yet. Only one agent allowed.",
    );
  }

  // Get agent name from key
  const agentName = agentKeys[0];
  if (!agentName) {
    throw new Error("agents must have at least one agent defined");
  }

  // Validate name format: 3-64 chars, alphanumeric and hyphens, start/end with alphanumeric
  const nameRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,62}[a-zA-Z0-9]$/;
  if (!nameRegex.test(agentName)) {
    throw new Error(
      "Invalid agent name format. Must be 3-64 characters, letters, numbers, and hyphens only. Must start and end with letter or number.",
    );
  }

  // Normalize agent name to lowercase for consistent storage
  const normalizedAgentName = agentName.toLowerCase();

  // Get agent configuration
  const agent = typedContent.agents[agentName];

  // Validate framework is supported
  const framework = agent?.framework;
  if (!framework || !isSupportedFramework(framework)) {
    throw new Error(
      `Unsupported framework: "${framework}". Supported frameworks: ${SUPPORTED_FRAMEWORKS.join(", ")}`,
    );
  }

  // Resolve image and working_dir server-side based on framework
  const resolvedImage = resolveFrameworkImage(framework, agent?.apps);
  const resolvedWorkingDir = resolveFrameworkWorkingDir(framework);

  // Build resolved content with server-determined image and working_dir
  const resolvedContent = {
    ...typedContent,
    agents: {
      [normalizedAgentName]: {
        ...agent,
        image: resolvedImage,
        working_dir: resolvedWorkingDir,
      },
    },
  };

  // Compute content-addressable version ID from resolved content
  const versionId = computeComposeVersionId(
    resolvedContent as unknown as AgentComposeYaml,
  );

  // Get user's scope (required for compose creation)
  const userScope = await getUserScopeByClerkId(userId);
  if (!userScope) {
    throw new Error(
      "Please set up your scope first. Login again with: vm0 login",
    );
  }

  // Check if compose exists for this scope + name
  const existing = await globalThis.services.db
    .select()
    .from(agentComposes)
    .where(
      and(
        eq(agentComposes.scopeId, userScope.id),
        eq(agentComposes.name, normalizedAgentName),
      ),
    )
    .limit(1);

  let composeId: string;

  if (existing.length > 0 && existing[0]) {
    composeId = existing[0].id;
  } else {
    // Create new compose metadata
    const [created] = await globalThis.services.db
      .insert(agentComposes)
      .values({
        userId,
        scopeId: userScope.id,
        name: normalizedAgentName,
      })
      .returning({ id: agentComposes.id });

    if (!created) {
      throw new Error("Failed to create agent compose");
    }

    composeId = created.id;
  }

  // Check if this exact version already exists
  const existingVersion = await globalThis.services.db
    .select()
    .from(agentComposeVersions)
    .where(eq(agentComposeVersions.id, versionId))
    .limit(1);

  if (existingVersion.length === 0) {
    // Create new version with resolved content
    await globalThis.services.db.insert(agentComposeVersions).values({
      id: versionId,
      composeId,
      content: resolvedContent,
      createdBy: userId,
    });
  }

  // Update HEAD pointer to new version
  await globalThis.services.db
    .update(agentComposes)
    .set({
      headVersionId: versionId,
      updatedAt: new Date(),
    })
    .where(eq(agentComposes.id, composeId));

  return {
    composeId,
    composeName: normalizedAgentName,
    versionId,
    warnings: [],
  };
}
