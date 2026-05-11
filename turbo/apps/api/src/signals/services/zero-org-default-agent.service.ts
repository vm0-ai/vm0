import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { zeroAgents } from "@vm0/db/schema/zero-agent";

import { conflict, notFound } from "../../lib/error";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";

interface SetDefaultAgentArgs {
  readonly orgId: string;
  readonly agentId: string | null;
}

type SetDefaultAgentResult =
  | { readonly kind: "ok"; readonly agentId: string | null }
  | ReturnType<typeof notFound>
  | ReturnType<typeof conflict>;

export const setOrgDefaultAgent$ = command(
  async (
    { set },
    args: SetDefaultAgentArgs,
    signal: AbortSignal,
  ): Promise<SetDefaultAgentResult> => {
    const db = set(writeDb$);

    const [orgRow] = await db
      .select({ defaultAgentId: orgMetadata.defaultAgentId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);
    signal.throwIfAborted();

    const existingAgentId = orgRow?.defaultAgentId ?? null;

    if (existingAgentId) {
      const [existing] = await db
        .select({ id: zeroAgents.id })
        .from(zeroAgents)
        .where(
          and(
            eq(zeroAgents.id, existingAgentId),
            eq(zeroAgents.orgId, args.orgId),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (existing) {
        return conflict("A default agent is already configured for this org");
      }
    }

    if (args.agentId !== null) {
      const [agent] = await db
        .select({ id: zeroAgents.id })
        .from(zeroAgents)
        .where(
          and(
            eq(zeroAgents.id, args.agentId),
            eq(zeroAgents.orgId, args.orgId),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (!agent) {
        return notFound("Agent not found in this org");
      }
    }

    await db
      .insert(orgMetadata)
      .values({ orgId: args.orgId, defaultAgentId: args.agentId })
      .onConflictDoUpdate({
        target: orgMetadata.orgId,
        set: { defaultAgentId: args.agentId, updatedAt: nowDate() },
      });
    signal.throwIfAborted();

    return { kind: "ok", agentId: args.agentId };
  },
);
