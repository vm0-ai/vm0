import { command, computed } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { zeroAgentCustomConnectorsContract } from "@vm0/api-contracts/contracts/zero-agent-custom-connectors";
import {
  zeroAgentsByIdContract,
  zeroAgentsMainContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { orgCustomConnectors } from "@vm0/db/schema/org-custom-connector";
import { userCustomConnectors } from "@vm0/db/schema/user-custom-connector";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { notFound } from "../../lib/error";
import {
  zeroAgentDetail,
  zeroAgentEnabledConnectorTypes,
  zeroAgentEnabledCustomConnectorIds,
  zeroAgentExists,
  zeroAgentList,
} from "../services/zero-agent-data.service";
import type { RouteEntry } from "../route";

function agentNotFound(agentId: string) {
  return notFound(`Agent not found: ${agentId}`);
}

const listAgentsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const agents = await get(zeroAgentList(auth.orgId));
  return { status: 200 as const, body: [...agents] };
});

const getAgentInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroAgentsByIdContract.get));
  const agent = await get(
    zeroAgentDetail({ orgId: auth.orgId, agentId: params.id }),
  );
  if (!agent) {
    return agentNotFound(params.id);
  }
  return { status: 200 as const, body: agent };
});

const getAgentUserConnectorsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroUserConnectorsContract.get));
  const exists = await get(
    zeroAgentExists({ orgId: auth.orgId, agentId: params.id }),
  );
  if (!exists) {
    return agentNotFound(params.id);
  }

  const enabledTypes = await get(
    zeroAgentEnabledConnectorTypes({
      orgId: auth.orgId,
      userId: auth.userId,
      agentId: params.id,
    }),
  );
  return { status: 200 as const, body: { enabledTypes: [...enabledTypes] } };
});

const getAgentCustomConnectorsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroAgentCustomConnectorsContract.get));
  const exists = await get(
    zeroAgentExists({ orgId: auth.orgId, agentId: params.id }),
  );
  if (!exists) {
    return agentNotFound(params.id);
  }

  const enabledIds = await get(
    zeroAgentEnabledCustomConnectorIds({
      orgId: auth.orgId,
      userId: auth.userId,
      agentId: params.id,
    }),
  );
  return { status: 200 as const, body: { enabledIds: [...enabledIds] } };
});

const updateAgentCustomConnectorsBody$ = bodyResultOf(
  zeroAgentCustomConnectorsContract.update,
);

const updateAgentCustomConnectorsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(zeroAgentCustomConnectorsContract.update));
    const body = await get(updateAgentCustomConnectorsBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const exists = await get(
      zeroAgentExists({ orgId: auth.orgId, agentId: params.id }),
    );
    signal.throwIfAborted();
    if (!exists) {
      return agentNotFound(params.id);
    }

    const writeDb = set(writeDb$);
    const enabledIds = body.data.enabledIds;

    if (enabledIds.length > 0) {
      const found = await writeDb
        .select({ id: orgCustomConnectors.id })
        .from(orgCustomConnectors)
        .where(
          and(
            eq(orgCustomConnectors.orgId, auth.orgId),
            inArray(orgCustomConnectors.id, enabledIds),
          ),
        );
      signal.throwIfAborted();
      const foundSet = new Set(
        found.map((row) => {
          return row.id;
        }),
      );
      const missing = enabledIds.filter((id) => {
        return !foundSet.has(id);
      });
      if (missing.length > 0) {
        return {
          status: 400 as const,
          body: {
            error: {
              message: `Unknown custom connector ids: ${missing.join(", ")}`,
              code: "VALIDATION_ERROR",
            },
          },
        };
      }
    }

    await writeDb.transaction(async (tx) => {
      await tx
        .delete(userCustomConnectors)
        .where(
          and(
            eq(userCustomConnectors.orgId, auth.orgId),
            eq(userCustomConnectors.userId, auth.userId),
            eq(userCustomConnectors.agentId, params.id),
          ),
        );

      if (enabledIds.length > 0) {
        await tx.insert(userCustomConnectors).values(
          enabledIds.map((customConnectorId) => {
            return {
              orgId: auth.orgId,
              userId: auth.userId,
              agentId: params.id,
              customConnectorId,
            };
          }),
        );
      }
    });
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: { enabledIds: [...enabledIds] },
    };
  },
);

const agentReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:read",
} as const;

export const zeroAgentsRoutes: readonly RouteEntry[] = [
  {
    route: zeroAgentsMainContract.list,
    handler: authRoute(agentReadAuth, listAgentsInner$),
  },
  {
    route: zeroAgentsByIdContract.get,
    handler: authRoute(agentReadAuth, getAgentInner$),
  },
  {
    route: zeroUserConnectorsContract.get,
    handler: authRoute(agentReadAuth, getAgentUserConnectorsInner$),
  },
  {
    route: zeroAgentCustomConnectorsContract.get,
    handler: authRoute(agentReadAuth, getAgentCustomConnectorsInner$),
  },
  {
    route: zeroAgentCustomConnectorsContract.update,
    handler: authRoute(agentReadAuth, updateAgentCustomConnectorsInner$),
  },
];
