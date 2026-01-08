import { eq, and } from "drizzle-orm";
import { builder } from "../../builder";
import { RunType, type RunShape } from "../../types/run";
import { agentRuns } from "../../../db/schema/agent-run";
import type { RunStatusType } from "../../types/enums";

/**
 * Query: run(id: ID!)
 * Fetch a run by ID (requires authentication, user must own the run)
 */
builder.queryField("run", (t) =>
  t.field({
    type: RunType,
    nullable: true,
    authScopes: { authenticated: true },
    args: {
      id: t.arg.id({ required: true, description: "Run ID" }),
    },
    resolve: async (_parent, args, context): Promise<RunShape | null> => {
      const [run] = await context.db
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, String(args.id)),
            eq(agentRuns.userId, context.userId!),
          ),
        )
        .limit(1);

      if (!run) {
        return null;
      }

      return {
        id: run.id,
        agentComposeVersionId: run.agentComposeVersionId,
        status: run.status as RunStatusType,
        prompt: run.prompt,
        vars: run.vars as Record<string, string> | null,
        sandboxId: run.sandboxId,
        result: run.result,
        error: run.error,
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
      };
    },
  }),
);
