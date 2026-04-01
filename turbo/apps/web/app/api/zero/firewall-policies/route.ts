import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../src/lib/ts-rest-handler";
import {
  zeroAgentFirewallPoliciesContract,
  getConnectorFirewall,
  isFirewallConnectorType,
  type FirewallPolicies,
} from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/org/resolve-org";
import { zeroAgents } from "../../../../src/db/schema/zero-agent";
import { eq, and } from "drizzle-orm";
import { logger } from "../../../../src/lib/logger";

const log = logger("api:zero:firewall-policies");

function validatePolicies(policies: FirewallPolicies): string | null {
  for (const [ref, permissions] of Object.entries(policies)) {
    if (!isFirewallConnectorType(ref)) {
      return `Unknown firewall ref: ${ref}`;
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

    for (const permName of Object.keys(permissions)) {
      if (!validPermNames.has(permName)) {
        return `Unknown permission "${permName}" for firewall "${ref}"`;
      }
    }
  }
  return null;
}

const router = tsr.router(zeroAgentFirewallPoliciesContract, {
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

    if (existing.owner !== member.userId) {
      return {
        status: 403 as const,
        body: {
          error: {
            message: "Only the agent owner can update firewall policies",
            code: "FORBIDDEN",
          },
        },
      };
    }

    // Update firewall policies
    const now = new Date();
    await globalThis.services.db
      .update(zeroAgents)
      .set({
        firewallPolicies: body.policies,
        updatedAt: now,
      })
      .where(eq(zeroAgents.id, body.agentId));

    log.info(`Updated firewall policies for agent: ${body.agentId}`);

    // Re-query to return actual persisted state
    const [agent] = await globalThis.services.db
      .select()
      .from(zeroAgents)
      .where(eq(zeroAgents.id, body.agentId))
      .limit(1);

    return {
      status: 200 as const,
      body: {
        agentId: body.agentId,
        ownerId: agent?.owner ?? member.userId,
        description: agent?.description ?? null,
        displayName: agent?.displayName ?? null,
        sound: agent?.sound ?? null,
        avatarUrl: agent?.avatarUrl ?? null,
        firewallPolicies: agent?.firewallPolicies ?? null,
        customSkills: agent?.customSkills ?? [],
      },
    };
  },
});

const handler = createHandler(zeroAgentFirewallPoliciesContract, router, {
  errorHandler: createSafeErrorHandler("zero:firewall-policies"),
});

export { handler as PUT };
