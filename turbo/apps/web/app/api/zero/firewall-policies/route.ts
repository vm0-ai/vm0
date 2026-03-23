import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../src/lib/ts-rest-handler";
import {
  zeroAgentFirewallPoliciesContract,
  builtinFirewalls,
  type FirewallPolicies,
} from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/org/resolve-org";
import { zeroAgents } from "../../../../src/db/schema/zero-agent";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../src/db/schema/agent-compose";
import { eq, and } from "drizzle-orm";
import { extractConnectors } from "../../../../src/lib/zero/build-compose-content";
import { logger } from "../../../../src/lib/logger";

const log = logger("api:zero:firewall-policies");

function validatePolicies(policies: FirewallPolicies): string | null {
  for (const [ref, permissions] of Object.entries(policies)) {
    const config = builtinFirewalls[ref];
    if (!config) {
      return `Unknown firewall ref: ${ref}`;
    }

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
  update: async ({ body, headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:write",
    });
    if (isAuthError(authCtx)) return authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org, member } = await resolveOrg(authCtx, orgSlug);

    if (member.role !== "admin") {
      return {
        status: 403 as const,
        body: {
          error: {
            message: "Only org admins can update firewall policies",
            code: "FORBIDDEN",
          },
        },
      };
    }

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

    // Verify agent exists
    const [compose] = await globalThis.services.db
      .select({
        id: agentComposes.id,
        name: agentComposes.name,
        content: agentComposeVersions.content,
      })
      .from(agentComposes)
      .leftJoin(
        agentComposeVersions,
        eq(agentComposes.headVersionId, agentComposeVersions.id),
      )
      .where(
        and(
          eq(agentComposes.orgId, org.orgId),
          eq(agentComposes.name, body.name),
        ),
      )
      .limit(1);

    if (!compose) {
      return {
        status: 404 as const,
        body: {
          error: {
            message: `Agent not found: ${body.name}`,
            code: "NOT_FOUND",
          },
        },
      };
    }

    // Upsert firewall policies
    const now = new Date();
    await globalThis.services.db
      .insert(zeroAgents)
      .values({
        orgId: org.orgId,
        name: body.name,
        firewallPolicies: body.policies,
      })
      .onConflictDoUpdate({
        target: [zeroAgents.orgId, zeroAgents.name],
        set: {
          firewallPolicies: body.policies,
          updatedAt: now,
        },
      });

    log.info(`Updated firewall policies for agent: ${body.name}`);

    // Re-query to return actual persisted state
    const [agent] = await globalThis.services.db
      .select()
      .from(zeroAgents)
      .where(
        and(eq(zeroAgents.orgId, org.orgId), eq(zeroAgents.name, body.name)),
      )
      .limit(1);

    const content = (compose.content ?? {}) as Record<string, unknown>;
    const connectors = extractConnectors(content);

    return {
      status: 200 as const,
      body: {
        name: compose.name,
        agentComposeId: compose.id,
        description: agent?.description ?? null,
        displayName: agent?.displayName ?? null,
        sound: agent?.sound ?? null,
        connectors,
        firewallPolicies: agent?.firewallPolicies ?? null,
      },
    };
  },
});

const handler = createHandler(zeroAgentFirewallPoliciesContract, router, {
  errorHandler: createSafeErrorHandler("zero:firewall-policies"),
});

export { handler as PUT };
