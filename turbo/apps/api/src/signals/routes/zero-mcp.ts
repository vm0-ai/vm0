import { command, computed } from "ccstate";
import {
  zeroAgentMcpGrantsContract,
  zeroMcpServerByRefContract,
  zeroMcpServersContract,
} from "@vm0/api-contracts/contracts/zero-mcp";

import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { requireAdminPermission } from "../../lib/require-agent-permission";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import {
  createMcpServer,
  deleteMcpServer,
  listMcpServers,
  readMcpAgentGrants,
  replaceMcpAgentGrants,
  updateMcpServer,
} from "../services/zero-mcp.service";
import type { RouteEntry } from "../route-entry";

const managementAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  accept: ["session", "pat"],
} as const;

function adminRequired(
  auth: {
    readonly userId: string;
    readonly orgRole?: "admin" | "member";
  },
  action: string,
) {
  return requireAdminPermission(
    { role: auth.orgRole ?? "member" },
    `${action} MCP servers`,
  );
}

function agentNotFound(agentId: string) {
  return notFound(`Agent not found: ${agentId}`);
}

const listServersInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const servers = await listMcpServers(get(db$), auth.orgId);
  return { status: 200 as const, body: { servers: [...servers] } };
});

const createServerInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const permissionError = adminRequired(auth, "create");
    if (permissionError) {
      return permissionError;
    }

    const body = await get(bodyResultOf(zeroMcpServersContract.create));
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const result = await createMcpServer(set(writeDb$), {
      orgId: auth.orgId,
      input: body.data,
    });
    signal.throwIfAborted();

    if (result.status === "invalidEndpoint") {
      return badRequestMessage(result.message);
    }
    if (result.status === "conflict") {
      return conflict(`MCP server ref already exists: ${body.data.ref}`);
    }
    return { status: 201 as const, body: result.server };
  },
);

const patchServerInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const permissionError = adminRequired(auth, "update");
  if (permissionError) {
    return permissionError;
  }

  const params = get(pathParamsOf(zeroMcpServerByRefContract.patch));
  const body = await get(bodyResultOf(zeroMcpServerByRefContract.patch));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  const result = await updateMcpServer(set(writeDb$), {
    orgId: auth.orgId,
    ref: params.ref,
    input: body.data,
  });
  signal.throwIfAborted();

  return result.status === "notFound"
    ? notFound(`MCP server not found: ${params.ref}`)
    : { status: 200 as const, body: result.server };
});

const deleteServerInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const permissionError = adminRequired(auth, "delete");
    if (permissionError) {
      return permissionError;
    }

    const params = get(pathParamsOf(zeroMcpServerByRefContract.delete));
    const result = await deleteMcpServer(set(writeDb$), {
      orgId: auth.orgId,
      ref: params.ref,
    });
    signal.throwIfAborted();

    return result.status === "notFound"
      ? notFound(`MCP server not found: ${params.ref}`)
      : { status: 204 as const, body: undefined };
  },
);

const getAgentGrantsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroAgentMcpGrantsContract.get));
  const result = await readMcpAgentGrants(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
    agentId: params.id,
  });

  return result.status === "agentNotFound"
    ? agentNotFound(params.id)
    : { status: 200 as const, body: { grants: [...result.grants] } };
});

const replaceAgentGrantsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(zeroAgentMcpGrantsContract.replace));
    const body = await get(bodyResultOf(zeroAgentMcpGrantsContract.replace));
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const result = await replaceMcpAgentGrants(set(writeDb$), {
      orgId: auth.orgId,
      userId: auth.userId,
      agentId: params.id,
      grants: body.data.grants,
    });
    signal.throwIfAborted();

    if (result.status === "agentNotFound") {
      return agentNotFound(params.id);
    }
    if (result.status === "serversNotFound") {
      return badRequestMessage(
        `Unknown MCP server refs: ${result.missingRefs.join(", ")}`,
      );
    }
    return { status: 200 as const, body: { grants: [...result.grants] } };
  },
);

export const zeroMcpRoutes: readonly RouteEntry[] = [
  {
    route: zeroMcpServersContract.list,
    handler: authRoute(managementAuth, listServersInner$),
  },
  {
    route: zeroMcpServersContract.create,
    handler: authRoute(managementAuth, createServerInner$),
  },
  {
    route: zeroMcpServerByRefContract.patch,
    handler: authRoute(managementAuth, patchServerInner$),
  },
  {
    route: zeroMcpServerByRefContract.delete,
    handler: authRoute(managementAuth, deleteServerInner$),
  },
  {
    route: zeroAgentMcpGrantsContract.get,
    handler: authRoute(managementAuth, getAgentGrantsInner$),
  },
  {
    route: zeroAgentMcpGrantsContract.replace,
    handler: authRoute(managementAuth, replaceAgentGrantsInner$),
  },
];
