import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../src/lib/ts-rest-handler";
import { composesMainContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../src/db/schema/agent-compose";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { eq, and } from "drizzle-orm";
import { computeComposeVersionId } from "../../../../src/lib/agent-compose/content-hash";
import { assertImageAccess } from "../../../../src/lib/image/image-service";
import {
  getUserScopeByClerkId,
  getScopeBySlug,
} from "../../../../src/lib/scope/scope-service";
import type { AgentComposeYaml } from "../../../../src/types/agent-compose";

const router = tsr.router(composesMainContract, {
  getByName: async ({ query }) => {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

    // Resolve scope: use provided scope or fall back to user's default scope
    let scopeId: string;
    if (query.scope) {
      const scope = await getScopeBySlug(query.scope);
      if (!scope) {
        return {
          status: 400 as const,
          body: {
            error: {
              message: `Scope not found: ${query.scope}`,
              code: "BAD_REQUEST",
            },
          },
        };
      }
      scopeId = scope.id;
    } else {
      const userScope = await getUserScopeByClerkId(userId);
      if (!userScope) {
        return {
          status: 403 as const,
          body: {
            error: {
              message:
                "Please set up your scope first. Login again with: vm0 login",
              code: "SCOPE_NOT_CONFIGURED",
            },
          },
        };
      }
      scopeId = userScope.id;
    }

    const composes = await globalThis.services.db
      .select()
      .from(agentComposes)
      .where(
        and(
          eq(agentComposes.scopeId, scopeId),
          eq(agentComposes.name, query.name),
        ),
      )
      .limit(1);

    if (composes.length === 0 || !composes[0]) {
      return {
        status: 400 as const,
        body: {
          error: {
            message: `Agent compose not found: ${query.name}`,
            code: "BAD_REQUEST",
          },
        },
      };
    }

    const compose = composes[0];

    // Get HEAD version content if available
    let content: AgentComposeYaml | null = null;
    if (compose.headVersionId) {
      const versions = await globalThis.services.db
        .select()
        .from(agentComposeVersions)
        .where(eq(agentComposeVersions.id, compose.headVersionId))
        .limit(1);

      if (versions.length > 0 && versions[0]) {
        content = versions[0].content as AgentComposeYaml;
      }
    }

    return {
      status: 200 as const,
      body: {
        id: compose.id,
        name: compose.name,
        headVersionId: compose.headVersionId,
        content,
        createdAt: compose.createdAt.toISOString(),
        updatedAt: compose.updatedAt.toISOString(),
      },
    };
  },

  create: async ({ body }) => {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

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
    const nameRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,62}[a-zA-Z0-9]$/;
    if (!nameRegex.test(agentName)) {
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

    // Validate image access
    const agent = content.agents[agentName];
    if (agent?.image) {
      try {
        await assertImageAccess(userId, agent.image);
      } catch (error) {
        return {
          status: 400 as const,
          body: {
            error: {
              message:
                error instanceof Error ? error.message : "Image access denied",
              code: "BAD_REQUEST",
            },
          },
        };
      }
    }

    // Compute content-addressable version ID
    const versionId = computeComposeVersionId(content);

    // Get user's scope (required for compose creation)
    const userScope = await getUserScopeByClerkId(userId);
    if (!userScope) {
      return {
        status: 403 as const,
        body: {
          error: {
            message:
              "Please set up your scope first. Login again with: vm0 login",
            code: "SCOPE_NOT_CONFIGURED",
          },
        },
      };
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
    let isNewCompose = false;

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
      isNewCompose = true;
    }

    // Check if this exact version already exists
    const existingVersion = await globalThis.services.db
      .select()
      .from(agentComposeVersions)
      .where(eq(agentComposeVersions.id, versionId))
      .limit(1);

    let action: "created" | "existing";

    if (existingVersion.length > 0) {
      action = "existing";
    } else {
      // Create new version
      await globalThis.services.db.insert(agentComposeVersions).values({
        id: versionId,
        composeId,
        content,
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
  errorHandler,
});

export { handler as GET, handler as POST };
