import { createNextHandler, tsr } from "@ts-rest/serverless/next";
import { TsRestResponse } from "@ts-rest/serverless";
import { composesByIdContract } from "@vm0/core";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../../src/db/schema/agent-compose";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import type { AgentComposeYaml } from "../../../../../src/types/agent-compose";

const router = tsr.router(composesByIdContract, {
  getById: async ({ params }) => {
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

    const [compose] = await globalThis.services.db
      .select()
      .from(agentComposes)
      .where(eq(agentComposes.id, params.id))
      .limit(1);

    if (!compose) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent compose not found", code: "NOT_FOUND" },
        },
      };
    }

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
});

/**
 * Custom error handler to convert validation errors to API error format
 */
function errorHandler(err: unknown): TsRestResponse | void {
  if (err && typeof err === "object" && "pathParamsError" in err) {
    const validationError = err as {
      pathParamsError: {
        issues: Array<{ path: string[]; message: string }>;
      } | null;
    };

    if (validationError.pathParamsError) {
      const issue = validationError.pathParamsError.issues[0];
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

const handler = createNextHandler(composesByIdContract, router, {
  handlerType: "app-router",
  jsonQuery: true,
  errorHandler,
});

export { handler as GET };
