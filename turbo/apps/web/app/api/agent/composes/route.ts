import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../src/lib/ts-rest-handler";
import {
  composesMainContract,
  AGENT_NAME_REGEX,
} from "@vm0/api-contracts/contracts/composes";
import {
  SUPPORTED_FRAMEWORKS,
  isSupportedFramework,
} from "@vm0/core/frameworks";
import { initServices } from "../../../../src/lib/init-services";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { eq, and } from "drizzle-orm";
import { computeComposeVersionId } from "../../../../src/lib/infra/agent-compose/content-hash";
import { getComposeByName } from "../../../../src/lib/infra/agent-compose/compose-service";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import {
  isNotFound,
  isForbidden,
  isBadRequest,
} from "../../../../src/lib/shared/errors";

const router = tsr.router(composesMainContract, {
  getByName: async ({ query, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      acceptAnySandboxCapability: true,
    });
    if (isAuthError(authCtx)) return authCtx;

    let orgId: string;
    try {
      const { org } = await resolveOrg(authCtx);
      orgId = org.orgId;
    } catch (error) {
      if (isNotFound(error) || isForbidden(error) || isBadRequest(error)) {
        return {
          status: 404 as const,
          body: {
            error: {
              message: `Agent compose not found: ${query.name}`,
              code: "NOT_FOUND",
            },
          },
        };
      }
      throw error;
    }

    const compose = await getComposeByName(orgId, query.name);
    if (!compose) {
      return {
        status: 404 as const,
        body: {
          error: {
            message: `Agent compose not found: ${query.name}`,
            code: "NOT_FOUND",
          },
        },
      };
    }

    return { status: 200 as const, body: compose };
  },

  create: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      acceptAnySandboxCapability: true,
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const { content } = body;

    // Validate agents is not array (Zod validates it's an object, but not that it's not an array)
    if (Array.isArray(content.agents)) {
      return {
        status: 400 as const,
        body: {
          error: {
            message:
              "agents must be an object, not an array. Use format: agents: { agent-name: { ... } }",
            code: "BAD_REQUEST",
          },
        },
      };
    }

    const agentKeys = Object.keys(content.agents);
    if (agentKeys.length === 0) {
      return {
        status: 400 as const,
        body: {
          error: {
            message: "agents must have at least one agent defined",
            code: "BAD_REQUEST",
          },
        },
      };
    }

    if (agentKeys.length > 1) {
      return {
        status: 400 as const,
        body: {
          error: {
            message:
              "Multiple agents not supported yet. Only one agent allowed.",
            code: "BAD_REQUEST",
          },
        },
      };
    }

    // Get agent name from key
    const agentName = agentKeys[0];
    if (!agentName) {
      return {
        status: 400 as const,
        body: {
          error: {
            message: "agents must have at least one agent defined",
            code: "BAD_REQUEST",
          },
        },
      };
    }

    // Validate name format: 3-64 chars, alphanumeric and hyphens, start/end with alphanumeric
    if (!AGENT_NAME_REGEX.test(agentName)) {
      return {
        status: 400 as const,
        body: {
          error: {
            message:
              "Invalid agent name format. Must be 3-64 characters, letters, numbers, and hyphens only. Must start and end with letter or number.",
            code: "BAD_REQUEST",
          },
        },
      };
    }

    // Normalize agent name to lowercase for consistent storage
    const normalizedAgentName = agentName.toLowerCase();

    // Get agent configuration
    const agent = content.agents[agentName];

    // Validate framework is supported
    const framework = agent?.framework;
    if (!framework || !isSupportedFramework(framework)) {
      return {
        status: 400 as const,
        body: {
          error: {
            message: `Unsupported framework: "${framework}". Supported frameworks: ${SUPPORTED_FRAMEWORKS.join(", ")}`,
            code: "BAD_REQUEST",
          },
        },
      };
    }

    // Strip deprecated `skills` field — CLI path no longer processes it,
    // and stored rows must not carry it going forward.
    const { skills: _deprecatedSkills, ...agentWithoutSkills } = agent;

    // Build resolved content with normalized agent name
    const resolvedContent = {
      ...content,
      agents: {
        [normalizedAgentName]: agentWithoutSkills,
      },
    };

    // Compute content-addressable version ID from resolved content
    const versionId = computeComposeVersionId(resolvedContent);

    // Get user's org (required for compose creation)
    const { org } = await resolveOrg(authCtx);

    // Check compose and version existence in parallel
    const [existingComposes, existingVersions] = await Promise.all([
      globalThis.services.db
        .select()
        .from(agentComposes)
        .where(
          and(
            eq(agentComposes.orgId, org.orgId),
            eq(agentComposes.name, normalizedAgentName),
          ),
        )
        .limit(1),
      globalThis.services.db
        .select()
        .from(agentComposeVersions)
        .where(eq(agentComposeVersions.id, versionId))
        .limit(1),
    ]);

    const existing = existingComposes[0];
    const existingVersion = existingVersions;

    let composeId: string;
    let isNewCompose = false;

    if (existing) {
      composeId = existing.id;
    } else {
      // Create new compose metadata
      const [created] = await globalThis.services.db
        .insert(agentComposes)
        .values({
          userId,
          name: normalizedAgentName,
          orgId: org.orgId,
        })
        .returning({ id: agentComposes.id });

      if (!created) {
        throw new Error("Failed to create agent compose");
      }

      composeId = created.id;
      isNewCompose = true;
    }

    let action: "created" | "existing";

    if (existingVersion.length > 0) {
      action = "existing";
    } else {
      // Create new version with resolved content
      await globalThis.services.db.insert(agentComposeVersions).values({
        id: versionId,
        composeId,
        content: resolvedContent,
        createdBy: userId,
      });

      action = "created";
    }

    // Update HEAD pointer to new version
    await globalThis.services.db
      .update(agentComposes)
      .set({
        headVersionId: versionId,
        updatedAt: new Date(),
      })
      .where(eq(agentComposes.id, composeId));

    const updatedAt = new Date().toISOString();

    if (isNewCompose) {
      return {
        status: 201 as const,
        body: {
          composeId,
          name: normalizedAgentName,
          versionId,
          action: action as "created" | "existing",
          updatedAt,
        },
      };
    }

    return {
      status: 200 as const,
      body: {
        composeId,
        name: normalizedAgentName,
        versionId,
        action: action as "created" | "existing",
        updatedAt,
      },
    };
  },
});

/**
 * Custom error handler to convert Zod validation errors to API error format
 */
function errorHandler(err: unknown): TsRestResponse | void {
  // Handle ts-rest RequestValidationError
  if (
    err &&
    typeof err === "object" &&
    "bodyError" in err &&
    "queryError" in err
  ) {
    const validationError = err as {
      bodyError: { issues: Array<{ path: string[]; message: string }> } | null;
      queryError: { issues: Array<{ path: string[]; message: string }> } | null;
    };

    // Handle body validation errors
    if (validationError.bodyError) {
      const issue = validationError.bodyError.issues[0];
      if (issue) {
        return TsRestResponse.fromJson(
          { error: { message: issue.message, code: "BAD_REQUEST" } },
          { status: 400 },
        );
      }
    }

    // Handle query validation errors
    if (validationError.queryError) {
      const issue = validationError.queryError.issues[0];
      if (issue) {
        return TsRestResponse.fromJson(
          { error: { message: issue.message, code: "BAD_REQUEST" } },
          { status: 400 },
        );
      }
    }
  }

  return undefined;
}

const handler = createHandler(composesMainContract, router, {
  routeName: "agent.composes",
  errorHandler,
});

export { handler as GET, handler as POST };
