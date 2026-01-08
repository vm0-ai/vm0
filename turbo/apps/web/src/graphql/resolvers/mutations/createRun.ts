import { eq } from "drizzle-orm";
import { builder } from "../../builder";
import {
  CreateRunInput,
  CreateRunPayload,
  type CreateRunPayloadShape,
} from "../../types/payloads";
import type { RunShape } from "../../types/run";
import { agentRuns } from "../../../db/schema/agent-run";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../db/schema/agent-compose";
import type { RunStatusType } from "../../types/enums";

/**
 * Mutation: createRun(input: CreateRunInput!)
 * Create a new agent run (simplified spike version)
 *
 * Note: This is a simplified implementation for the spike.
 * Full implementation would integrate with runService for sandbox execution.
 */
builder.mutationField("createRun", (t) =>
  t.field({
    type: CreateRunPayload,
    authScopes: { authenticated: true },
    args: {
      input: t.arg({ type: CreateRunInput, required: true }),
    },
    resolve: async (_parent, args, context): Promise<CreateRunPayloadShape> => {
      const { agentId, prompt, vars } = args.input;

      // Look up the agent compose
      const [compose] = await context.db
        .select()
        .from(agentComposes)
        .where(eq(agentComposes.id, String(agentId)))
        .limit(1);

      if (!compose) {
        return {
          run: null,
          errors: ["Agent not found"],
        };
      }

      // Verify user owns the agent
      if (compose.userId !== context.userId) {
        return {
          run: null,
          errors: ["Not authorized to use this agent"],
        };
      }

      if (!compose.headVersionId) {
        return {
          run: null,
          errors: ["Agent has no versions. Run 'vm0 build' first."],
        };
      }

      // Verify version exists
      const [version] = await context.db
        .select()
        .from(agentComposeVersions)
        .where(eq(agentComposeVersions.id, compose.headVersionId))
        .limit(1);

      if (!version) {
        return {
          run: null,
          errors: ["Agent version not found"],
        };
      }

      // Create run record (pending status - sandbox execution not included in spike)
      const [run] = await context.db
        .insert(agentRuns)
        .values({
          userId: context.userId!,
          agentComposeVersionId: compose.headVersionId,
          status: "pending",
          prompt,
          vars: vars as Record<string, string> | null,
        })
        .returning();

      if (!run) {
        return {
          run: null,
          errors: ["Failed to create run"],
        };
      }

      const runShape: RunShape = {
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

      return {
        run: runShape,
        errors: [],
      };
    },
  }),
);
