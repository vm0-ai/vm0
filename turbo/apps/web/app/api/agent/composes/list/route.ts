import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { composesListContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { agentComposes } from "../../../../../src/db/schema/agent-compose";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import { eq, desc } from "drizzle-orm";
import {
  resolveRequestScope,
  isScopeResolutionSuccess,
} from "../../../../../src/lib/scope/resolve-request-scope";

const router = tsr.router(composesListContract, {
  list: async ({ query, headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

    // Resolve scope: header takes precedence over query parameter
    const scopeSlug =
      "x-vm0-scope" in headers
        ? (headers["x-vm0-scope"] as string)
        : query.scope;
    const scopeResult = await resolveRequestScope(userId, scopeSlug);

    if (!isScopeResolutionSuccess(scopeResult)) {
      const statusCode =
        scopeResult.code === "FORBIDDEN"
          ? 403
          : scopeResult.code === "NOT_FOUND"
            ? 400
            : 400;
      return {
        status: statusCode as 400 | 403,
        body: {
          error: {
            message: scopeResult.error,
            code:
              scopeResult.code === "FORBIDDEN" ? "FORBIDDEN" : "BAD_REQUEST",
          },
        },
      };
    }

    const scopeId = scopeResult.scope.id;

    // Query all composes for this scope
    const composes = await globalThis.services.db
      .select({
        name: agentComposes.name,
        headVersionId: agentComposes.headVersionId,
        updatedAt: agentComposes.updatedAt,
      })
      .from(agentComposes)
      .where(eq(agentComposes.scopeId, scopeId))
      .orderBy(desc(agentComposes.updatedAt));

    return {
      status: 200 as const,
      body: {
        composes: composes.map((compose) => ({
          name: compose.name,
          headVersionId: compose.headVersionId,
          updatedAt: compose.updatedAt.toISOString(),
        })),
      },
    };
  },
});

const handler = createHandler(composesListContract, router);

export { handler as GET };
