import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../src/lib/ts-rest-handler";
import {
  zeroAgentPermissionPoliciesContract,
  getConnectorFirewall,
  isFirewallConnectorType,
  fromFirewallPolicies,
  toFirewallPolicies,
  type FirewallPolicies,
} from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import { zeroAgents } from "../../../../src/db/schema/zero-agent";
import { eq, and } from "drizzle-orm";
import { requireAgentPermission } from "../../../../src/lib/zero/require-agent-permission";
import { logger } from "../../../../src/lib/shared/logger";

const log = logger("api:zero:permission-policies");

function validatePolicies(policies: FirewallPolicies): string | null {
  for (const [ref, policy] of Object.entries(policies)) {
    if (!isFirewallConnectorType(ref)) {
      return `Unknown connector ref: ${ref}`;
    }
    const config = getConnectorFirewall(ref);

    const validPermNames = new Set<string>();
    for (const api of config.apis) {
      if (api.permissions) {
        for (const p of api.permissions) {
          validPermNames.add(p.name);
        }
      }
    }

    for (const permName of Object.keys(policy.policies)) {
      if (!validPermNames.has(permName)) {
        return `Unknown permission "${permName}" for connector "${ref}"`;
      }
    }
  }
  return null;
}

const router = tsr.router(zeroAgentPermissionPoliciesContract, {
  update: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:write",
    });
    if (isAuthError(authCtx)) return authCtx;

    const { org, member } = await resolveOrg(authCtx);

    // Validate policies against builtin firewalls
    const validationError = validatePolicies(body.policies);
    if (validationError) {
      return {
        status: 400 as const,
        body: {
          error: {
            message: validationError,
            code: "VALIDATION_ERROR",
          },
        },
      };
    }

    // Verify agent exists — body.agentId is the composeId (= zeroAgents PK)
    const [existing] = await globalThis.services.db
      .select({ id: zeroAgents.id, owner: zeroAgents.owner })
      .from(zeroAgents)
      .where(
        and(eq(zeroAgents.orgId, org.orgId), eq(zeroAgents.id, body.agentId)),
      )
      .limit(1);

    if (!existing) {
      return {
        status: 404 as const,
        body: {
          error: {
            message: `Agent not found: ${body.agentId}`,
            code: "NOT_FOUND",
          },
        },
      };
    }

    const forbidden = requireAgentPermission(
      existing.owner,
      member,
      "update permission policies",
    );
    if (forbidden) return forbidden;

    // Update permission policies — split unified type back into two DB columns
    const now = new Date();
    const { permissionPolicies, unknownPermissionPolicies } =
      fromFirewallPolicies(body.policies);
    await globalThis.services.db
      .update(zeroAgents)
      .set({
        permissionPolicies,
        unknownPermissionPolicies,
        updatedAt: now,
      })
      .where(eq(zeroAgents.id, body.agentId));

    log.info(`Updated permission policies for agent: ${body.agentId}`);

    // Re-query to return actual persisted state
    const [agent] = await globalThis.services.db
      .select()
      .from(zeroAgents)
      .where(eq(zeroAgents.id, body.agentId))
      .limit(1);

    return {
      status: 200 as const,
      body: buildAgentResponse(body.agentId, agent, member.userId),
    };
  },
});

function buildAgentResponse(
  agentId: string,
  agent: typeof zeroAgents.$inferSelect | undefined,
  fallbackOwner: string,
) {
  return {
    agentId,
    ownerId: agent?.owner ?? fallbackOwner,
    description: agent?.description ?? null,
    displayName: agent?.displayName ?? null,
    sound: agent?.sound ?? null,
    avatarUrl: agent?.avatarUrl ?? null,
    permissionPolicies: toFirewallPolicies(
      agent?.permissionPolicies,
      agent?.unknownPermissionPolicies,
    ),
    customSkills: agent?.customSkills ?? [],
  };
}

const handler = createHandler(zeroAgentPermissionPoliciesContract, router, {
  errorHandler: createSafeErrorHandler("zero:permission-policies"),
});

export { handler as PUT };
