/**
 * Zero API - Log Detail Endpoint
 *
 * GET /api/zero/logs/:id - Get agent run log details
 */
import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../src/lib/ts-rest-handler";
import {
  logsByIdContract,
  type TriggerSource,
} from "@vm0/api-contracts/contracts/logs";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "@vm0/db/schema/agent-run";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { alias } from "drizzle-orm/pg-core";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { isNotFound, isForbidden } from "@vm0/api-services/errors";
import { extractFrameworkFromCompose } from "../../../../../src/lib/infra/framework/framework-config";
import { eq, and } from "drizzle-orm";

/** Alias for the zero_agents table to resolve the triggering agent's display name. */
const triggerAgentAlias = alias(zeroAgents, "trigger_agent");

interface RunResult {
  checkpointId?: string;
  agentSessionId?: string;
  conversationId?: string;
  artifact?: Record<string, string>; // { artifactName: version }
  volumes?: Record<string, string>;
}

type ComposeContent = Parameters<typeof extractFrameworkFromCompose>[0];

/**
 * Extract artifact name and version from run result.
 * The artifact map has structure { artifactName: version }
 */
function extractArtifact(runResult: RunResult | null): {
  name: string | null;
  version: string | null;
} {
  if (!runResult?.artifact) {
    return { name: null, version: null };
  }

  const name = Object.keys(runResult.artifact)[0] ?? null;
  const version = name ? (runResult.artifact[name] ?? null) : null;
  return { name, version };
}

/**
 * Create not found response
 */
function notFoundResponse() {
  return {
    status: 404 as const,
    body: {
      error: { message: "Log not found", code: "NOT_FOUND" },
    },
  };
}

/**
 * Build the response body from a query result row.
 */
function buildLogDetailBody(result: {
  run: typeof agentRuns.$inferSelect;
  compose: typeof agentComposes.$inferSelect | null;
  composeVersion: typeof agentComposeVersions.$inferSelect | null;
  agentDisplayName: string | null;
  triggerSource: string | null;
  scheduleId: string | null;
  triggerAgentName: string | null;
  modelProvider: string | null;
  selectedModel: string | null;
}) {
  const {
    run,
    compose,
    composeVersion,
    agentDisplayName,
    triggerSource,
    scheduleId,
    triggerAgentName,
    modelProvider,
    selectedModel,
  } = result;
  const runResult = run.result as RunResult | null;
  const composeContent = composeVersion?.content as ComposeContent | null;

  return {
    id: run.id,
    sessionId: runResult?.agentSessionId ?? null,
    agentId: compose?.id ?? null,
    displayName: agentDisplayName ?? null,
    framework: extractFrameworkFromCompose(composeContent),
    modelProvider: modelProvider ?? null,
    selectedModel: selectedModel ?? null,
    triggerSource: (triggerSource ?? "cli") as TriggerSource,
    triggerAgentName: triggerAgentName ?? null,
    scheduleId: scheduleId ?? null,
    status: run.status as
      | "pending"
      | "running"
      | "completed"
      | "failed"
      | "timeout"
      | "cancelled",
    prompt: run.prompt,
    appendSystemPrompt: run.appendSystemPrompt ?? null,
    error: run.error ?? null,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    artifact: extractArtifact(runResult),
  };
}

const router = tsr.router(logsByIdContract, {
  getById: async ({ params, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent-run:read",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    // Resolve active org from JWT / CLI token / default
    let orgId: string;
    try {
      const { org: resolvedOrg } = await resolveOrg(authCtx);
      orgId = resolvedOrg.orgId;
    } catch (error) {
      if (isNotFound(error) || isForbidden(error)) {
        return notFoundResponse();
      }
      throw error;
    }

    // Query run scoped to current user + active org
    const [result] = await globalThis.services.db
      .select({
        run: agentRuns,
        compose: agentComposes,
        composeVersion: agentComposeVersions,
        agentDisplayName: zeroAgents.displayName,
        triggerSource: zeroRuns.triggerSource,
        scheduleId: zeroRuns.scheduleId,
        triggerAgentName: triggerAgentAlias.displayName,
        modelProvider: zeroRuns.modelProvider,
        selectedModel: zeroRuns.selectedModel,
      })
      .from(agentRuns)
      .leftJoin(zeroRuns, eq(agentRuns.id, zeroRuns.id))
      .leftJoin(
        agentComposeVersions,
        eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
      )
      .leftJoin(
        agentComposes,
        eq(agentComposeVersions.composeId, agentComposes.id),
      )
      .leftJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
      .leftJoin(
        triggerAgentAlias,
        eq(zeroRuns.triggerAgentId, triggerAgentAlias.id),
      )
      .where(
        and(
          eq(agentRuns.id, params.id),
          eq(agentRuns.userId, userId),
          eq(agentRuns.orgId, orgId),
        ),
      )
      .limit(1);

    if (!result) {
      return notFoundResponse();
    }

    return { status: 200 as const, body: buildLogDetailBody(result) };
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
        const path = issue.path.join(".");
        const message = path ? `${path}: ${issue.message}` : issue.message;
        return TsRestResponse.fromJson(
          { error: { message, code: "BAD_REQUEST" } },
          { status: 400 },
        );
      }
    }
  }

  return undefined;
}

const handler = createHandler(logsByIdContract, router, {
  routeName: "zero.logs.byId",
  errorHandler,
});

export { handler as GET };
