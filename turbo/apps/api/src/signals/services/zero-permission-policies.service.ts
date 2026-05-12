import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import {
  fromFirewallPolicies,
  type FirewallPolicies,
} from "@vm0/connectors/firewall-types";
import type { ZeroAgentResponse } from "@vm0/api-contracts/contracts/zero-agents";
import { zeroAgents } from "@vm0/db/schema/zero-agent";

import { notFound } from "../../lib/error";
import { requireAgentPermission } from "../../lib/require-agent-permission";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { agentResponse } from "./zero-agent-data.service";

interface UpdatePermissionPoliciesArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly role: string;
  readonly agentId: string;
  readonly policies: FirewallPolicies;
}

type ForbiddenResponse = NonNullable<ReturnType<typeof requireAgentPermission>>;

type UpdateResult =
  | { readonly kind: "ok"; readonly agent: ZeroAgentResponse }
  | ReturnType<typeof notFound>
  | ForbiddenResponse;

export const updateAgentPermissionPolicies$ = command(
  async (
    { set },
    args: UpdatePermissionPoliciesArgs,
    signal: AbortSignal,
  ): Promise<UpdateResult> => {
    const db = set(writeDb$);

    const [existing] = await db
      .select({
        id: zeroAgents.id,
        owner: zeroAgents.owner,
        visibility: zeroAgents.visibility,
      })
      .from(zeroAgents)
      .where(
        and(eq(zeroAgents.orgId, args.orgId), eq(zeroAgents.id, args.agentId)),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!existing) {
      return notFound(`Agent not found: ${args.agentId}`);
    }

    const forbidden = requireAgentPermission(
      existing.owner,
      { userId: args.userId, role: args.role },
      "update permission policies",
      { visibility: existing.visibility },
    );
    if (forbidden) {
      return forbidden;
    }

    const { permissionPolicies, unknownPermissionPolicies } =
      fromFirewallPolicies(args.policies);

    await db
      .update(zeroAgents)
      .set({
        permissionPolicies,
        unknownPermissionPolicies,
        updatedAt: nowDate(),
      })
      .where(eq(zeroAgents.id, args.agentId));
    signal.throwIfAborted();

    const [row] = await db
      .select({
        agentId: zeroAgents.id,
        owner: zeroAgents.owner,
        displayName: zeroAgents.displayName,
        description: zeroAgents.description,
        sound: zeroAgents.sound,
        avatarUrl: zeroAgents.avatarUrl,
        permissionPolicies: zeroAgents.permissionPolicies,
        unknownPermissionPolicies: zeroAgents.unknownPermissionPolicies,
        customSkills: zeroAgents.customSkills,
        modelProviderId: zeroAgents.modelProviderId,
        selectedModel: zeroAgents.selectedModel,
        preferPersonalProvider: zeroAgents.preferPersonalProvider,
        visibility: zeroAgents.visibility,
      })
      .from(zeroAgents)
      .where(eq(zeroAgents.id, args.agentId))
      .limit(1);
    signal.throwIfAborted();

    if (!row) {
      return notFound(`Agent not found: ${args.agentId}`);
    }

    return { kind: "ok", agent: agentResponse(row) };
  },
);
